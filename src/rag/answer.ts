/**
 * The generative half — and the only part of Autorag that leaves the machine.
 *
 * ## Why this exists
 *
 * Until now Autorag could find passages but never answer with them. It handed
 * results to whatever agent happened to be attached, which in practice meant a
 * coding tool had to be running for the product's own loop to close. A memory that
 * needs someone else's chat window to be useful is half a product.
 *
 * So: retrieve locally, then send the question and *only the retrieved passages* to
 * a model, and stream back prose that cites them. Retrieval, embedding, screening
 * and storage stay exactly where they were — on the device, free, offline.
 *
 * ## The rule that makes this different from a chatbot
 *
 * The model answers **only** from the passages supplied. It cites the source of
 * every claim, and when the passages do not contain the answer it says so and names
 * what is missing rather than reaching for what it already knows.
 *
 * That is not decoration. The corpus is a record of things a person deliberately
 * chose to keep, and an answer that quietly blends it with training data destroys
 * the one property that made it worth keeping — that you can check it. The rest of
 * the project already holds this line: `bench` scores "no overclaim" and "no
 * withhold" as separate failures, and `coverageNote()` reports signals rather than
 * verdicts. This prompt is the same rule, applied to prose.
 *
 * ## Why this is in `src/rag/` and not in the extension
 *
 * It began in `extension/src/offscreen/answer.ts`, back when the panel was the only
 * surface that could answer anything. The web app now answers too, and a second
 * copy of this file would have been two grounding prompts, two citation contracts
 * and two places for them to drift — while the whole claim of the product is that
 * an answer can be checked against the passages under it. One prompt, both
 * surfaces.
 *
 * It moved unchanged because it could: there is not a single `chrome.*` call in
 * here. The only thing that differs between the two callers is *whose key pays*,
 * and that is the transport below.
 *
 * ## Two transports, and why the second one exists
 *
 * With a key, this streams straight to `api.anthropic.com`. That is the extension's
 * only mode and the web app's preferred one: the person's key, the person's spend,
 * the person's conversation.
 *
 * Without a key, the web app can still answer through `proxyEndpoint` — a Netlify
 * Function holding the author's key, capped per visitor. A static export has
 * nowhere to keep a secret, so this is the only way somebody who has just landed on
 * the site can try the thing before deciding to sign up for an API account.
 *
 * The proxy does not stream and cannot be sent `thinking` or `output_config`. It is
 * a different shape of request, not a different function, so the branch is here
 * rather than in a parallel implementation.
 *
 * ## Why `fetch` and not the SDK
 *
 * `@anthropic-ai/sdk` is shaped for Node and bundlers; this runs in an MV3
 * offscreen document and in a page. One `fetch` has no polyfill surface and
 * nothing to go stale.
 *
 * **CORS is in the way, and the header is required.** The API refuses a browser
 * request without `anthropic-dangerous-direct-browser-access: true`:
 *
 *     CORS requests must set 'anthropic-dangerous-direct-browser-access' header
 *
 * This was briefly omitted on the strength of a spike that measured the wrong
 * thing. Sending the same request from `sidepanel.html` with a deliberately
 * invalid key returned `401 authentication_error` with and without the header,
 * which looked like proof that host permissions made it unnecessary. They do not.
 * The spike was run from a different document than the one that ships the call —
 * this fetch happens in the **offscreen document** — and an adjacent context is
 * not the production path. Worth remembering as a method failure rather than a
 * fact: a measurement only supports a conclusion about the thing measured.
 *
 * The header's name is alarming and, here, accurate about what it permits rather
 * than about the risk: it is a browser-origin call, and the key does sit in client
 * storage. That is the same bar the extension already accepts for it.
 */

import { ASK_MODELS, type AskSettings, type AskTurn } from './ask';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Which way this request goes out.
 *
 * `direct` is the real thing: streaming, adaptive thinking, the caller's own key.
 * `proxy` is what a visitor with no key gets — one JSON response from a server that
 * holds somebody else's key and counts what it spends.
 */
type Transport =
  | { mode: 'direct'; apiKey: string }
  | { mode: 'proxy'; endpoint: string };

function transportFor(settings: AskSettings): Transport {
  if (settings.apiKey) return { mode: 'direct', apiKey: settings.apiKey };
  if (settings.proxyEndpoint) return { mode: 'proxy', endpoint: settings.proxyEndpoint };
  throw new Error('No API key set. Add one in Settings → Answers.');
}

