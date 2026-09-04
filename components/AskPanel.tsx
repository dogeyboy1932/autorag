'use client';

import { useState } from 'react';
import { coverageNote, search, type SearchResult } from '@/src/rag/search';
import { Button, Empty, Panel, Pill } from './ui';

interface ChatTurn {
  question: string;
  answer: string;
  result: SearchResult;
}

const SYSTEM = `You answer only from the reading-memory passages supplied in the user message.

- Cite every claim with the passage number in square brackets, such as [1] or [2].
- Answer directly and cover everything supported by the passages.
- If the passages do not answer the question, say exactly what they support and what is missing.
- Never fill gaps with outside knowledge.
- Do not cite conversation text as though it were a passage.`;

function passageText(result: SearchResult): string {
  if (result.hits.length === 0) return 'No passages were retrieved. Say that nothing in the memory covers this question.';
  return result.hits
    .map((hit, index) => `[${index + 1}] ${hit.source.title} (${hit.source.url})\n${hit.chunk.text}`)
    .join('\n\n');
}

export default function AskPanel() {
  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const prompt = question.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await search(prompt, { k: 6 });
      const evidence = passageText(result);
      let answer = result.hits.length
        ? 'The passages were retrieved, but the answer service did not return a response.'
        : "Nothing you've kept covers this question.";

      if (result.hits.length) {
        const response = await fetch('/.netlify/functions/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            system: SYSTEM,
            model: 'claude-haiku-4-5-20251001',
            messages: [{ role: 'user', content: `Question: ${prompt}\n\nPassages from memory:\n${evidence}` }],
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          content?: { type: string; text?: string }[];
        };
        if (!response.ok) throw new Error(body.error ?? `Answer request failed (${response.status}).`);
        answer = body.content?.find((part) => part.type === 'text')?.text?.trim() ?? answer;
      }

      setThread((previous) => [...previous, { question: prompt, answer, result }]);
      setQuestion('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const last = thread[thread.length - 1];
  return (
    <Panel title="Ask your memory" right={<Pill tone="mute">active session only</Pill>}>
      <div style={{ display: 'grid', gap: 12 }}>
        {thread.length === 0 ? (
          <Empty>Ask a question and get an answer grounded in the passages you kept.</Empty>
        ) : (
          thread.map((turn, index) => {
            const confidence = turn.result.hits.length ? turn.result.hits[0].score : 0;
            return (
              <article key={`${turn.question}-${index}`} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
                <p style={{ margin: 0, color: 'var(--accent-strong)', fontWeight: 700 }}>{turn.question}</p>
                <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{turn.answer}</p>
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                    {turn.result.hits.length} supporting passage{turn.result.hits.length === 1 ? '' : 's'}
                  </summary>
                  <p style={{ color: 'var(--muted)', fontSize: 12 }}>{coverageNote(turn.result.hits, turn.result.totalCandidates, confidence > 0.6 ? 'high' : 'medium', turn.result.unmatchedTerms, turn.question)}</p>
                  {turn.result.hits.map((hit, hitIndex) => (
                    <div key={hit.chunk.id} style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 10, marginTop: 10 }}>
                      <a href={hit.source.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{`[${hitIndex + 1}] ${hit.source.title}`}</a>
                      <p style={{ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.5 }}>{hit.chunk.text}</p>
                    </div>
                  ))}
                </details>
              </article>
            );
          })
        )}
        {error && <p style={{ color: 'var(--bad)', margin: 0, fontSize: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
            placeholder="Ask about something you kept..."
            style={{ flex: 1, minHeight: 44, resize: 'vertical', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 10px' }}
          />
          <Button tone="primary" disabled={busy || !question.trim()} onClick={() => void ask()}>
            {busy ? 'Thinking...' : 'Ask'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
