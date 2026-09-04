'use client';

import ActivityLog from '@/components/ActivityLog';
import CorpusView from '@/components/CorpusView';
import AccountBar from '@/components/AccountBar';
import AttachProject from '@/components/AttachProject';
import Shell from '@/components/Shell';
import WebSessions from '@/components/WebSessions';
import GetExtension from '@/components/GetExtension';
import DeclarativeIngestForm from '@/components/DeclarativeIngestForm';
import IngestForm from '@/components/IngestForm';
import ReviewQueue from '@/components/ReviewQueue';
import SearchPanel from '@/components/SearchPanel';
import StatsBar from '@/components/StatsBar';
import ToolRegistrar from '@/components/ToolRegistrar';
import WarmupBar from '@/components/WarmupBar';

export default function Home() {
  return (
    <Shell>
    <main className="app-main">
      <header className="app-header">
        <div className="brand-row">
          <div>
            <div className="brand-mark">
              <span className="brand-symbol" aria-hidden="true">A</span>
              <div>
                <h1 className="brand-name">Autorag</h1>
                <p className="brand-kicker">Your reading memory</p>
              </div>
            </div>
          </div>
          <div className="header-tools">
            <AccountBar />
            <ToolRegistrar />
            <WarmupBar />
          </div>
        </div>
        <p className="header-copy">
          A browser-native, agent-curated retrieval memory. An agent browses and deposits what
          it finds; you decide what the memory keeps. No server, no API key, nothing leaves this
          device.
        </p>
        <StatsBar />
      </header>

      <div style={{ display: 'grid', gap: 16 }}>
        {/* First, because until today the zip was served and nothing linked to it:
            someone landing here had no route to the half of the product that runs
            on the pages they actually read. */}
        <WebSessions />
        <AttachProject />
        <GetExtension />
        <IngestForm />
        <ReviewQueue />
        <SearchPanel />
        <CorpusView />
        <ActivityLog />
        <DeclarativeIngestForm />
      </div>

      <footer style={{ marginTop: 28, color: 'var(--muted)', fontSize: 12 }}>
        Embeddings run locally via transformers.js (all-MiniLM-L6-v2, 384-dim). The index lives
        in IndexedDB and survives reloads and restarts. Tools are exposed through WebMCP on{' '}
        <code>document.modelContext</code>.
      </footer>
    </main>
    </Shell>
  );
}
