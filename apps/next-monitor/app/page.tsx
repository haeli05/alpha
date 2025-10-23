import Link from 'next/link';

export default function Home() {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <h1>Welcome</h1>
      <p>Start by exploring major Binance markets on the 15m timeframe.</p>
      <div>
        <Link href="/markets" style={{ textDecoration: 'underline' }}>Go to Markets</Link>
      </div>
    </div>
  );
}

