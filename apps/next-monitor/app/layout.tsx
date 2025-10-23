export const metadata = {
  title: 'Alpha Monitor',
  description: 'Trading monitor and strategy UI',
};

import './globals.css';
import Link from 'next/link';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid #eee', position: 'sticky', top: 0, background: '#fff', zIndex: 10
        }}>
          <Link href="/" style={{ fontWeight: 700, letterSpacing: 0.3 }}>Alpha Monitor</Link>
          <nav style={{ display: 'flex', gap: 16 }}>
            <Link href="/markets">Markets</Link>
          </nav>
        </header>
        <main style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>{children}</main>
      </body>
    </html>
  );
}

