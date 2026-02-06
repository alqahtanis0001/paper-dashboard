import { createHash } from 'crypto';
import { prisma } from './prisma';
import { LoginAttemptRole } from '@prisma/client';
import { runtimeEnv } from './runtimeEnv';

const DEFAULT_LOCKOUT_THRESHOLD = runtimeEnv.isLocal ? 50 : 10;
const DEFAULT_LOCKOUT_WINDOW_MS = runtimeEnv.isLocal ? 60 * 1000 : 5 * 60 * 1000;
const LOCKOUT_THRESHOLD = Number.parseInt(process.env.LOGIN_LOCKOUT_THRESHOLD ?? String(DEFAULT_LOCKOUT_THRESHOLD), 10);
const LOCKOUT_WINDOW_MS = Number.parseInt(process.env.LOGIN_LOCKOUT_WINDOW_MS ?? String(DEFAULT_LOCKOUT_WINDOW_MS), 10);

function getWindowStart() {
  return new Date(Date.now() - LOCKOUT_WINDOW_MS);
}

async function cleanupOldFailedAttempts(ipHash: string, roleAttempted: LoginAttemptRole) {
  await prisma.loginAttempt.deleteMany({
    where: { ipHash, roleAttempted, success: false, createdAt: { lt: getWindowStart() } },
  });
}

export function hashIp(ipRaw: string) {
  return createHash('sha256').update(ipRaw).digest('hex');
}

export function getClientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip') ?? 'local';
}

export async function assertLoginAllowed(ipHash: string, roleAttempted: LoginAttemptRole) {
  await cleanupOldFailedAttempts(ipHash, roleAttempted);

  const since = getWindowStart();
  const fails = await prisma.loginAttempt.count({
    where: { ipHash, roleAttempted, success: false, createdAt: { gte: since } },
  });

  if (fails >= LOCKOUT_THRESHOLD) {
    const oldestInWindow = await prisma.loginAttempt.findFirst({
      where: { ipHash, roleAttempted, success: false, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
    });

    const retryAfterMs = Math.max(
      1,
      LOCKOUT_WINDOW_MS - (Date.now() - (oldestInWindow?.createdAt.getTime() ?? Date.now())),
    );

    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }

  return { allowed: true, retryAfterSec: 0 };
}

export async function recordLoginAttempt(ipHash: string, roleAttempted: LoginAttemptRole, success: boolean) {
  await prisma.loginAttempt.create({ data: { ipHash, roleAttempted, success } });

  if (success) {
    await prisma.loginAttempt.deleteMany({ where: { ipHash, roleAttempted, success: false } });
    return;
  }

  await cleanupOldFailedAttempts(ipHash, roleAttempted);
}
