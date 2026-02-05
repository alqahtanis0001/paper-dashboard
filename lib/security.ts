import { createHash } from 'crypto';
import { prisma } from './prisma';
import { LoginAttemptRole } from '@prisma/client';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;

export function hashIp(ipRaw: string) {
  return createHash('sha256').update(ipRaw).digest('hex');
}

export function getClientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip') ?? 'local';
}

export async function assertLoginAllowed(ipHash: string, roleAttempted: LoginAttemptRole) {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
  const fails = await prisma.loginAttempt.count({
    where: { ipHash, roleAttempted, success: false, createdAt: { gte: since } },
  });
  if (fails >= LOCKOUT_THRESHOLD) {
    const recent = await prisma.loginAttempt.findFirst({
      where: { ipHash, roleAttempted, success: false, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    const retryAfterMs = Math.max(1, LOCKOUT_WINDOW_MS - (Date.now() - (recent?.createdAt.getTime() ?? Date.now())));
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export async function recordLoginAttempt(ipHash: string, roleAttempted: LoginAttemptRole, success: boolean) {
  await prisma.loginAttempt.create({ data: { ipHash, roleAttempted, success } });
  if (success) {
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    await prisma.loginAttempt.deleteMany({ where: { ipHash, roleAttempted, success: false, createdAt: { gte: since } } });
  }
}
