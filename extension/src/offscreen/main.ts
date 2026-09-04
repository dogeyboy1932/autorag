/**
 * The only place the corpus exists.
 *
 * A service worker cannot host this: it has no DOM, WebGPU is unavailable to it,
 * and Chrome kills it after ~30s idle, which would evict a 25MB model on every
 * lull. An offscreen document is a real document that survives, so the embedding
 * pipeline warms once and stays warm while the browser is open.
 *
 * Everything here is the existing RAG core, unchanged. The extension is a new
 * way in, not a new engine.
 */

import { ingestPassage, dryRun } from '@/src/rag/ingest';
import { screenChunk } from '@/src/rag/screen';
import { search, confidenceOf, coverageNote } from '@/src/rag/search';
import {
  allChunks,
  allSources,
  countByStatus,
  decideChunks,
  deleteSourceCascade,
  annotateConflict,
  revisePendingChunk,
  getChunk,
  getSource,
  setSourceStale,
  wipeAll,
} from '@/src/rag/store';
import { warmup, warmupState, EMBEDDING_MODEL, EMBEDDING_DIM, isReady, embedOne } from '@/src/rag/embed';
import { env } from '@huggingface/transformers';
import { isEnvelope, type CloudSettings, type Event, type Request, type Response } from '../protocol';
import { askModel, standaloneQuery } from './answer';
import { refresh as refreshSession, signIn, signUp, syncNow } from '@/src/rag/sync';
import {
  directoryConfigured,
  signInAnonymously,
  inviteToSession,
  listSessions,
  publishProfile,
  publishSession,
  resolveSession,
  signInOrUp,
} from '@/src/rag/directory';
import { createLocalSession } from '@/src/rag/sessions';
import { emitCorpusChange, onCorpusChange } from '@/src/rag/bus';
import type { Conflict } from '@/src/types';

/*
 * A ring buffer of what this document has been doing.
 *
 * Chunking, embedding and screening all happen here, out of sight of every other
 * context — so from the panel a capture is a spinner and then, eventually, a card.
 * These lines are the only way to see that the work is progressing rather than
 * wedged, which matters most during the one-time model download.
 */
const events: Event[] = [];
function record(phase: Event['phase'], message: string) {
  events.unshift({ at: Date.now(), phase, message });
  events.length = Math.min(events.length, 50);
}
record('done', 'Autorag started');

/*
 * Point the ONNX runtime at the copy vendored next to this bundle.
 *
 * By default transformers.js dynamically imports its WASM backend from jsdelivr.
 * Extension pages run under `script-src 'self'`, which blocks that — and the
 * symptom lies to you: the 25MB of model weights download to 100%, then warmup
 * fails with `no available backend found`. Nothing here may depend on a CDN.
 *
 * Must be set before `warmup()`, which shares this module instance.
 */
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');

