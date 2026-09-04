'use client';

import { useCallback, useState } from 'react';
import ActivityLog from '@/components/ActivityLog';
import AskPanel from '@/components/AskPanel';
import AskSettingsPanel, { useAskSettings } from '@/components/AskSettings';
import CorpusView from '@/components/CorpusView';
import AccountBar from '@/components/AccountBar';
import AttachProject from '@/components/AttachProject';
import Shell from '@/components/Shell';
import WebSessions, { WebSyncButton } from '@/components/WebSessions';
import GetExtension from '@/components/GetExtension';
import DeclarativeIngestForm from '@/components/DeclarativeIngestForm';
import IngestForm from '@/components/IngestForm';
import ReviewQueue from '@/components/ReviewQueue';
import StatsBar from '@/components/StatsBar';
import ToolRegistrar from '@/components/ToolRegistrar';
import WarmupBar from '@/components/WarmupBar';
import { chunksByStatus } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';

type Tab = 'ask' | 'library' | 'settings';

/**
 * Three tabs, split by what you are doing rather than by what the code does.
 *
 * This was ten panels in one column — capture, queue, search, ask, corpus,
 * sessions, project setup, activity and two demos, all stacked and all the same
 * weight. It read as a list of controls to work through rather than a place with a
 * few things you might want, and the two you actually use daily were four screens
 * apart.
 *
 * The split matches the extension's panel exactly, which is the point: they are two
 * doors into one product, and a person who learns one should already know the
 * other.
 *
 *   Ask       a question and its answer, with the passages underneath it
 *   Library   what comes in and what is kept: capture, the queue, the corpus
 *   Settings  the things you configure once, each collapsed and reporting its state
 *
 * All three panes stay mounted and the inactive ones are hidden. Unmounting is what
 * would make switching tabs wipe the Ask thread — the question, the streamed answer
 * and the whole conversation would go with the component.
 */
export default function Home() {
  return (
    <Shell>
      <App />
    </Shell>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>('ask');
  const [settings, saveSettings] = useAskSettings();

  const loadPending = useCallback(async () => (await chunksByStatus('pending')).length, []);
  const [pending] = useCorpusData(loadPending, 0);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'library', label: 'Library', badge: pending },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark">
          <span className="brand-symbol" aria-hidden="true">A</span>
          <div>
            <h1 className="brand-name">Autorag</h1>
            <p className="brand-kicker">Your reading memory</p>
          </div>
        </div>
        <div className="header-tools">
          <AccountBar />
          <WarmupBar />
          <ToolRegistrar />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <div className="tabs-inner">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'tab on' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge ? <span className="badge">{t.badge}</span> : null}
            </button>
          ))}
        </div>
      </nav>

      {/* Prose wants a narrower measure than a list of sources does. */}
      <div className={tab === "ask" ? "pane narrow chat-pane" : "pane narrow chat-pane off"}>
        <AskPanel settings={settings} />
      </div>

      <div className={tab === 'library' ? 'pane wide' : 'pane wide off'}>
        <IngestForm />
        <ReviewQueue />
        <CorpusView sync={<WebSyncButton />} />
      </div>

      <div className={tab === 'settings' ? 'pane wide' : 'pane wide off'}>
        <AskSettingsPanel settings={settings} save={saveSettings} />
        <WebSessions />
        <ActivityLog />
        <GetExtension />
        <DeclarativeIngestForm />
        {/*
          Last, and collapsed. Hosting a corpus of your own is the one thing here
          that needs a database you own — it is the rarest thing on this page and
          the longest, so it goes at the bottom rather than greeting everybody.
        */}
        <AttachProject />
      </div>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <StatsBar />
          <span className={settings.apiKey ? 'leaves' : ''}>
            {settings.apiKey
              ? 'Kept on this machine · only answers leave it'
              : 'Kept on this machine · nothing is uploaded'}
          </span>
        </div>
      </footer>
    </div>
  );
}
