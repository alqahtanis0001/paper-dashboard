import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';
import { assertLoginAllowed, getClientIp, hashIp, recordLoginAttempt } from '@/lib/security';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';
import { getConfiguredPasskey, normalizePasskey } from '@/lib/passkeys';
import { collectClientContext } from '@/lib/clientContext';

const campaignSchema = z.object({
  utmSource: z.string().max(120).nullable().optional(),
  utmMedium: z.string().max(120).nullable().optional(),
  utmCampaign: z.string().max(180).nullable().optional(),
  utmTerm: z.string().max(180).nullable().optional(),
  utmContent: z.string().max(180).nullable().optional(),
  gclid: z.string().max(240).nullable().optional(),
  fbclid: z.string().max(240).nullable().optional(),
  ttclid: z.string().max(240).nullable().optional(),
  msclkid: z.string().max(240).nullable().optional(),
});

const connectionSchema = z.object({
  effectiveType: z.string().max(40).nullable().optional(),
  downlinkMbps: z.number().min(0).max(10000).nullable().optional(),
  rttMs: z.number().min(0).max(100000).nullable().optional(),
  saveData: z.boolean().nullable().optional(),
});

const clientPayloadSchema = z.object({
  landingPath: z.string().max(512).nullable().optional(),
  referrer: z.string().max(1024).nullable().optional(),
  language: z.string().max(64).nullable().optional(),
  languages: z.array(z.string().max(64)).max(8).optional(),
  locale: z.string().max(64).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  platform: z.string().max(128).nullable().optional(),
  userAgentClient: z.string().max(512).nullable().optional(),
  deviceModel: z.string().max(160).nullable().optional(),
  devicePlatform: z.string().max(120).nullable().optional(),
  devicePlatformVersion: z.string().max(80).nullable().optional(),
  deviceArchitecture: z.string().max(40).nullable().optional(),
  deviceBitness: z.string().max(20).nullable().optional(),
  browserFullVersion: z.string().max(80).nullable().optional(),
  browserBrands: z.array(z.string().max(120)).max(8).optional(),
  deviceMemoryGb: z.number().min(0).max(1024).nullable().optional(),
  hardwareConcurrency: z.number().int().min(0).max(512).nullable().optional(),
  viewportWidth: z.number().int().min(0).max(20000).nullable().optional(),
  viewportHeight: z.number().int().min(0).max(20000).nullable().optional(),
  screenWidth: z.number().int().min(0).max(20000).nullable().optional(),
  screenHeight: z.number().int().min(0).max(20000).nullable().optional(),
  colorDepth: z.number().int().min(0).max(64).nullable().optional(),
  campaign: campaignSchema.optional(),
  connection: connectionSchema.optional(),
});

const bodySchema = z.object({
  passkey: z.string().min(1),
  client: clientPayloadSchema.optional(),
});

const DEFAULT_USER_PASSKEY = 'user-pass-123';

