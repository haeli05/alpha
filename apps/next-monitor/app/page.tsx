import Link from 'next/link';

export default function Home() {
  return (
    <div style={{ display: 'grid', gap: 48 }}>
      {/* Hero */}
      <section
        style={{
          display: 'grid',
          gap: 24,
          padding: '48px 0',
          textAlign: 'center',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <div
            style={{
              width: 80,
              height: 80,
              background: 'linear-gradient(135deg, var(--accent) 0%, var(--green) 100%)',
              borderRadius: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              fontSize: 32,
              color: 'var(--bg-primary)',
              boxShadow: '0 0 60px rgba(0, 212, 255, 0.3)',
            }}
          >
            A
          </div>
        </div>

        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 48,
            fontWeight: 700,
            letterSpacing: '-2px',
            background: 'linear-gradient(135deg, var(--text-primary) 0%, var(--text-secondary) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          ALPHA MONITOR
        </h1>

        <p
          style={{
            margin: '0 auto',
            maxWidth: 500,
            fontSize: 16,
            lineHeight: 1.6,
            color: 'var(--text-secondary)',
          }}
        >
          Real-time trading intelligence for crypto markets and prediction platforms.
          Monitor, analyze, and execute with precision.
        </p>
      </section>

      {/* Markets Grid */}
      <section style={{ display: 'grid', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--text-tertiary)',
            }}
          >
            Select Market
          </h2>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 20,
          }}
        >
          <Link href="/markets" className="market-card">
            <div
              style={{
                position: 'absolute',
                top: -100,
                right: -100,
                width: 200,
                height: 200,
                background: 'radial-gradient(circle, rgba(0, 212, 255, 0.15) 0%, transparent 70%)',
                pointerEvents: 'none',
              }}
            />
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: 'var(--accent-bg)',
                  border: '1px solid var(--accent-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 24,
                  marginBottom: 20,
                }}
              >
                ₿
              </div>
              <h3
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  marginBottom: 8,
                }}
              >
                CEX Markets
              </h3>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: 'var(--text-secondary)',
                  marginBottom: 20,
                }}
              >
                Live Binance spot markets with technical indicators, charts, and paper trading.
              </p>
              <div style={{ display: 'flex', gap: 24 }}>
                <StatItem label="Exchange" value="Binance" color="var(--accent)" />
                <StatItem label="Timeframe" value="15m" color="var(--accent)" />
              </div>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 20,
                  color: 'var(--text-tertiary)',
                }}
              >
                →
              </div>
            </div>
          </Link>

          <Link href="/polymarket" className="market-card green">
            <div
              style={{
                position: 'absolute',
                top: -100,
                right: -100,
                width: 200,
                height: 200,
                background: 'radial-gradient(circle, rgba(0, 255, 136, 0.15) 0%, transparent 70%)',
                pointerEvents: 'none',
              }}
            />
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: 'var(--green-bg)',
                  border: '1px solid var(--green-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 24,
                  marginBottom: 20,
                }}
              >
                ◈
              </div>
              <h3
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  marginBottom: 8,
                }}
              >
                Polymarket
              </h3>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: 'var(--text-secondary)',
                  marginBottom: 20,
                }}
              >
                Prediction markets for real-world events. Trade YES/NO outcomes with hedging strategies.
              </p>
              <div style={{ display: 'flex', gap: 24 }}>
                <StatItem label="Type" value="Predictions" color="var(--green)" />
                <StatItem label="Chain" value="Polygon" color="var(--green)" />
              </div>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 20,
                  color: 'var(--text-tertiary)',
                }}
              >
                →
              </div>
            </div>
          </Link>
        </div>
      </section>

      {/* Bot Setup */}
      <section style={{ display: 'grid', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--text-tertiary)',
            }}
          >
            Bot Setup
          </h2>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 24,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 18,
              }}
            >
              ⚙
            </div>
            <div>
              <h3
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                Connect Your API
              </h3>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-tertiary)' }}>
                Enable automated trading with your Polymarket account
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            <SetupStep
              step={1}
              title="Get Your API Keys"
              description="Go to polymarket.com → Settings → API Keys → Create New Key"
              code="POLYMARKET_API_KEY=pm_xxx..."
            />
            <SetupStep
              step={2}
              title="Export Private Key"
              description="Export your wallet private key from MetaMask or your preferred wallet"
              code="POLYMARKET_PRIVATE_KEY=0x..."
            />
            <SetupStep
              step={3}
              title="Configure Environment"
              description="Create a .env.local file in the project root with your credentials"
              code={`# .env.local
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_api_secret
POLYMARKET_PASSPHRASE=your_passphrase
POLYMARKET_PRIVATE_KEY=0x_your_wallet_private_key`}
            />
            <SetupStep
              step={4}
              title="Fund Your Account"
              description="Deposit USDC to your Polymarket wallet on Polygon network"
              code="Chain: Polygon (MATIC) | Token: USDC"
            />
          </div>

          <div
            style={{
              marginTop: 20,
              padding: 16,
              background: 'var(--red-bg)',
              border: '1px solid var(--red-border)',
              borderRadius: 8,
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--red)',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              ⚠ Security Warning
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Never commit API keys or private keys to git. Add <code style={{ color: 'var(--accent)', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>.env.local</code> to your <code style={{ color: 'var(--accent)', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>.gitignore</code> file.
              Use a dedicated wallet with limited funds for bot trading.
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section style={{ display: 'grid', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--text-tertiary)',
            }}
          >
            Features
          </h2>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 16,
          }}
        >
          <FeatureCard icon="◉" title="Live Data" description="Real-time price feeds via WebSocket" />
          <FeatureCard icon="▤" title="TradingView Charts" description="Professional charting with indicators" />
          <FeatureCard icon="⚡" title="Fast Execution" description="Low-latency order placement" />
          <FeatureCard icon="◐" title="Hedge Strategies" description="Automated position hedging" />
          <FeatureCard icon="◧" title="Paper Trading" description="Risk-free strategy testing" />
          <FeatureCard icon="⬡" title="DEX Support" description="On-chain market making (soon)" />
        </div>
      </section>
    </div>
  );
}

function StatItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-muted)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          fontWeight: 600,
          color: color,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div
      style={{
        padding: 20,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}
    >
      <div style={{ fontSize: 20, marginBottom: 12, color: 'var(--accent)' }}>{icon}</div>
      <h4
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: 4,
        }}
      >
        {title}
      </h4>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>{description}</p>
    </div>
  );
}

function SetupStep({
  step,
  title,
  description,
  code,
}: {
  step: number;
  title: string;
  description: string;
  code: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr',
        gap: 16,
        padding: 16,
        background: 'var(--bg-tertiary)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          fontWeight: 700,
          color: 'var(--bg-primary)',
        }}
      >
        {step}
      </div>
      <div>
        <h4
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: 4,
          }}
        >
          {title}
        </h4>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
          {description}
        </p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--green)',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {code}
        </pre>
      </div>
    </div>
  );
}
