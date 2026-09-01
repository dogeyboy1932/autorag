import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Autorag — agent-curated retrieval memory',
  description:
    'A browser-native, agent-curated retrieval memory. No server, no API key, no data leaving the device.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