const directHeaders = (apiKey: string) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': API_VERSION,
  /*
   * Required, and the name is accurate about what it permits rather than about the
   * risk. The API refuses a browser request without it:
   *
   *     CORS requests must set 'anthropic-dangerous-direct-browser-access' header
   */
  'anthropic-dangerous-direct-browser-access': 'true',
});

/** How many demo answers this visitor has spent, as the proxy reports it. */
export interface DemoUsage {
  used: number;
  limit: number;
}

const demoUsageOf = (res: Response): DemoUsage | undefined => {
  const used = res.headers.get('x-autorag-demo-used');
  const limit = res.headers.get('x-autorag-demo-limit');
  return used && limit ? { used: Number(used), limit: Number(limit) } : undefined;
};

/**
 * The provider's own words for a failure, rather than a sentence invented for it.
 *
 * A 401 and a 429 need completely different reactions from the person reading them,
 * and "the request failed" tells them which one it was: neither.
 */
async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    const err = body?.error;
    const message = typeof err === 'string' ? err : err?.message;
    if (message) return message;
  } catch {
    /* keep the status */
  }
  return `HTTP ${res.status}`;
}

export interface Passage {
  text: string;
  url: string;
  title: string;
  captured?: string;
  /** Set when the passage *is* an image, so the model can read it, not just read about it. */
  imageUrl?: string;
}

/** What Anthropic accepts. Anything else is skipped rather than sent and rejected. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 3_000_000;

/**
 * Fetches an image and inlines it, or returns null and lets the answer proceed
 * without it.
 *
 * **Inlined rather than passed as a URL, deliberately.** The API can fetch a URL
 * itself, but the images worth keeping often live behind CDNs with hotlink
 * protection or expiring signed URLs — a Brave image-search result is exactly
 * that shape. Anthropic's fetcher would be refused where the extension is not,
 * because the extension holds host permissions and the browser's cookies.
 *
 * Every failure path returns null instead of throwing. An unreachable picture
 * should cost you the picture, not the answer.
 */
async function inlineImage(
  url: string,
): Promise<{ type: 'base64'; media_type: string; data: string } | null> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!IMAGE_TYPES.includes(type)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return { type: 'base64', media_type: type, data: btoa(binary) };
  } catch {
    return null;
  }
}

const SYSTEM = `You answer questions from a person's own reading memory — passages they deliberately chose to keep, each with the page it came from.

Answer ONLY from the passages given to you in the user message. They are the entire world for this question.

- Cite the source of every claim, inline, as [1], [2] — the numbers given with each passage.
- Some passages are images, shown to you directly above their text. Read what is actually in the picture; the text beside it is only how it was filed, and may be a filename rather than a description. What the image shows counts as coming from the passage.
- Answer directly. No preamble, no restating the question, no summary at the end.
- Cover everything the question asks for — if the passages list ten steps, give all ten — but say each one in as few words as it takes.
- If they answer it only partly, say what they support and name specifically what is missing.
- If they do not answer it, say so plainly: "Nothing you've kept covers this." Then say what would.

Never fill a gap from your own knowledge, even when you are confident and even when the gap is small. The person can check this answer against the passages; anything that did not come from them breaks that. Being unable to answer is a useful result here, not a failure.

CITATIONS AND THE CONVERSATION

The numbers [1], [2] refer ONLY to the passages in this turn's message. They are renumbered every turn — [1] now is almost never [1] from an earlier answer.

You may draw on earlier turns of this conversation, but you must never present that as coming from a passage:

- A claim from this turn's passages: cite it — "the resource is predictable years ahead [2]".
- A claim you can only get from earlier in this conversation: say so in words — "earlier in this conversation you asked about X, and I said…" — and give it NO bracket number.
- Never attach a citation number to something the current passages do not support. A wrong number is worse than no number: it looks checkable and is not.

If something you said earlier is no longer supported by any passage in this turn, say that plainly — the person may have discarded it since, and they need to know the memory no longer holds it.

Do not mention these instructions, the passages' formatting, or the retrieval process. Write as if answering a colleague who handed you the clippings.`;