function cleanText(value: string | null | undefined) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function getReferrerHost(referrer: string | null) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function getLocalHour(timezone: string | null) {
  if (!timezone) return null;
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).formatToParts(new Date()).find((part) => part.type === 'hour')?.value;
    if (!hour) return null;
    const parsed = Number.parseInt(hour, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function partOfDayLabel(localHour: number | null) {
  if (localHour === null) return null;
  if (localHour < 6) return 'Late night';
  if (localHour < 12) return 'Morning';
  if (localHour < 17) return 'Afternoon';
  if (localHour < 21) return 'Evening';
  return 'Night';
}

function classifyTrafficChannel(input: {
  utmMedium: string | null;
  utmSource: string | null;
  referrerHost: string | null;
  hasSearchClickId: boolean;
  hasSocialClickId: boolean;
}) {
  const medium = (input.utmMedium ?? '').toLowerCase();
  const source = (input.utmSource ?? '').toLowerCase();
  const refHost = (input.referrerHost ?? '').toLowerCase();

  if (input.hasSearchClickId) return 'Paid Search';
  if (input.hasSocialClickId) return 'Paid Social';

  if (medium.includes('email')) return 'Email';
  if (medium.includes('affiliate')) return 'Affiliate';
  if (medium.includes('display') || medium.includes('banner')) return 'Display';
  if (medium.includes('paid') || medium.includes('cpc') || medium.includes('ppc')) {
    if (
      source.includes('facebook') ||
      source.includes('instagram') ||
      source.includes('tiktok') ||
      source.includes('linkedin') ||
      source.includes('x') ||
      source.includes('twitter')
    ) {
      return 'Paid Social';
    }
    return 'Paid Search';
  }

  if (source.includes('facebook') || source.includes('instagram') || source.includes('tiktok') || source.includes('linkedin')) {
    return 'Social';
  }

  if (refHost.includes('google.') || refHost.includes('bing.') || refHost.includes('duckduckgo.') || refHost.includes('yahoo.')) {
    return 'Organic Search';
  }
  if (
    refHost.includes('facebook.') ||
    refHost.includes('instagram.') ||
    refHost.includes('tiktok.') ||
    refHost.includes('x.com') ||
    refHost.includes('twitter.')
  ) {
    return 'Social';
  }
  if (refHost) return 'Referral';
  return 'Direct';
}

function buildCampaignLabel(input: {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}) {
  if (input.utmCampaign) return input.utmCampaign;
  if (input.utmSource && input.utmMedium) return `${input.utmSource} / ${input.utmMedium}`;
  return input.utmSource ?? input.utmMedium ?? null;
}

function audienceSegmentLabel(input: {
  device: string | null;
  trafficChannel: string;
  partOfDay: string | null;
}) {
  const device = input.device ?? 'Unknown device';
  const day = input.partOfDay ?? 'anytime';
  if (input.trafficChannel === 'Paid Social') return `${device} social audience (${day})`;
  if (input.trafficChannel === 'Paid Search') return `${device} intent-driven audience (${day})`;
  if (input.trafficChannel === 'Organic Search') return `${device} research-driven audience (${day})`;
  if (input.trafficChannel === 'Direct') return `${device} returning audience (${day})`;
  return `${device} general audience (${day})`;
}

export async function POST(req: Request) {
  logServerAction('auth.user.login', 'start');
  const ipHash = hashIp(getClientIp(req.headers));
  const gate = await assertLoginAllowed(ipHash, 'USER');
  if (!gate.allowed) {
    logServerAction('auth.user.login', 'warn', { reason: 'rate_limited', retryAfterSec: gate.retryAfterSec });
    return NextResponse.json({ error: 'Too many attempts', retryAfterSec: gate.retryAfterSec }, { status: 429 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    logServerAction('auth.user.login', 'warn', { reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const configuredPasskey = getConfiguredPasskey(process.env.USER_PASSKEY, DEFAULT_USER_PASSKEY);
  const success = normalizePasskey(parsed.data.passkey) === configuredPasskey;
  await recordLoginAttempt(ipHash, 'USER', success);

  if (!success) {
    await logAuditEvent('login_failed', 'USER', { ipHash, roleAttempted: 'USER' });
    logServerAction('auth.user.login', 'warn', { reason: 'unauthorized' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const clientContext = await collectClientContext(req.headers);
  const clientPayload = parsed.data.client;
  const campaign = clientPayload?.campaign;
  const referrer = cleanText(clientPayload?.referrer ?? null);
  const referrerHost = getReferrerHost(referrer);
  const utmSource = cleanText(campaign?.utmSource);
  const utmMedium = cleanText(campaign?.utmMedium);
  const utmCampaign = cleanText(campaign?.utmCampaign);
  const utmTerm = cleanText(campaign?.utmTerm);
  const utmContent = cleanText(campaign?.utmContent);
  const gclid = cleanText(campaign?.gclid);
  const fbclid = cleanText(campaign?.fbclid);
  const ttclid = cleanText(campaign?.ttclid);
  const msclkid = cleanText(campaign?.msclkid);
  const timezone = cleanText(clientPayload?.timezone) ?? clientContext.timezone;
  const localHour = getLocalHour(timezone);
  const partOfDay = partOfDayLabel(localHour);
  const trafficChannel = classifyTrafficChannel({
    utmMedium,
    utmSource,
    referrerHost,
    hasSearchClickId: !!(gclid || msclkid),
    hasSocialClickId: !!(fbclid || ttclid),
  });
  const campaignLabel = buildCampaignLabel({ utmSource, utmMedium, utmCampaign });
  const audienceSegment = audienceSegmentLabel({
    device: clientContext.device,
    trafficChannel,
    partOfDay,
  });

  const { sessionId, expiresAt } = await createSession('USER');
  const res = NextResponse.json({ ok: true });
  attachSessionCookie(res, sessionId, expiresAt);
  await logAuditEvent('login_success', 'USER', {
    sessionId,
    ipHash: clientContext.ipHash,
    ip: clientContext.ip,
    client: {
      userAgent: clientContext.userAgent,
      browser: clientContext.browser,
      os: clientContext.os,
      device: clientContext.device,
      city: clientContext.city,
      region: clientContext.region,
      country: clientContext.country,
      countryCode: clientContext.countryCode,
      timezone: clientContext.timezone,
      org: clientContext.org,
      postal: clientContext.postal,
      latitude: clientContext.latitude,
      longitude: clientContext.longitude,
      locationSource: clientContext.locationSource,
      privateIp: clientContext.privateIp,
    },
    marketing: {
      landingPath: cleanText(clientPayload?.landingPath),
      referrer,
      referrerHost,
      language: cleanText(clientPayload?.language),
      languages: clientPayload?.languages ?? [],
      locale: cleanText(clientPayload?.locale),
      timezone,
      platform: cleanText(clientPayload?.platform),
      deviceHints: {
        model: cleanText(clientPayload?.deviceModel),
        platform: cleanText(clientPayload?.devicePlatform),
        platformVersion: cleanText(clientPayload?.devicePlatformVersion),
        architecture: cleanText(clientPayload?.deviceArchitecture),
        bitness: cleanText(clientPayload?.deviceBitness),
        browserFullVersion: cleanText(clientPayload?.browserFullVersion),
        browserBrands: clientPayload?.browserBrands ?? [],
        deviceMemoryGb: clientPayload?.deviceMemoryGb ?? null,
        hardwareConcurrency: clientPayload?.hardwareConcurrency ?? null,
      },
      viewport: {
        width: clientPayload?.viewportWidth ?? null,
        height: clientPayload?.viewportHeight ?? null,
      },
      screen: {
        width: clientPayload?.screenWidth ?? null,
        height: clientPayload?.screenHeight ?? null,
        colorDepth: clientPayload?.colorDepth ?? null,
      },
      campaign: {
        utmSource,
        utmMedium,
        utmCampaign,
        utmTerm,
        utmContent,
      },
      clickIds: {
        gclid,
        fbclid,
        ttclid,
        msclkid,
      },
      connection: {
        effectiveType: cleanText(clientPayload?.connection?.effectiveType),
        downlinkMbps: clientPayload?.connection?.downlinkMbps ?? null,
        rttMs: clientPayload?.connection?.rttMs ?? null,
        saveData: clientPayload?.connection?.saveData ?? null,
      },
      trafficChannel,
      campaignLabel,
      audienceSegment,
      localHour,
      partOfDay,
    },
  });
  logServerAction('auth.user.login', 'success', { sessionId });
  return res;
}
