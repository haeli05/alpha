import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'Alpha Monitor',
  description: 'Professional trading monitor and strategy UI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* Header */}
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 100,
            background: 'linear-gradient(180deg, var(--bg-primary) 0%, rgba(8, 8, 12, 0.95) 100%)',
            backdropFilter: 'blur(12px)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              maxWidth: 1400,
              margin: '0 auto',
              padding: '0 24px',
              height: 64,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            {/* Logo */}
            <Link
              href="/"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                textDecoration: 'none',
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  background: 'linear-gradient(135deg, var(--accent) 0%, var(--green) 100%)',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  fontSize: 14,
                  color: 'var(--bg-primary)',
                }}
              >
                A
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  fontSize: 16,
                  letterSpacing: '-0.5px',
                  color: 'var(--text-primary)',
                }}
              >
                ALPHA
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 8px',
                  background: 'var(--accent-bg)',
                  border: '1px solid var(--accent-border)',
                  borderRadius: 100,
                  color: 'var(--accent)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Monitor
              </span>
            </Link>

            {/* Navigation */}
            <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <NavLink href="/markets">CEX Markets</NavLink>
              <NavLink href="/polymarket">Polymarket</NavLink>
            </nav>

            {/* Status */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                background: 'var(--green-bg)',
                border: '1px solid var(--green-border)',
                borderRadius: 100,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  background: 'var(--green)',
                  borderRadius: '50%',
                  boxShadow: '0 0 8px var(--green)',
                  animation: 'pulse 2s ease-in-out infinite',
                }}
              />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--green)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Live
              </span>
            </div>
          </div>
        </header>

        {/* Main */}
        <main
          style={{
            maxWidth: 1400,
            margin: '0 auto',
            padding: '32px 24px',
            minHeight: 'calc(100vh - 64px - 80px)',
          }}
        >
          {children}
        </main>

        {/* Footer */}
        <footer
          style={{
            borderTop: '1px solid var(--border)',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
              letterSpacing: '0.5px',
            }}
          >
            ALPHA MONITOR &copy; 2024 &middot; REAL-TIME TRADING INTELLIGENCE
          </p>
        </footer>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="nav-link">
      {children}
    </Link>
  );
}
