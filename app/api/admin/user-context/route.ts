import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logServerAction } from '@/lib/serverLogger';

type JsonObject = Record<string, unknown>;
type DistributionRow = { label: string; count: number; sharePct: number };

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  return null;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8);
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function parseLoginMetadata(metadata: unknown) {
  const root = asObject(metadata);
  const client = asObject(root?.client);
  const marketing = asObject(root?.marketing);
  const campaign = asObject(marketing?.campaign);
  const clickIds = asObject(marketing?.clickIds);
  const connection = asObject(marketing?.connection);
  const viewport = asObject(marketing?.viewport);
  const screen = asObject(marketing?.screen);

  return {
    sessionId: asString(root?.sessionId),
    ip: asString(root?.ip),
    ipHash: asString(root?.ipHash),
    userAgent: asString(client?.userAgent),
    browser: asString(client?.browser),
    os: asString(client?.os),
    device: asString(client?.device),
    city: asString(client?.city),
    region: asString(client?.region),
    country: asString(client?.country),
    countryCode: asString(client?.countryCode),
    timezone: asString(client?.timezone),
    org: asString(client?.org),
    postal: asString(client?.postal),
    latitude: asNumber(client?.latitude),
    longitude: asNumber(client?.longitude),
    locationSource: asString(client?.locationSource),
    privateIp: asBoolean(client?.privateIp),
    landingPath: asString(marketing?.landingPath),
    referrer: asString(marketing?.referrer),
    referrerHost: asString(marketing?.referrerHost),
    language: asString(marketing?.language),
    languages: asStringArray(marketing?.languages),
    locale: asString(marketing?.locale),
    clientTimezone: asString(marketing?.timezone),
    platform: asString(marketing?.platform),
    trafficChannel: asString(marketing?.trafficChannel),
    campaignLabel: asString(marketing?.campaignLabel),
    audienceSegment: asString(marketing?.audienceSegment),
    partOfDay: asString(marketing?.partOfDay),
    localHour: asNumber(marketing?.localHour),
    utmSource: asString(campaign?.utmSource),
    utmMedium: asString(campaign?.utmMedium),
    utmCampaign: asString(campaign?.utmCampaign),
    utmTerm: asString(campaign?.utmTerm),
    utmContent: asString(campaign?.utmContent),
    gclid: asString(clickIds?.gclid),
    fbclid: asString(clickIds?.fbclid),
    ttclid: asString(clickIds?.ttclid),
    msclkid: asString(clickIds?.msclkid),
    connectionType: asString(connection?.effectiveType),
    downlinkMbps: asNumber(connection?.downlinkMbps),
    rttMs: asNumber(connection?.rttMs),
    saveData: asBoolean(connection?.saveData),
    viewportWidth: asNumber(viewport?.width),
    viewportHeight: asNumber(viewport?.height),
    screenWidth: asNumber(screen?.width),
    screenHeight: asNumber(screen?.height),
    colorDepth: asNumber(screen?.colorDepth),
  };
}

function incrementCounter(counter: Record<string, number>, label: string | null | undefined) {
  if (!label) return;
  counter[label] = (counter[label] ?? 0) + 1;
}

function toTopRows(counter: Record<string, number>, total: number, limit = 4): DistributionRow[] {
  if (total <= 0) return [];
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({
      label,
      count,
      sharePct: Math.round((count / total) * 100),
    }));
}

function pickBestKnownLabel(rows: DistributionRow[]) {
  const known = rows.find((row) => row.label !== 'Unknown');
  return known?.label ?? rows[0]?.label ?? 'Unknown';
}

