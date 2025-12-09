'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

export default function PolymarketSearch() {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const router = useRouter();

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        router.push(`/polymarket?q=${encodeURIComponent(query.trim())}`);
      }
    },
    [query, router]
  );

  return (
    <form onSubmit={handleSearch} style={{ display: 'flex', gap: 12 }}>
      <div
        style={{
          flex: 1,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {/* Search icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            position: 'absolute',
            left: 16,
            color: focused ? 'var(--accent)' : 'var(--text-tertiary)',
            transition: 'color 0.15s ease',
            pointerEvents: 'none',
          }}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search markets (e.g., 'Trump', 'Bitcoin', 'Super Bowl')"
          style={{
            width: '100%',
            padding: '14px 16px 14px 48px',
            fontSize: 14,
            fontFamily: 'var(--font-sans)',
            background: 'var(--bg-secondary)',
            border: `1px solid ${focused ? 'var(--accent)' : 'var(--border-strong)'}`,
            borderRadius: 10,
            color: 'var(--text-primary)',
            outline: 'none',
            transition: 'all 0.15s ease',
            boxShadow: focused ? '0 0 0 3px var(--accent-bg)' : 'none',
          }}
        />
      </div>

      <button
        type="submit"
        style={{
          padding: '14px 24px',
          fontSize: 13,
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--bg-primary)',
          background: 'linear-gradient(135deg, var(--accent) 0%, var(--green) 100%)',
          border: 'none',
          borderRadius: 10,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        Search
      </button>
    </form>
  );
}
