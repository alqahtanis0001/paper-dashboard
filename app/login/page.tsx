'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [passkey, setPasskey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey }),
    });
    setLoading(false);
    if (res.ok) {
      router.push('/dashboard');
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Login failed');
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card as any} className="glass">
        <h1 style={styles.title}>AI Meta Desk</h1>
        <p style={styles.subtitle}>Passkey-only access. The AIs take it from here.</p>
        <form onSubmit={submit} style={{ width: '100%' }}>
          <label style={styles.label}>Passkey</label>
          <input
            type="password"
            value={passkey}
            onChange={(e) => setPasskey(e.target.value)}
            style={styles.input as any}
            placeholder="Enter passkey"
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" disabled={loading} style={styles.button as any}>
            {loading ? 'Verifying…' : 'Enter Dashboard'}
          </button>
        </form>
        <div style={styles.footer}>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>Admin? Use /admin</span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    padding: '2.2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    textAlign: 'left',
  },
  title: {
    fontSize: '1.9rem',
    fontWeight: 700,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: 'var(--muted)',
    fontSize: '0.95rem',
    marginBottom: '0.5rem',
  },
  label: {
    display: 'block',
    color: 'var(--muted)',
    marginBottom: '0.3rem',
    fontSize: '0.85rem',
  },
  input: {
    width: '100%',
    padding: '0.85rem 1rem',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: '#0f172b',
    color: 'var(--text)',
    fontSize: '1rem',
    marginBottom: '0.6rem',
  },
  button: {
    width: '100%',
    padding: '0.9rem 1rem',
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, #5df3a6, #5db3f3)',
    color: '#02060f',
    fontWeight: 700,
    cursor: 'pointer',
    marginTop: '0.2rem',
  },
  error: {
    color: '#ff5c8d',
    fontSize: '0.9rem',
  },
  footer: {
    marginTop: '0.8rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
};
