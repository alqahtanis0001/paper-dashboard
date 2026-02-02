'use client';

import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import dayjs from 'dayjs';

type Deal = {
  id: string;
  symbol: string;
  chainName: string;
  basePrice: number;
  startTimeUtc: string;
  totalDurationSec: number;
  dropDelaySec: number;
  dropMagnitudePct: number;
  status: string;
  jumps: {
    riseDelaySec: number;
    riseMagnitudePct: number;
    holdSec: number;
    orderIndex: number;
  }[];
};

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [passkey, setPasskey] = useState('');
  const [error, setError] = useState('');
  const [deals, setDeals] = useState<Deal[]>([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    symbol: 'BTC/USDT',
    chainName: 'Bitcoin',
    basePrice: 48000,
    startTimeUtc: dayjs().add(2, 'minute').toISOString(),
    totalDurationSec: 90,
    dropDelaySec: 10,
    dropMagnitudePct: 8,
  });
  const [jumps, setJumps] = useState([{ riseDelaySec: 30, riseMagnitudePct: 12, holdSec: 8, orderIndex: 0 }]);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Login failed');
      return;
    }
    setAuthed(true);
    loadDeals();
  };

  const loadDeals = async () => {
    const res = await fetch('/api/admin/deals');
    if (res.ok) {
      const body = await res.json();
      setDeals(body.deals);
    }
  };

  useEffect(() => {
    if (authed) loadDeals();
  }, [authed]);

  const createDeal = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const res = await fetch('/api/admin/deal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, jumps }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Create failed');
      return;
    }
    setForm({ ...form, startTimeUtc: dayjs().add(3, 'minute').toISOString() });
    loadDeals();
  };

  const activateDeal = async (id: string) => {
    await fetch('/api/admin/deal/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, startNow: true }),
    });
    loadDeals();
  };

  if (!authed) {
    return (
      <div style={styles.page}>
        <div style={styles.card} className="glass">
          <h1>Admin Console</h1>
          <p style={{ color: 'var(--muted)' }}>Enter admin passkey to orchestrate scenarios.</p>
          <form onSubmit={login} style={{ width: '100%' }}>
            <input
              type="password"
              value={passkey}
              onChange={(e) => setPasskey(e.target.value)}
              placeholder="Admin passkey"
              style={styles.input}
            />
            {error && <p style={styles.error}>{error}</p>}
            <button style={styles.button}>Authenticate</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', display: 'grid', gap: '1.5rem' }}>
      <div className="glass" style={{ padding: '1.5rem' }}>
        <h2 style={{ marginBottom: '0.6rem' }}>Schedule Deal</h2>
        <form onSubmit={createDeal} style={{ display: 'grid', gap: '0.8rem', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
          <input style={styles.input} value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="Symbol" />
          <input style={styles.input} value={form.chainName} onChange={(e) => setForm({ ...form, chainName: e.target.value })} placeholder="Chain" />
          <input
            style={styles.input}
            type="number"
            value={form.basePrice}
            onChange={(e) => setForm({ ...form, basePrice: Number(e.target.value) })}
            placeholder="Base price"
          />
          <input
            style={styles.input}
            value={form.startTimeUtc}
            onChange={(e) => setForm({ ...form, startTimeUtc: e.target.value })}
            placeholder="Start time (ISO)"
          />
          <input
            style={styles.input}
            type="number"
            value={form.totalDurationSec}
            onChange={(e) => setForm({ ...form, totalDurationSec: Number(e.target.value) })}
            placeholder="Duration sec"
          />
          <input
            style={styles.input}
            type="number"
            value={form.dropDelaySec}
            onChange={(e) => setForm({ ...form, dropDelaySec: Number(e.target.value) })}
            placeholder="Drop delay sec"
          />
          <input
            style={styles.input}
            type="number"
            value={form.dropMagnitudePct}
            onChange={(e) => setForm({ ...form, dropMagnitudePct: Number(e.target.value) })}
            placeholder="Drop %"
          />
          {jumps.map((jump, idx) => (
            <div key={idx} className="glass" style={{ padding: '0.8rem', border: '1px dashed var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Rise #{idx + 1}</div>
              <input
                style={styles.input}
                type="number"
                value={jump.riseDelaySec}
                onChange={(e) =>
                  setJumps(jumps.map((j, jdx) => (jdx === idx ? { ...j, riseDelaySec: Number(e.target.value) } : j)))
                }
                placeholder="Rise delay sec"
              />
              <input
                style={styles.input}
                type="number"
                value={jump.riseMagnitudePct}
                onChange={(e) =>
                  setJumps(jumps.map((j, jdx) => (jdx === idx ? { ...j, riseMagnitudePct: Number(e.target.value) } : j)))
                }
                placeholder="Rise %"
              />
              <input
                style={styles.input}
                type="number"
                value={jump.holdSec}
                onChange={(e) => setJumps(jumps.map((j, jdx) => (jdx === idx ? { ...j, holdSec: Number(e.target.value) } : j)))}
                placeholder="Hold sec"
              />
              <input
                style={styles.input}
                type="number"
                value={jump.orderIndex}
                onChange={(e) =>
                  setJumps(jumps.map((j, jdx) => (jdx === idx ? { ...j, orderIndex: Number(e.target.value) } : j)))
                }
                placeholder="Order index"
              />
            </div>
          ))}
          <button type="submit" disabled={saving} style={styles.button}>
            {saving ? 'Creating…' : 'Create Deal'}
          </button>
          {error && <p style={styles.error}>{error}</p>}
        </form>
      </div>
      <div className="glass" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Deals</h3>
          <button onClick={loadDeals} style={{ ...styles.button, width: 'auto', padding: '0.5rem 0.9rem' }}>
            Refresh
          </button>
        </div>
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.6rem' }}>
          {deals.map((d) => (
            <div key={d.id} className="glass" style={{ padding: '0.8rem', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{d.symbol}</strong>
                <span style={{ color: 'var(--muted)' }}>{d.status}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                Base {d.basePrice} · Start {dayjs(d.startTimeUtc).format('HH:mm:ss')} · Duration {d.totalDurationSec}s
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {d.jumps.map((j, idx) => (
                  <span key={idx} style={{ fontSize: 12, padding: '4px 8px', background: '#13203a', borderRadius: 8 }}>
                    Rise {j.riseMagnitudePct}% @ {j.riseDelaySec}s hold {j.holdSec}s
                  </span>
                ))}
              </div>
              <button onClick={() => activateDeal(d.id)} style={{ ...styles.button, marginTop: 8 }}>
                Activate now
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  card: {
    width: 420,
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem 0.9rem',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: '#0f172b',
    color: 'var(--text)',
    marginBottom: '0.35rem',
  },
  button: {
    background: 'linear-gradient(135deg,#ff5c8d,#5df3a6)',
    color: '#05070f',
    border: 'none',
    borderRadius: 10,
    padding: '0.7rem 1rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  error: { color: '#ff5c8d' },
};
