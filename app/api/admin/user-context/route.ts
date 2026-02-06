import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logServerAction } from '@/lib/serverLogger';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  return null;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseLoginMetadata(metadata: unknown) {
  const root = asObject(metadata);
  const client = asObject(root?.client);

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
    privateIp: typeof client?.privateIp === 'boolean' ? client.privateIp : null,
  };
}

export async function GET(req: NextRequest) {
  logServerAction('admin.userContext.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.userContext.get', 'error', error);
    return authErrorResponse(error);
  }

  const latestUserLogin = await prisma.auditLog.findFirst({
    where: { eventType: 'login_success', actorRole: 'USER' },
    orderBy: { createdAt: 'desc' },
  });

  const activeUserSession = await prisma.authSession.findFirst({
    where: { role: 'USER', revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  const parsed = parseLoginMetadata(latestUserLogin?.metadata);
  const sessionId = parsed.sessionId ?? activeUserSession?.id ?? null;

  const session = sessionId
    ? await prisma.authSession.findUnique({ where: { id: sessionId } })
    : activeUserSession;

  const userContext = {
    lastLoginAt: latestUserLogin?.createdAt ?? null,
    ip: parsed.ip,
    ipHash: parsed.ipHash,
    city: parsed.city,
    region: parsed.region,
    country: parsed.country,
    countryCode: parsed.countryCode,
    timezone: parsed.timezone,
    org: parsed.org,
    postal: parsed.postal,
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    locationSource: parsed.locationSource,
    privateIp: parsed.privateIp,
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    userAgent: parsed.userAgent,
    session: session
      ? {
          id: session.id,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
          isActive: session.revokedAt === null && session.expiresAt.getTime() > Date.now(),
        }
      : null,
  };

  logServerAction('admin.userContext.get', 'success', {
    hasLoginAudit: !!latestUserLogin,
    hasSession: !!session,
    city: userContext.city,
    country: userContext.country,
  });
  return NextResponse.json({ userContext });
}
