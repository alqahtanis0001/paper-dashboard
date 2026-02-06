'use client';

import { CSSProperties, FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

type LoginClientContext = {
  landingPath: string;
  referrer: string | null;
  language: string | null;
  languages: string[];
  locale: string | null;
  timezone: string | null;
  platform: string | null;
  userAgentClient: string | null;
  deviceModel: string | null;
  devicePlatform: string | null;
  devicePlatformVersion: string | null;
  deviceArchitecture: string | null;
  deviceBitness: string | null;
  browserFullVersion: string | null;
  browserBrands: string[];
  deviceMemoryGb: number | null;
  hardwareConcurrency: number | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  colorDepth: number | null;
  campaign: {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmTerm: string | null;
    utmContent: string | null;
    gclid: string | null;
    fbclid: string | null;
    ttclid: string | null;
    msclkid: string | null;
  };
  connection: {
    effectiveType: string | null;
    downlinkMbps: number | null;
    rttMs: number | null;
    saveData: boolean | null;
  };
};

const getQueryParam = (params: URLSearchParams, key: string) => {
  const value = params.get(key);
  return value && value.trim().length > 0 ? value.trim() : null;
};

const readString = (value: unknown, maxLen = 160) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
};

const readNumber = (value: unknown, maxValue: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, maxValue);
};

type NavigatorWithHints = Navigator & {
  language?: string;
  languages?: readonly string[];
  platform?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
  userAgentData?: {
    brands?: Array<{ brand?: string; version?: string }>;
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  };
};

const buildClientContext = async (): Promise<LoginClientContext> => {
  const params = new URLSearchParams(window.location.search);
  const nav = navigator as NavigatorWithHints;
  const uaData = nav.userAgentData;
  const brandTokens = Array.isArray(uaData?.brands)
    ? uaData.brands
        .map((item) => {
          const brand = readString(item?.brand, 80);
          const version = readString(item?.version, 32);
          if (!brand) return null;
          return version ? `${brand} ${version}` : brand;
        })
        .filter((value): value is string => !!value)
        .slice(0, 8)
    : [];

  let deviceModel: string | null = null;
  let devicePlatformVersion: string | null = null;
  let deviceArchitecture: string | null = null;
  let deviceBitness: string | null = null;
  let browserFullVersion: string | null = null;

  if (typeof uaData?.getHighEntropyValues === 'function') {
    const entropy = await uaData
      .getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'uaFullVersion'])
      .catch(() => null);
    if (entropy && typeof entropy === 'object') {
      deviceModel = readString(entropy.model);
      devicePlatformVersion = readString(entropy.platformVersion);
      deviceArchitecture = readString(entropy.architecture);
      deviceBitness = readString(entropy.bitness);
      browserFullVersion = readString(entropy.uaFullVersion);
    }
  }

  return {
    landingPath: `${window.location.pathname}${window.location.search}`,
    referrer: document.referrer || null,
    language: nav.language ?? null,
    languages: Array.isArray(nav.languages) ? [...nav.languages].slice(0, 8) : [],
    locale: Intl.DateTimeFormat().resolvedOptions().locale ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    platform: nav.platform ?? null,
    userAgentClient: navigator.userAgent ?? null,
    deviceModel,
    devicePlatform: readString(uaData?.platform, 120),
    devicePlatformVersion,
    deviceArchitecture,
    deviceBitness,
    browserFullVersion,
    browserBrands: brandTokens,
    deviceMemoryGb: readNumber(nav.deviceMemory, 1024),
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === 'number' && Number.isFinite(nav.hardwareConcurrency)
        ? Math.max(0, Math.min(512, Math.trunc(nav.hardwareConcurrency)))
        : null,
    viewportWidth: Number.isFinite(window.innerWidth) ? window.innerWidth : null,
    viewportHeight: Number.isFinite(window.innerHeight) ? window.innerHeight : null,
    screenWidth: Number.isFinite(window.screen?.width) ? window.screen.width : null,
    screenHeight: Number.isFinite(window.screen?.height) ? window.screen.height : null,
    colorDepth: Number.isFinite(window.screen?.colorDepth) ? window.screen.colorDepth : null,
    campaign: {
      utmSource: getQueryParam(params, 'utm_source'),
      utmMedium: getQueryParam(params, 'utm_medium'),
      utmCampaign: getQueryParam(params, 'utm_campaign'),
      utmTerm: getQueryParam(params, 'utm_term'),
      utmContent: getQueryParam(params, 'utm_content'),
      gclid: getQueryParam(params, 'gclid'),
      fbclid: getQueryParam(params, 'fbclid'),
      ttclid: getQueryParam(params, 'ttclid'),
      msclkid: getQueryParam(params, 'msclkid'),
    },
    connection: {
      effectiveType: nav.connection?.effectiveType ?? null,
      downlinkMbps: typeof nav.connection?.downlink === 'number' ? nav.connection.downlink : null,
      rttMs: typeof nav.connection?.rtt === 'number' ? nav.connection.rtt : null,
      saveData: typeof nav.connection?.saveData === 'boolean' ? nav.connection.saveData : null,
    },
  };
};

export default function LoginPage() {
  const [passkey, setPasskey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const client = await buildClientContext();
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey, client }),
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
    <div style={styles.page} suppressHydrationWarning>
      <div style={styles.card} className="glass" suppressHydrationWarning>
        <h1 style={styles.title} suppressHydrationWarning>AI Meta Desk</h1>
        <p style={styles.subtitle} suppressHydrationWarning>Passkey-only access. The AIs take it from here.</p>
        <form onSubmit={submit} style={{ width: '100%' }}>
          <label style={styles.label} suppressHydrationWarning>Passkey</label>
          <input
            type="password"
            value={passkey}
            onChange={(e) => setPasskey(e.target.value)}
            style={styles.input}
            placeholder="Enter passkey"
            suppressHydrationWarning
          />
          {error && <p style={styles.error} suppressHydrationWarning>{error}</p>}
          <button type="submit" disabled={loading} style={styles.button} suppressHydrationWarning>
            {loading ? 'Verifying…' : 'Enter Dashboard'}
          </button>
        </form>
        <div style={styles.footer} suppressHydrationWarning>
          <span style={{ color: 'var(--muted)', fontSize: 13 }} suppressHydrationWarning>Admin? Use /admin</span>
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
