import { getClientIp, hashIp } from './security';

type GeoSource = 'headers' | 'ipapi' | 'none';

export type ClientContext = {
  ip: string;
  ipHash: string;
  userAgent: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timezone: string | null;
  org: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: GeoSource;
  privateIp: boolean;
};

type GeoInfo = {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timezone: string | null;
  org: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  source: Exclude<GeoSource, 'none'>;
};

const GEO_LOOKUP_TIMEOUT_MS = Number.parseInt(process.env.GEO_LOOKUP_TIMEOUT_MS ?? '1500', 10);

function pickHeader(headers: Headers, candidates: string[]) {
  for (const key of candidates) {
    const value = headers.get(key);
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function parseNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeIp(ipRaw: string) {
  let ip = ipRaw.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(ip)) ip = ip.split(':')[0];
  return ip || 'local';
}

function isPrivateIp(ip: string) {
  if (!ip || ip === 'local' || ip === 'localhost') return true;

  if (ip.includes(':')) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  if (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) {
    return true;
  }

  const second = Number.parseInt(ip.split('.')[1] ?? '', 10);
  if (ip.startsWith('172.') && Number.isFinite(second) && second >= 16 && second <= 31) return true;
  return false;
}

function parseUserAgent(userAgent: string | null) {
  if (!userAgent) {
    return { browser: null, os: null, device: null };
  }

  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua) && /Version\//.test(ua)
          ? 'Safari'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /MSIE|Trident\//.test(ua)
              ? 'Internet Explorer'
              : 'Unknown';

  const os = /Windows NT/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown';

  const device = /bot|crawl|spider/i.test(ua)
    ? 'Bot'
    : /iPad|Tablet|SM-T|Tab/i.test(ua)
      ? 'Tablet'
      : /Mobi|Android|iPhone/i.test(ua)
        ? 'Mobile'
        : 'Desktop';

  return { browser, os, device };
}

function geoFromHeaders(headers: Headers): GeoInfo | null {
  const city = pickHeader(headers, ['x-vercel-ip-city', 'cf-ipcity', 'x-geo-city']);
  const region = pickHeader(headers, ['x-vercel-ip-country-region', 'cf-region', 'x-geo-region']);
  const country = pickHeader(headers, ['x-vercel-ip-country', 'x-country-name']);
  const countryCode = pickHeader(headers, ['cf-ipcountry', 'x-country-code']);
  const timezone = pickHeader(headers, ['x-vercel-ip-timezone', 'cf-timezone', 'x-time-zone']);

  if (!city && !region && !country && !countryCode && !timezone) return null;

  return {
    city,
    region,
    country,
    countryCode,
    timezone,
    org: null,
    postal: null,
    latitude: null,
    longitude: null,
    source: 'headers',
  };
}

async function geoFromIpApi(ip: string): Promise<GeoInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEO_LOOKUP_TIMEOUT_MS);

  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json().catch(() => null)) as
      | {
          error?: boolean;
          city?: string;
          region?: string;
          country_name?: string;
          country_code?: string;
          timezone?: string;
          org?: string;
          postal?: string;
          latitude?: number | string;
          longitude?: number | string;
        }
      | null;
    if (!data || data.error) return null;

    return {
      city: typeof data.city === 'string' ? data.city : null,
      region: typeof data.region === 'string' ? data.region : null,
      country: typeof data.country_name === 'string' ? data.country_name : null,
      countryCode: typeof data.country_code === 'string' ? data.country_code : null,
      timezone: typeof data.timezone === 'string' ? data.timezone : null,
      org: typeof data.org === 'string' ? data.org : null,
      postal: typeof data.postal === 'string' ? data.postal : null,
      latitude: parseNumber(data.latitude),
      longitude: parseNumber(data.longitude),
      source: 'ipapi',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectClientContext(headers: Headers): Promise<ClientContext> {
  const ip = normalizeIp(getClientIp(headers));
  const ipHash = hashIp(ip);
  const userAgent = headers.get('user-agent')?.trim() || null;
  const { browser, os, device } = parseUserAgent(userAgent);

  const privateIp = isPrivateIp(ip);
  const headerGeo = geoFromHeaders(headers);
  const lookupGeo = !headerGeo && !privateIp ? await geoFromIpApi(ip) : null;
  const geo = headerGeo ?? lookupGeo;

  return {
    ip,
    ipHash,
    userAgent,
    browser,
    os,
    device,
    city: geo?.city ?? null,
    region: geo?.region ?? null,
    country: geo?.country ?? null,
    countryCode: geo?.countryCode ?? null,
    timezone: geo?.timezone ?? null,
    org: geo?.org ?? null,
    postal: geo?.postal ?? null,
    latitude: geo?.latitude ?? null,
    longitude: geo?.longitude ?? null,
    locationSource: geo?.source ?? 'none',
    privateIp,
  };
}