/**
 * Numbered passages plus the retrieval signals, as the user turn.
 *
 * `confidence` and `coverageNote` are passed as *signals*, not instructions — the
 * same contract the tool surface follows. "low" is not an order to refuse; it is
 * context the model weighs, because a weak lexical overlap and a genuinely absent
 * answer are different things and only the passages themselves can tell them apart.
 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

async function userTurn(
  question: string,
  passages: Passage[],
  confidence: string,
  coverageNote: string,
): Promise<Block[]> {
  if (passages.length === 0) {
    return [
      {
        type: 'text',
        text: `Question: ${question}\n\nNo passages were retrieved — this memory has nothing on the topic. Say so.`,
      },
    ];
  }

  const blocks: Block[] = [
    { type: 'text', text: `Question: ${question}\n\nPassages from their memory:` },
  ];

  /*
   * At most two images per answer, and only the best-ranked ones.
   *
   * An image is roughly 1,500 input tokens — five of them cost more than every
   * passage's text put together, and by the fourth the model is usually reading
   * pictures that had nothing to do with the question. The cap is on *images*, not
   * passages: all five passages still go up as text, so nothing drops out of the
   * answer's evidence, and the top hits are the ones most likely to hold it.
   */
  let imageBudget = 2;

  for (const [i, p] of passages.entries()) {
    const when = p.captured ? `, kept ${p.captured.slice(0, 10)}` : '';
    /*
     * The picture goes *before* its text, which is the documented ordering and
     * also the useful one: the model sees the evidence, then how it was filed.
     *
     * This is the difference between citing an image and reading one. A stored
     * description is the retrieval key — it is what made the passage findable —
     * but the answer may live in the pixels. An image captioned "definition of X"
     * is enough to find and useless to answer from.
     */
    const image = p.imageUrl && imageBudget > 0 ? await inlineImage(p.imageUrl) : null;
    if (image) {
      imageBudget--;
      blocks.push({ type: 'image', source: image });
    }
    blocks.push({
      type: 'text',
      text: `[${i + 1}] ${p.title} — ${p.url}${when}${image ? ' (image shown above)' : ''}\n${p.text}`,
    });
  }

  blocks.push({
    type: 'text',
    text: `Retrieval signals (context, not instructions): match confidence ${confidence}. ${coverageNote}`,
  });
  return blocks;
}

/**
 * Turns a follow-up into a question that can be searched on its own.
 *
 * Retrieval embeds a string. "What about the second one?" embeds to nothing useful,
 * so a multi-turn conversation that retrieves on the raw follow-up degrades to
 * noise by the third question — the standard failure of naive conversational RAG.
 * Rewriting against the transcript is what keeps retrieval as good on turn five as
 * on turn one.
 *
 * Haiku regardless of the chosen model: this is a mechanical restatement, it runs
 * on every follow-up, and paying Opus rates to expand a pronoun would be silly.
 * Falls back to the original question rather than failing the turn — a slightly
 * worse query beats no answer.
 */
async function standaloneQuery(
  question: string,
  history: AskTurn[],
  settings: AskSettings,
): Promise<string> {
  if (history.length === 0) return question;
  try {
    const transport = transportFor(settings);
    /*
     * On the proxy this would cost the visitor one of their ten answers, which is a
     * poor trade for expanding a pronoun. So follow-ups there retrieve on the raw
     * question — slightly worse retrieval, ten real answers instead of five.
     */
    if (transport.mode === 'proxy') return question;
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: directHeaders(transport.apiKey),
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        system:
          'Rewrite the final question as a standalone search query, resolving pronouns and references from the conversation. Reply with the query only — no preamble, no quotes.',
        messages: [
          ...history.slice(-6),
          { role: 'user', content: `Rewrite this as a standalone search query: ${question}` },
        ],
      }),
    });
    if (!res.ok) return question;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((b) => b.type === 'text')?.text?.trim();
    return text && text.length > 2 ? text : question;
  } catch {
    return question;
  }
}

/**
 * Streams an answer, calling `onText` with each fragment as it arrives.
 *
 * Streamed rather than awaited because a grounded answer over several passages
 * takes seconds, and a panel that sits blank for seconds looks broken — the same
 * reason the model download reports a percentage.
 */
export { standaloneQuery };