// Start the model as soon as the document exists, rather than on first use, so
// the first capture does not eat the download.
record('working', 'Loading the embedding model (25MB, once)');
void warmup().then(
  () => record('done', `Embedding model ready · ${warmupState().backend ?? 'cpu'}`),
  (err: unknown) => record('failed', `Model failed: ${err instanceof Error ? err.message : String(err)}`),
);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'this page';
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.kind) {
    case 'warmup': {
      const s = warmupState();
      return { ...s, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM, ready: isReady() };
    }

    case 'activity':
      return events;

    case 'ingest': {
      const words = request.text.trim().split(/\s+/).length;
      record('working', `Reading ${words} words from ${hostOf(request.sourceUrl)}`);
      /*
       * Kept into whichever session is active, read here rather than passed in by
       * the caller. Capture arrives from four places — the Keep button, the
       * context menu, a keyboard shortcut and an agent tool — and threading the
       * active session through all four would mean four chances for one of them to
       * keep into the wrong corpus. The offscreen document owns the corpus, so it
       * is the right place to know which part of it is open.
       */
      const active = (await cloudSettings())?.sessionId;
      const result = await ingestPassage({
        text: request.text,
        sourceUrl: request.sourceUrl,
        title: request.title,
        tags: request.tags,
        sessionId: active,
      });
      const n = result.conflicts.length;
      record(
        'done',
        `Staged ${result.chunkCount} passage${result.chunkCount > 1 ? 's' : ''} from ${hostOf(
          request.sourceUrl,
        )}${n ? ` · ${n} conflict${n > 1 ? 's' : ''} to review` : ''}`,
      );
      return {
        source_id: result.sourceId,
        staged_chunk_ids: result.stagedChunkIds,
        chunk_count: result.chunkCount,
        conflicts: result.conflicts,
      };
    }

    case 'dryRun':
      return dryRun({ text: request.text, sourceUrl: request.sourceUrl });

    case 'search': {
      const r = await search(request.query, {
        k: request.topK,
        includeStale: request.includeStale,
      });
      return {
        hits: r.hits,
        confidence: confidenceOf(r.hits, request.query, r.docs),
        unmatched_terms: r.unmatchedTerms,
      };
    }

    /*
     * Retrieve, then have a model write the answer. The one request that leaves
     * the device — and the reason Autorag no longer needs someone else's agent to
     * close its own loop.
     *
     * Retrieval is not reimplemented: it is the same `search()` the 'answer' case
     * below uses, so what the model is shown is exactly what the passage list
     * shows, and a person can check one against the other.
     */
    /*
     * Sync is the only request that can take minutes — a first upload of a full
     * corpus — so every stage lands in the activity feed. Silence during a long
     * upload is indistinguishable from a hang, which is the same reason the model
     * download reports a percentage.
     */
    case 'sync': {
      const { url, anonKey, accessToken, refreshToken, email, sessionId, host } = request.cloud;
      /*
       * A member of someone else's session has no project and no user of their own
       * in it. They reach it as the **anon** role, holding the publishable key the
       * session was shared with — which is exactly what a member is, so this is the
       * member path rather than a way around sign-in.
       *
       * Without this, joining was impossible for the people it was built for: the
       * check below demanded tokens that only a project owner can have, so a joiner
       * with no Supabase was told they were "not signed in to the cloud memory"
       * while being perfectly signed in to their account.
       */
      if (!host && (!accessToken || !refreshToken)) {
        throw new Error(
          'No corpus to sync. Attach your own Supabase project, or join a session to work in someone else\'s.',
        );
      }
      record('working', sessionId ? `Syncing session ${sessionId}` : 'Syncing memory');
      const result = await syncWithRenewal(
        host
          ? {
              url,
              anonKey,
              host,
              sessionId,
              email: email ?? '',
              accessToken: host.anonKey,
              refreshToken: '',
            }
          : { url, anonKey, accessToken, refreshToken, email, sessionId },
        (message) => record('working', message),
      );
      record(
        'done',
        `Synced — ${result.pulled} new from other devices, ${result.deleted} removed elsewhere`,
      );
      emitCorpusChange();
      return result;
    }

    case 'cloudSignIn': {
      const cfg = { url: request.cloud.url, anonKey: request.cloud.anonKey };
      const session = request.create
        ? await signUp(cfg, request.email, request.password)
        : await signIn(cfg, request.email, request.password);

      /*
       * Register with the directory in the same breath, and do not fail the
       * sign-in if it does not work.
       *
       * `credentials_for` reads `profiles`, so without a row there nobody can
       * resolve a session this person hosts — they would create one, hand out the
       * code, and watch it fail for everyone with no indication why. Publishing it
       * at sign-in is the only moment we are certainly holding their project's
       * credentials and their password at once.
       *
       * It is best-effort because the directory is a convenience and the corpus is
       * the product. A directory that is down, paused, or misconfigured must not
       * stop someone signing in to their own memory; it costs them sessions until
       * it recovers, and the panel says so rather than pretending.
       */
      let directory: { accessToken: string; refreshToken: string; userId: string } | undefined;
      let note = '';
      if (directoryConfigured()) {
        try {
          const dir = await signInOrUp(request.email, request.password);
          await publishProfile(dir, {
            userId: dir.userId,
            email: request.email,
            cloud: { url: cfg.url, anonKey: cfg.anonKey },
          });
          directory = {
            accessToken: dir.accessToken,
            refreshToken: dir.refreshToken,
            userId: dir.userId,
          };
        } catch (err) {
          note = ` (sessions unavailable: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      record('done', `Signed in to cloud memory as ${request.email}${note}`);
      return { ...session, directory, directoryError: note.trim() || undefined };
    }

    /*
     * Identity, with no Supabase project anywhere in it.
     *
     * This is the whole point of the split. Signing in used to demand a project
     * URL and key before it would authenticate anything, so somebody who only
     * wanted to join a session — which needs no project of their own — could not
     * get an account at all.
     *
     * No profile is published here. A profile says where a corpus lives, and
     * someone without a project has nothing to say; it is written by
     * `attachProject` instead.
     */
    case 'signIn':
    case 'signUp': {
      if (!directoryConfigured()) throw new Error('Accounts are unavailable: no directory is configured in this build.');
      const account = await signInOrUp(request.email, request.password);
      record('done', `Signed in as ${request.email}`);
      return {
        email: request.email,
        directory: {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          userId: account.userId,
        },
      };
    }

    case 'signInAnonymously': {
      if (!directoryConfigured()) throw new Error('Demo mode is unavailable: no directory is configured in this build.');
      const account = await signInAnonymously();
      record('done', 'Signed in for the demo');
      return {
        email: '',
        demo: true,
        directory: {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          userId: account.userId,
        },
      };
    }

    case 'signOut': {
      record('done', 'Signed out');
      return { ok: true };
    }

    /*
     * Hosting. Optional, and only for the person whose corpus it is.
     *
     * The profile is published here rather than at sign-in because this is the
     * first moment there is anything true to publish — without it, a session this
     * person hosts would resolve to nothing for everyone they gave the code to.
     */
    case 'attachProject': {
      const cfg = { url: request.url, anonKey: request.anonKey };
      /*
       * The project's login, which need not be the account's address. Falls back
       * to the account email, which is right for almost everybody.
       */
      const account = await storage.get<CloudSettings>('cloud');
      const email = request.email?.trim() || account?.email || '';
      if (!email) throw new Error('Sign in on the web app first — a project is attached to an account.');
      const project = request.create
        ? await signUp(cfg, email, request.password)
        : await signIn(cfg, email, request.password);

      const dir = account?.directory;
      if (dir) {
        /*
         * The profile records the *account* email, never the project login.
         * Invites are matched against the account address, so writing the other
         * one here would land an invitation somewhere the invitee never looks.
         */
        const accountEmail = account?.email || email;
        await publishProfile(
          { accessToken: dir.accessToken, refreshToken: dir.refreshToken, email: accountEmail, userId: dir.userId },
          { userId: dir.userId, email: accountEmail, cloud: cfg },
        );
      }
      record('done', `Attached ${new URL(cfg.url).host}`);
      return {
        url: cfg.url,
        anonKey: cfg.anonKey,
        accessToken: project.accessToken,
        refreshToken: project.refreshToken,
        userId: project.userId,
      };
    }

    case 'setAccount': {
      const current = (await storage.get<CloudSettings>('cloud')) ?? { url: '', anonKey: '' };
      const a = request.account;
      await storage.set({
        cloud: {
          ...current,
          email: a?.email ?? '',
          directory: a?.directory,
          demo: a?.demo,
          guest: a?.guest,
          sessionId: a?.sessionId,
          host: a?.host,
        },
      });
      record('done', a ? `Signed in as ${a.email || 'demo'}` : 'Signed out');
      return { ok: true };
    }

    case 'getAccount': {
      const c = await storage.get<CloudSettings>('cloud');
      /*
       * A guest counts. Returning null unless there was a directory session meant
       * choosing to work locally read as never having chosen at all, so the panel
       * stayed gated behind a question the person had just answered.
       */
      if (!c?.directory && !c?.guest) return null;
      return {
        email: c.email ?? '',
        demo: c.demo,
        guest: c.guest,
        directory: c.directory,
        sessionId: c.sessionId,
        host: c.host,
      };
    }

    case 'listSessions': {
      const dir = request.cloud.directory;
      if (!dir) throw new Error('Not signed in, so there are no sessions to list.');
      return await listSessions({
        accessToken: dir.accessToken,
        refreshToken: dir.refreshToken,
        email: request.cloud.email ?? '',
        userId: dir.userId,
      });
    }

    case 'createSession': {
      const dir = request.cloud.directory;
      if (!dir) throw new Error('Sign in first — a session needs an owner.');
      if (!request.cloud.url || !request.cloud.anonKey) {
        throw new Error('Connect your own Supabase project first; a session is stored in it.');
      }
      /*
       * Short and unambiguous. No 0/O or 1/I, because this gets read aloud and
       * typed by hand, and a code that cannot be dictated is not shareable.
       */
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = Array.from(
        crypto.getRandomValues(new Uint8Array(8)),
        (n) => alphabet[n % alphabet.length],
      ).join('');
      const dirSession = {
        accessToken: dir.accessToken,
        refreshToken: dir.refreshToken,
        email: request.cloud.email ?? '',
        userId: dir.userId,
      };
      /*
       * The corpus row first, and the order is the whole point.
       *
       * Two rows make a shared session. The one in the owner's own project is what
       * actually authorises anything — every policy there reads `shared` from it —
       * while the directory only records that a code exists and who owns it.
       *
       * Published first, a failure here left a joinable code pointing at a project
       * with no matching session: members resolved the code, reached the database,
       * matched no policy, and saw an empty corpus with nothing anywhere saying
       * why. The owner saw their own passages the whole time, because they match on
       * `user_id` instead, so nothing looked wrong from their side either.
       *
       * This way a failure leaves a session that is merely private, which is the
       * safe direction and is visible to the person who caused it.
       */
      await createLocalSession(
        { url: request.cloud.url, anonKey: request.cloud.anonKey },
        {
          accessToken: request.cloud.accessToken!,
          refreshToken: request.cloud.refreshToken!,
          email: request.cloud.email ?? '',
          userId: request.cloud.userId ?? '',
        },
        { id: code, name: request.name, shared: true },
      );
      await publishSession(dirSession, {
        code,
        name: request.name,
        openJoin: request.openJoin,
        ownerUserId: dir.userId,
      });
      record('done', `Created session ${request.name} (${code})`);
      return { code, name: request.name };
    }

    case 'joinSession': {
      const dir = request.cloud.directory;
      const code = request.code.trim().toUpperCase();
      const resolved = await resolveSession(
        code,
        dir
          ? {
              accessToken: dir.accessToken,
              refreshToken: dir.refreshToken,
              email: request.cloud.email ?? '',
              userId: dir.userId,
            }
          : undefined,
      );
      /*
       * One message for "no such code" and for "not yours to join", because
       * `credentials_for` deliberately does not distinguish them — telling them
       * apart would make this an oracle for which codes are real.
       */
      if (!resolved) {
        throw new Error(
          'No session with that code, or you have not been invited to it. Ask the owner to invite your email address.',
        );
      }
      record('done', `Joined session ${code}`);
      return { code, host: { url: resolved.projectUrl, anonKey: resolved.anonKey, name: code } };
    }

    case 'inviteToSession': {
      const dir = request.cloud.directory;
      if (!dir) throw new Error('Sign in first.');
      await inviteToSession(
        {
          accessToken: dir.accessToken,
          refreshToken: dir.refreshToken,
          email: request.cloud.email ?? '',
          userId: dir.userId,
        },
        request.code,
        request.email,
      );
      record('done', `Invited ${request.email} to ${request.code}`);
      return { ok: true };
    }

    case 'switchSession': {
      // Nothing to do here beyond acknowledging: the panel stores the new active
      // session and the sync that follows is what actually moves the corpus.
      record('done', `Switched to ${request.sessionId}`);
      return { sessionId: request.sessionId };
    }

    case 'ask': {
      record('working', `Asking about "${request.question.slice(0, 40)}"`);
      const history = request.history ?? [];
      /*
       * Retrieve on a query that can stand alone. On turn one that is the question
       * itself; on a follow-up it is the question with its pronouns resolved from
       * the transcript, because "what about the second one?" embeds to nothing.
       */
      const query = await standaloneQuery(request.question, history, request.settings);
      if (query !== request.question) record('working', `Searching for "${query.slice(0, 50)}"`);
      const r = await search(query, { k: 5 });
      const confidence = confidenceOf(r.hits, query, r.docs);
      const note = coverageNote(r.hits, r.totalCandidates, confidence, r.unmatchedTerms, query);
      const passages = r.hits.map((h) => ({
        text: h.chunk.text,
        url: h.source.url,
        title: h.source.title,
        captured: h.source.ingestedAt,
        // An image passage's source *is* the image, so the model can be shown the
        // thing itself rather than only what someone wrote about it.
        ...(h.source.tags?.includes('image') ? { imageUrl: h.source.url } : {}),
      }));

      let answer = '';
      let tokens = { input: 0, output: 0 };
      let imagesSent = 0;
      try {
        ({ imagesSent } = await askModel(
          request.question,
          passages,
          confidence,
          note,
          request.settings,
          (chunk) => {
            answer += chunk;
          },
          history,
          (u) => {
            tokens = { input: tokens.input + u.input, output: tokens.output + u.output };
          },
        ));
      } catch (err) {
        /*
         * Never let the key reach the activity feed. The message comes from the
         * provider and could in principle echo the request, so what is recorded is
         * the shape of the failure, not its text.
         */
        record('failed', 'The answering model could not be reached');
        throw err;
      }
      record('done', `Answered from ${passages.length} passage${passages.length === 1 ? '' : 's'}`);
      return {
        question: request.question,
        answer,
        hits: r.hits,
        confidence,
        coverage_note: note,
        tokens,
        // Reported so "the model did not read the picture" and "the model read it
        // and answered badly" stop looking identical from the panel.
        images_sent: imagesSent,
        ...(query !== request.question ? { searched_for: query } : {}),
      };
    }

    case 'answer': {
      record('working', `Searching for "${request.question.slice(0, 40)}"`);
      const r = await search(request.question, { k: 5 });
      record('done', `Found ${r.hits.length} passage${r.hits.length === 1 ? '' : 's'}`);
      const confidence = confidenceOf(r.hits, request.question, r.docs);
      return {
        question: request.question,
        hits: r.hits,
        confidence,
        // Signals, never a verdict — the caller decides whether this answers the
        // question. Same rule the page app follows (README, "Signals, not verdicts").
        coverage_note: coverageNote(
          r.hits,
          r.totalCandidates,
          confidence,
          r.unmatchedTerms,
          request.question,
        ),
      };
    }

    case 'stats': {
      const [counts, sources, chunks] = await Promise.all([
        countByStatus(),
        allSources(),
        allChunks(),
      ]);
      const w = warmupState();
      return {
        ...counts,
        chunk_count: chunks.length,
        source_count: sources.length,
        model_ready: isReady(),
        // Carried out to the caller because an offscreen document has no console
        // anyone can reach: puppeteer cannot attach to it, and a silent warmup
        // failure is indistinguishable from a slow download.
        model_phase: w.phase,
        model_progress: w.progress,
        model_error: w.error ?? null,
      };
    }

    case 'listPending': {
      const chunks = await allChunks();
      const sources = await allSources();
      const byId = new Map(sources.map((s) => [s.id, s]));
      const byChunk = new Map(chunks.map((c) => [c.id, c]));
      return chunks
        .filter((c) => c.status === 'pending')
        .map((c) => ({
          chunk_id: c.id,
          text: c.text,
          note: c.note ?? null,
          conflicts: c.conflicts.map((cf) => ({
            kind: cf.kind,
            detail: cf.detail,
            against_chunk_id: cf.againstChunkId ?? null,
            /*
             * The passage this one was flagged against, carried along rather than
             * merely named. Screening's `detail` reports which figures differ; only
             * the claims around those figures say whether that is a disagreement,
             * so an adjudicator that cannot read both passages cannot do the job it
             * is being asked to do.
             */
            against_text: cf.againstChunkId
              ? (byChunk.get(cf.againstChunkId)?.text.slice(0, 600) ?? null)
              : null,
            agent_verdict: cf.agentVerdict
              ? {
                  ruling: cf.agentVerdict.ruling,
                  reasoning: cf.agentVerdict.reasoning,
                  ruled_at: cf.agentVerdict.ruledAt,
                }
              : null,
          })),
          source: {
            url: byId.get(c.sourceId)?.url ?? '',
            title: byId.get(c.sourceId)?.title ?? '',
            tags: byId.get(c.sourceId)?.tags ?? [],
          },
        }));
    }

    /*
     * An agent ruling on a flagged pair. The verdict is *written onto the
     * conflict*, never onto the chunk's status: adjudication decides whether two
     * passages actually disagree, not whether either one is kept. The human still
     * approves or discards in the panel, now with a sentence to read instead of
     * two passages to compare.
     */
    case 'adjudicate': {
      const updated = await annotateConflict(request.chunkId, request.againstChunkId, {
        ruling: request.ruling,
        reasoning: request.reasoning,
        ruledAt: new Date().toISOString(),
      });
      if (!updated) throw new Error(`No staged passage with id ${request.chunkId}.`);

      const matched = updated.conflicts.some((c) => c.againstChunkId === request.againstChunkId);
      if (!matched) {
        throw new Error(
          `That passage has no recorded conflict against ${request.againstChunkId}. ` +
            `Known: ${updated.conflicts.map((c) => c.againstChunkId).join(', ') || 'none'}.`,
        );
      }

      record('done', `An agent ruled "${request.ruling.replace('_', ' ')}" on a flagged pair`);
      return {
        chunk_id: request.chunkId,
        ruling: request.ruling,
        message: 'Verdict recorded on the review queue. The human still decides whether to keep it.',
      };
    }

    /*
     * Editing a staged passage before deciding on it — a typo, a paragraph that
     * dragged in a cookie banner, or a note about why it is worth keeping.
     *
     * Changed text is re-embedded and re-screened, not merely stored. Writing new
     * text beside the old vector would produce a passage that reads one way and
     * retrieves another, which is the kind of failure nothing surfaces until a
     * search quietly stops working; and screening's verdict was about the text that
     * used to be there, so it has to be asked again.
     *
     * The note is deliberately not embedded. It is a person's annotation about the
     * passage, and folding it into the indexed text would let a remark about a
     * passage compete with the passage itself in search results.
     */
    case 'revisePending': {
      const before = await getChunk(request.chunkId);
      if (!before) throw new Error(`No staged passage with id ${request.chunkId}.`);
      if (before.status === 'rejected') {
        throw new Error('A discarded passage cannot be edited — its text is what future screening matches against.');
      }

      const text = request.text?.trim();
      if (text !== undefined && text.length < 50) {
        throw new Error(`A passage needs at least 50 characters; that one has ${text.length}.`);
      }

      let embedding: Float32Array | undefined;
      let conflicts: Conflict[] | undefined;
      if (text !== undefined && text !== before.text) {
        record('working', 'Re-reading an edited passage');
        embedding = await embedOne(text);
        const source = await getSource(before.sourceId);
        if (source) {
          const [chunks, sources] = await Promise.all([allChunks(), allSources()]);
          const byId = new Map(sources.map((x) => [x.id, x]));
          const candidates = chunks
            // Never screen a passage against itself; it would flag as a duplicate
            // of the very thing being edited.
            .filter((c) => c.id !== before.id)
            .map((chunk) => ({ chunk, source: byId.get(chunk.sourceId) }))
            .filter((c): c is { chunk: typeof before; source: NonNullable<typeof source> } =>
              Boolean(c.source),
            );
          conflicts = screenChunk({ text, embedding, source }, candidates);
        }
      }

      const updated = await revisePendingChunk(request.chunkId, {
        ...(text !== undefined ? { text, embedding } : {}),
        ...(request.note !== undefined ? { note: request.note } : {}),
        ...(conflicts !== undefined ? { conflicts } : {}),
      });
      if (!updated) throw new Error('That passage is no longer editable.');

      record(
        'done',
        text !== undefined && text !== before.text
          ? `Revised a staged passage · re-screened, ${updated.conflicts.length} flag(s)`
          : 'Saved a note on a staged passage',
      );
      return {
        chunk_id: updated.id,
        text: updated.text,
        note: updated.note ?? null,
        conflicts: updated.conflicts,
      };
    }

    case 'listSources': {
      const [sources, chunks] = await Promise.all([allSources(), allChunks()]);
      return sources
        /*
         * A page with nothing kept from it is not a source.
         *
         * Discarding every passage from a page used to leave the page itself in
         * this list, citing nothing — it looked like something had been kept and
         * offered no way to tell that nothing had. Its rejected chunks are still
         * on disk and must stay there, because their text is what future
         * screening matches against; they are simply not a reason to list the
         * page. Pending ones still count, so something awaiting review does not
         * vanish before it has been looked at.
         */
        .filter((s) =>
          chunks.some((c) => c.sourceId === s.id && c.status !== 'rejected'),
        )
        .map((s) => {
          const mine = chunks.filter((c) => c.sourceId === s.id);
          return {
            source_id: s.id,
            url: s.url,
            title: s.title,
            stale: s.stale,
            stale_reason: s.staleReason ?? null,
            ingested_at: s.ingestedAt,
            approved: mine.filter((c) => c.status === 'approved').length,
            pending: mine.filter((c) => c.status === 'pending').length,
            rejected: mine.filter((c) => c.status === 'rejected').length,
          };
        })
        /*
         * A page nothing survived from is not a source any more.
         *
         * Discarding every passage from a page used to leave it here citing
         * nothing — a row that looked like kept material and was the record of
         * material explicitly turned down. Still listed while anything is awaiting
         * review, because that is work in progress rather than a decision.
         */
        .filter((s) => s.approved > 0 || s.pending > 0)
        .sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));
    }

    case 'markStale': {
      const updated = await setSourceStale(
        request.sourceId,
        request.stale,
        request.reason ?? 'Marked out of date.',
      );
      record(
        'done',
        request.stale
          ? `Marked "${updated?.title ?? 'source'}" out of date — demoted, not deleted`
          : `Cleared the stale flag on "${updated?.title ?? 'source'}"`,
      );
      return { source_id: request.sourceId, stale: updated?.stale ?? false };
    }

    case 'forget': {
      const sources = await allSources();
      const title = sources.find((s) => s.id === request.sourceId)?.title ?? 'source';
      const removed = await deleteSourceCascade(request.sourceId);
      record('done', `Forgot "${title}" and ${removed} passage(s) — permanently`);
      return { forgotten: request.sourceId, chunks_removed: removed };
    }

    case 'wipe': {
      await wipeAll();
      record('done', 'Erased the entire corpus');
      return { wiped: true };
    }

    case 'approve': {
      const ids = await decideChunks(request.chunkIds, 'approved');
      record('done', `Kept ${ids.length} passage${ids.length > 1 ? 's' : ''} — now searchable`);
      return { approved: ids };
    }

    case 'reject': {
      const ids = await decideChunks(request.chunkIds, 'rejected', request.reason);
      record('done', `Discarded ${ids.length}, and remembered why`);
      return { rejected: ids };
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isEnvelope(message) || message.to !== 'offscreen') return;
  handle(message.request).then(
    (data) => sendResponse({ ok: true, data } satisfies Response),
    (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true; // keep the channel open for the async reply
});


/* ------------------------------------------------------------------------- */
/* Sync that happens on its own.                                               */
/* ------------------------------------------------------------------------- */

/*
 * A "Sync now" button was the whole of cloud sync for one build, and it was not
 * enough by a long way. Signing in did nothing until you pressed it, keeping
 * something did nothing until you pressed it, and the natural conclusion from
 * watching an empty `chunks` table was that sync was broken rather than that it
 * had never been asked to run.
 *
 * So every corpus change schedules a push. Debounced, because approving five
 * passages is five change events and one worthwhile upload; and errors are
 * recorded rather than swallowed, because a silent failure here looks exactly
 * like a memory that is safely backed up and is not.
 */
const SYNC_DEBOUNCE_MS = 2500;
/* Continuous activity would otherwise keep pushing the debounce back forever —
   approving a long queue one card at a time is exactly that shape. */
const SYNC_MAX_WAIT_MS = 15_000;
let firstPendingChange = 0;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;

/**
 * `chrome.storage` does not exist in an offscreen document — it gets
 * `chrome.runtime` and a short list of others, and nothing warns you. Reads and
 * writes here go through the service worker, which does have it. See the handler
 * in background.ts for what this cost before it was noticed.
 */
const storage = {
  async get<T>(key: string): Promise<T | undefined> {
    const v = (await chrome.runtime.sendMessage({ type: 'autorag:storage-get', key })) as
      | Record<string, T>
      | undefined;
    return v?.[key];
  },
  async set(patch: Record<string, unknown>): Promise<void> {
    await chrome.runtime.sendMessage({ type: 'autorag:storage-set', patch });
  },
};

async function cloudSettings() {
  /*
   * Typed as `CloudSettings` rather than re-describing the shape inline. There
   * were four hand-written copies of it, and adding `sessionId` to the protocol
   * silently failed to reach any of them — the sync ran in the private scope
   * while reporting that it had pushed rows to a shared session. One name means
   * a new field is a compile error at every call site instead of a no-op.
   */
  const c = await storage.get<CloudSettings>('cloud');
  if (!c?.url || !c.anonKey || !c.accessToken || !c.refreshToken) return null;
  return c;
}

/**
 * Runs a sync, renewing the session first if the old one has expired.
 *
 * A Supabase access token lasts about an hour. Nothing ever renewed it, so sync
 * worked for an hour and then failed forever with `JWT expired` — which reads
 * like a broken integration rather than a token that simply aged out, and left
 * the only apparent fix as signing in again by hand.
 *
 * The refresh token is long-lived, so one retry covers it. If the refresh itself
 * fails the session is genuinely gone and the error says so.
 */
async function syncWithRenewal(
  c: NonNullable<Awaited<ReturnType<typeof cloudSettings>>>,
  onProgress?: (m: string) => void,
) {
  /*
   * A joined session lives in its host's project, so the credentials that reach it
   * are theirs and not this person's. `host` is absent for your own sessions,
   * where your own project is the right target.
   */
  const cfg = {
    url: c.host?.url ?? c.url,
    anonKey: c.host?.anonKey ?? c.anonKey,
    ...(c.sessionId ? { sessionId: c.sessionId } : {}),
  };
  const session = {
    accessToken: c.accessToken!,
    refreshToken: c.refreshToken!,
    email: c.email ?? '',
    userId: c.userId ?? '',
  };
  try {
    return await syncNow(cfg, session, onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/jwt|expired|invalid token|401/i.test(message)) throw err;
    record('working', 'Session expired — renewing');
    const renewed = await refreshSession(cfg, session);
    await storage.set({
      cloud: { ...c, accessToken: renewed.accessToken, refreshToken: renewed.refreshToken },
    });
    return await syncNow(cfg, renewed, onProgress);
  }
}

async function autoSync() {
  if (syncing) return;
  const c = await cloudSettings();
  if (!c) return; // Local-only. Nothing to do and nothing to report.
  syncing = true;
  try {
    const result = await syncWithRenewal(c);
    // Written whether or not anything moved, so the panel can say when it last
    // succeeded. A sync that runs and reports nothing is indistinguishable from a
    // sync that never ran.
    await storage.set({ lastSyncAt: Date.now(), lastSyncError: '' });
    if (result.pulled || result.deleted) {
      record('done', `Synced — ${result.pulled} new, ${result.deleted} removed elsewhere`);
      emitCorpusChange();
    }
  } catch (err) {
    // Loud on purpose. The failure mode this replaces was a table that stayed
    // empty while everything looked fine.
    const message = err instanceof Error ? err.message : String(err);
    record('failed', `Cloud sync failed — ${message}`);
    await storage.set({ lastSyncError: message });
  } finally {
    syncing = false;
  }
}

function scheduleSync() {
  const now = Date.now();
  if (!firstPendingChange) firstPendingChange = now;
  if (now - firstPendingChange >= SYNC_MAX_WAIT_MS) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    firstPendingChange = 0;
    void autoSync();
    return;
  }
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    firstPendingChange = 0;
    void autoSync();
  }, SYNC_DEBOUNCE_MS);
}

onCorpusChange(scheduleSync);
// And once at startup, so a browser you have just signed into pulls what the
// others have kept without you asking.
void autoSync();

/* ------------------------------------------------------------------------- */
/* The bridge out: measured, and then removed on purpose.                      */
/* ------------------------------------------------------------------------- */

/*
 * This document briefly held a WebSocket to a local relay, so a desktop MCP client
 * could reach the corpus with no tab open. It worked — an extension page *can*
 * hold `ws://127.0.0.1`, negotiate `webmcp-discovery.v1` and complete the
 * handshake, which means the D16/D17 intersection never required the bridge tab
 * that was built around it (API-DELTA **D19-b**).
 *
 * It was removed anyway, for two reasons.
 *
 * The product one: supplying a coding agent with URLs and pasted text is easy, so
 * a desktop client reaching this memory was thin value against its cost. The
 * generative half now lives in the panel (`answer.ts`), which needs no relay, no
 * MCP client and no external agent at all.
 *
 * The operational one, which is the more interesting warning: **a relay process
 * can wedge**, holding its listening socket while accepting nothing. Port
 * discovery then queues a connection on every sweep and never gets one back — the
 * accept backlog on a dead relay was observed climbing past 25, and the stalled
 * offscreen document took the extension's capture path down with it. A background
 * connection attempt on a fixed schedule is not free when the thing it probes is
 * broken rather than absent.
 *
 * The seven WebMCP tools are untouched: they live on `document.modelContext` of
 * every page via `content/webmcp.ts`, and an agent driving the browser still finds
 * this memory wherever it is looking. Only the desktop path is gone.
 */
