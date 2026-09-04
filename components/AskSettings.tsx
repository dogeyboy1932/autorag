'use client';

import { useEffect, useState } from 'react';
import { ASK_MODELS, DEFAULT_ASK_MODEL, type AskSettings } from '@/src/rag/ask';
import { Button, Field, Fold } from './ui';

const KEY = 'autorag.ask';

/** Where the demo's key lives. A static export has nowhere else to keep a secret. */
export const PROXY_ENDPOINT = '/.netlify/functions/ask';

/**
 * The answering settings, read once and written through.
 *
 * `proxyEndpoint` is not stored — it is a property of this build, not a choice
 * somebody made, and persisting it would mean a stale copy surviving a redeploy.
 */
export function useAskSettings(): [AskSettings, (next: AskSettings) => void, boolean] {
  const [settings, setSettings] = useState<AskSettings>({
    apiKey: '',
    model: DEFAULT_ASK_MODEL,
    proxyEndpoint: PROXY_ENDPOINT,
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<AskSettings>;
        setSettings({
          apiKey: saved.apiKey ?? '',
          model: saved.model ?? DEFAULT_ASK_MODEL,
          proxyEndpoint: PROXY_ENDPOINT,
        });
      }
    } catch {
      /* unreadable means no key, which is the safe default */
    }
    setReady(true);
  }, []);

  const save = (next: AskSettings) => {
    setSettings({ ...next, proxyEndpoint: PROXY_ENDPOINT });
    try {
      localStorage.setItem(KEY, JSON.stringify({ apiKey: next.apiKey, model: next.model }));
    } catch {
      /* private mode: works for this tab, does not survive a reload */
    }
  };

  return [settings, save, ready];
}

/**
 * The one place this app spends money, and the one place anything leaves the
 * device — so both facts are stated here rather than in a README nobody opens.
 *
 * ## Why it collapses itself
 *
 * Once a key is saved there is nothing left to do here, and an open panel of
 * settings you have already answered is just noise above the things you have not.
 * It reports its state in the summary — `Opus 5`, or `demo` — so shutting it does
 * not hide the answer.
 */
export default function AskSettingsPanel({
  settings,
  save,
}: {
  settings: AskSettings;
  save: (next: AskSettings) => void;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(!settings.apiKey);
  const model = ASK_MODELS.find((m) => m.id === settings.model) ?? ASK_MODELS[0];

  useEffect(() => {
    if (settings.apiKey) setOpen(false);
  }, [settings.apiKey]);

  return (
    <Fold
      title="Answers"
      status={settings.apiKey ? model.label : 'demo · 10 free'}
      open={open}
      onToggle={setOpen}
    >
      <p className="note">
        Search is local and always free — nothing leaves this machine. <strong>Ask</strong> sends
        your question and the passages it retrieved to Anthropic so a model can write an answer
        from them. Capture, review, indexing and search stay local either way.
      </p>

      <p className="note">
        {settings.apiKey
          ? 'Using your own key: your spend, your conversation, no cap.'
          : 'Without a key you get ten answers on the author’s, so you can try it before signing up for anything. Add your own key below to lift the cap.'}
      </p>

      <div className="row">
        <Field
          type="password"
          placeholder={settings.apiKey ? 'Key saved — type to replace' : 'Anthropic API key (optional)'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          disabled={!draft.trim()}
          onClick={() => {
            save({ ...settings, apiKey: draft.trim() });
            setDraft('');
          }}
        >
          Save
        </Button>
        {settings.apiKey && (
          <Button tone="danger" onClick={() => save({ ...settings, apiKey: '' })}>
            Remove
          </Button>
        )}
      </div>

      <div className="row">
        {ASK_MODELS.map((m) => (
          <Button
            key={m.id}
            small
            tone={m.id === settings.model ? 'primary' : 'default'}
            onClick={() => save({ ...settings, model: m.id })}
          >
            {m.label}
          </Button>
        ))}
      </div>

      <p className="note">
        {model.label}: ${model.input}/M in, ${model.output}/M out. An answer over five passages
        runs a few thousand tokens — well under a cent. Nothing calls the model unless you ask.
      </p>
    </Fold>
  );
}