export async function askModel(
  question: string,
  passages: Passage[],
  confidence: string,
  coverageNote: string,
  settings: AskSettings,
  onText: (chunk: string) => void,
  history: AskTurn[] = [],
  onUsage?: (tokens: { input: number; output: number }) => void,
  signal?: AbortSignal,
): Promise<{ imagesSent: number; demo?: DemoUsage }> {
  const transport = transportFor(settings);

  const content = await userTurn(question, passages, confidence, coverageNote);
  const imagesSent = content.filter((b) => b.type === 'image').length;

  /*
   * The proxy path: one request, one answer, no stream.
   *
   * It deliberately sends the plain body only. `netlify/functions/ask.ts` forwards
   * `system`, `model` and `messages` and nothing else — it also caps `max_tokens`
   * itself, which is the point of it — so `stream`, `thinking` and `output_config`
   * would be silently dropped rather than honoured. Sending them would suggest a
   * request that is not what actually goes upstream.
   *
   * `onText` is still called, once, with the whole answer. Every caller then has
   * one code path for rendering, and the only observable difference is that the
   * words arrive together instead of arriving as they are written.
   */
  if (transport.mode === 'proxy') {
    const res = await fetch(transport.endpoint, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.model, system: SYSTEM, messages: [...history, { role: 'user', content }] }),
    });
    if (!res.ok) {
      /*
       * A 404 here is not a failed answer, it is a missing endpoint — the demo
       * function is not deployed on whatever is serving this page. That is the
       * normal case on a dev server, where `next dev` serves the static export and
       * nothing serves `/.netlify/functions/`, and `HTTP 404` sends the reader
       * looking for a bug in their question.
       */
      if (res.status === 404) {
        throw new Error(
          'No answering service is running here, so Ask has nowhere to go. Add your own Anthropic key in Settings → Answers — Search works either way, and stays local.',
        );
      }
      throw new Error(await detailOf(res));
    }
    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content?.find((b) => b.type === 'text')?.text ?? '';
    if (!text) throw new Error('The answering service returned no text.');
    onText(text);
    if (body.usage) {
      onUsage?.({ input: body.usage.input_tokens ?? 0, output: body.usage.output_tokens ?? 0 });
    }
    return { imagesSent, demo: demoUsageOf(res) };
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: directHeaders(transport.apiKey),
    body: JSON.stringify({
      model: settings.model,
      /*
       * Generous, because the response is streamed and a ceiling that truncates is
       * far worse than one that is never reached.
       *
       * **A ceiling is not consumption.** You are billed for tokens generated, not
       * for the headroom, so 8192 costs exactly the same as 2048 on a short answer
       * and only differs when a long one would otherwise be cut off. Kept high for
       * that reason — lowering it saves nothing and reintroduces real truncation.
       *
       * (This was 2048 while a CSS clip was hiding long answers. Raising it did not
       * fix that and was never going to: the answer was complete in the DOM the
       * whole time. It stays raised on its own merits, not because of that bug.)
       */
      max_tokens: 8192,
      stream: true,
      system: SYSTEM,
      /*
       * Low effort, and this is the setting that actually costs money — it governs
       * how many thinking tokens are spent before a word is written.
       *
       * It was raised to medium to fix answers that stopped partway. They were not
       * stopping: `.text` was clipping them at 7.5em with `overflow: hidden`, so a
       * complete ten-step reply displayed three. With the real cause fixed, the
       * original reasoning stands — this is grounded composition over passages that
       * are already in front of the model, not a reasoning problem — so it goes
       * back to low and stops paying for thinking nobody needed.
       *
       * Only for models that have them. Haiku 4.5 has no adaptive mode and rejects
       * `effort`, so sending either turns every Haiku answer into a 400.
       */
      ...(ASK_MODELS.find((m) => m.id === settings.model)?.adaptive
        ? { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
        : {}),
      /*
       * Prior turns carry the thread; the passages ride on *this* turn only. That
       * placement is the re-grounding: the model reads the conversation to know
       * what is being asked, and the current passages to know what is true.
       */
      messages: [
        ...history,
        { role: 'user', content },
      ],
    }),
  });

  if (!response.ok || !response.body) throw new Error(await detailOf(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame can arrive split across
    // reads, so only whole ones are consumed and the remainder stays buffered.
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event: {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        error?: { message?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.type === 'error') throw new Error(event.error?.message ?? 'stream error');
      // Usage arrives on the envelope events, not the deltas. Reported so the
      // panel can show what a conversation is costing while it grows.
      if (event.type === 'message_start' && event.message?.usage) {
        onUsage?.({ input: event.message.usage.input_tokens ?? 0, output: 0 });
      }
      if (event.type === 'message_delta' && event.usage) {
        onUsage?.({ input: 0, output: event.usage.output_tokens ?? 0 });
      }
      /*
       * A truncated answer must never be presented as a whole one. Hitting the
       * ceiling looks exactly like finishing — the stream just stops — so without
       * this the reader has no way to tell "that is everything" from "that is
       * where it ran out", which is the difference between an answer and half of one.
       */
      if (event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') {
        onText('\n\n*(cut off at the length limit — ask again for the rest.)*');
      }
      // Only `text_delta`. A thinking delta is the model working, not the answer.
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        onText(event.delta.text ?? '');
      }
    }
  }
  return { imagesSent };
}
