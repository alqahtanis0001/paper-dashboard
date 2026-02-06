import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';
import { assertLoginAllowed, getClientIp, hashIp, recordLoginAttempt } from '@/lib/security';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';
import { getConfiguredPasskey, normalizePasskey } from '@/lib/passkeys';

const bodySchema = z.object({ passkey: z.string().min(1) });

const DEFAULT_USER_PASSKEY = 'user-pass-123';

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

  const { sessionId, expiresAt } = await createSession('USER');
  const res = NextResponse.json({ ok: true });
  attachSessionCookie(res, sessionId, expiresAt);
  await logAuditEvent('login_success', 'USER', { sessionId });
  logServerAction('auth.user.login', 'success', { sessionId });
  return res;
}