function describeRelativeMinutes(minutes: number) {
  if (minutes <= 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function describeDuration(minutes: number) {
  if (minutes <= 0) return 'expired';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function deriveSessionInsights(
  session:
    | {
        createdAt: Date;
        lastSeenAt: Date;
        expiresAt: Date;
        revokedAt: Date | null;
        isActive: boolean;
      }
    | null
) {
  if (!session) {
    return {
      freshnessLabel: 'No active user session found',
      lastSeenLabel: 'No activity signal',
      expiresInLabel: '--',
    };
  }

  const now = Date.now();
  const ageMinutes = Math.max(0, Math.round((now - session.createdAt.getTime()) / 60000));
  const seenMinutes = Math.max(0, Math.round((now - session.lastSeenAt.getTime()) / 60000));
  const expiryMinutes = Math.round((session.expiresAt.getTime() - now) / 60000);

  const freshnessLabel =
    ageMinutes < 5
      ? 'Fresh visit: user just logged in'
      : ageMinutes < 60
        ? `New visit: logged in ${describeRelativeMinutes(ageMinutes)}`
        : ageMinutes < 12 * 60
          ? `Same-day session: logged in ${describeRelativeMinutes(ageMinutes)}`
          : `Returning session: logged in ${describeRelativeMinutes(ageMinutes)}`;

  const lastSeenLabel = session.isActive ? `Last seen ${describeRelativeMinutes(seenMinutes)}` : 'Session inactive';
  const expiresInLabel = session.isActive ? `Session expires in ${describeDuration(expiryMinutes)}` : 'Session already inactive';

  return {
    freshnessLabel,
    lastSeenLabel,
    expiresInLabel,
  };
}

function trafficVolumeLabel(loginsLast24h: number) {
  if (loginsLast24h <= 0) return 'No login traffic in the last 24h';
  if (loginsLast24h < 5) return 'Light login traffic in the last 24h';
  if (loginsLast24h < 20) return 'Steady login traffic in the last 24h';
  return 'High login traffic in the last 24h';
}

function buildPlainSummary(input: {
  trafficVolume: string;
  topChannel: string;
  topDevice: string;
  topCountry: string;
}) {
  const locationText = input.topCountry === 'Unknown' ? '' : `, mostly from ${input.topCountry}`;
  return `${input.trafficVolume}. Current audience is mostly ${input.topDevice} users coming through ${input.topChannel}${locationText}.`;
}

export async function GET(req: NextRequest) {
  logServerAction('admin.userContext.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.userContext.get', 'error', error);
    return authErrorResponse(error);
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [latestUserLogin, activeUserSession, recentUserLogins] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { eventType: 'login_success', actorRole: 'USER' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.authSession.findFirst({
      where: { role: 'USER', revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.findMany({
      where: { eventType: 'login_success', actorRole: 'USER', createdAt: { gte: sevenDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { createdAt: true, metadata: true },
    }),
  ]);

  const parsedLatest = parseLoginMetadata(latestUserLogin?.metadata);
  const sessionId = parsedLatest.sessionId ?? activeUserSession?.id ?? null;
  const sessionRecord = sessionId
    ? await prisma.authSession.findUnique({ where: { id: sessionId } })
    : activeUserSession;

  const channelCounter: Record<string, number> = {};
  const countryCounter: Record<string, number> = {};
  const deviceCounter: Record<string, number> = {};
  const campaignCounter: Record<string, number> = {};

  for (const row of recentUserLogins) {
    const parsed = parseLoginMetadata(row.metadata);
    incrementCounter(channelCounter, parsed.trafficChannel ?? 'Unknown');
    incrementCounter(countryCounter, parsed.country ?? parsed.countryCode ?? 'Unknown');
    incrementCounter(deviceCounter, parsed.device ?? 'Unknown');
    incrementCounter(campaignCounter, parsed.campaignLabel ?? parsed.utmCampaign ?? parsed.utmSource ?? 'Unknown');
  }

  const loginsLast7d = recentUserLogins.length;
  const loginsLast24h = recentUserLogins.filter((row) => row.createdAt >= dayAgo).length;
  const topChannels = toTopRows(channelCounter, loginsLast7d);
  const topCountries = toTopRows(countryCounter, loginsLast7d);
  const topDevices = toTopRows(deviceCounter, loginsLast7d);
  const topCampaigns = toTopRows(campaignCounter, loginsLast7d);
  const volume = trafficVolumeLabel(loginsLast24h);

  const topChannel = pickBestKnownLabel(topChannels);
  const topDevice = pickBestKnownLabel(topDevices);
  const topCountry = pickBestKnownLabel(topCountries);

  const session = sessionRecord
    ? {
        id: sessionRecord.id,
        createdAt: sessionRecord.createdAt,
        lastSeenAt: sessionRecord.lastSeenAt,
        expiresAt: sessionRecord.expiresAt,
        revokedAt: sessionRecord.revokedAt,
        isActive: sessionRecord.revokedAt === null && sessionRecord.expiresAt.getTime() > Date.now(),
      }
    : null;

  const userContext = {
    lastLoginAt: latestUserLogin?.createdAt ?? null,
    ip: parsedLatest.ip,
    ipHash: parsedLatest.ipHash,
    city: parsedLatest.city,
    region: parsedLatest.region,
    country: parsedLatest.country,
    countryCode: parsedLatest.countryCode,
    timezone: parsedLatest.timezone,
    org: parsedLatest.org,
    postal: parsedLatest.postal,
    latitude: parsedLatest.latitude,
    longitude: parsedLatest.longitude,
    locationSource: parsedLatest.locationSource,
    privateIp: parsedLatest.privateIp,
    browser: parsedLatest.browser,
    os: parsedLatest.os,
    device: parsedLatest.device,
    userAgent: parsedLatest.userAgent,
    marketing: {
      landingPath: parsedLatest.landingPath,
      referrer: parsedLatest.referrer,
      referrerHost: parsedLatest.referrerHost,
      language: parsedLatest.language,
      languages: parsedLatest.languages,
      locale: parsedLatest.locale,
      clientTimezone: parsedLatest.clientTimezone,
      platform: parsedLatest.platform,
      trafficChannel: parsedLatest.trafficChannel,
      campaignLabel: parsedLatest.campaignLabel,
      audienceSegment: parsedLatest.audienceSegment,
      partOfDay: parsedLatest.partOfDay,
      localHour: parsedLatest.localHour,
      utmSource: parsedLatest.utmSource,
      utmMedium: parsedLatest.utmMedium,
      utmCampaign: parsedLatest.utmCampaign,
      utmTerm: parsedLatest.utmTerm,
      utmContent: parsedLatest.utmContent,
      clickIds: {
        gclid: parsedLatest.gclid,
        fbclid: parsedLatest.fbclid,
        ttclid: parsedLatest.ttclid,
        msclkid: parsedLatest.msclkid,
      },
      connectionType: parsedLatest.connectionType,
      downlinkMbps: parsedLatest.downlinkMbps,
      rttMs: parsedLatest.rttMs,
      saveData: parsedLatest.saveData,
      viewportWidth: parsedLatest.viewportWidth,
      viewportHeight: parsedLatest.viewportHeight,
      screenWidth: parsedLatest.screenWidth,
      screenHeight: parsedLatest.screenHeight,
      colorDepth: parsedLatest.colorDepth,
    },
    session,
    sessionInsights: deriveSessionInsights(session),
    aggregates: {
      loginsLast24h,
      loginsLast7d,
      trafficVolumeLabel: volume,
      topChannels,
      topCountries,
      topDevices,
      topCampaigns,
      plainSummary: buildPlainSummary({
        trafficVolume: volume,
        topChannel,
        topDevice,
        topCountry,
      }),
    },
  };

  logServerAction('admin.userContext.get', 'success', {
    hasLoginAudit: !!latestUserLogin,
    hasSession: !!session,
    city: userContext.city,
    country: userContext.country,
    trafficVolume: userContext.aggregates.trafficVolumeLabel,
  });
  return NextResponse.json({ userContext });
}
