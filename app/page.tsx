'use client';

import ActivityLog from '@/components/ActivityLog';
import CorpusView from '@/components/CorpusView';
import DemoMode from '@/components/DemoMode';
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
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '40px 24px 80px' }}>
      <header style={{ marginBottom: 22 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.2 }}>Autorag</h1>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <ToolRegistrar />
            <WarmupBar />
          </div>
        </div>
        <p style={{ color: 'var(--muted)', margin: '6px 0 12px', fontSize: 13 }}>
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
        <DemoMode />
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
  );
}
