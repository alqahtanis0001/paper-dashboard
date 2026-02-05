import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';
import { assertLoginAllowed, getClientIp, hashIp, recordLoginAttempt } from '@/lib/security';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

const bodySchema = z.object({ passkey: z.string().min(1) });

const DEFAULT_ADMIN_PASSKEY = 'admin-pass-456';

function normalizePasskey(passkey: string) {
  const trimmed = passkey.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export async function POST(req: Request) {
  logServerAction('auth.admin.login', 'start');
  const ipHash = hashIp(getClientIp(req.headers));
  const gate = await assertLoginAllowed(ipHash, 'ADMIN');
  if (!gate.allowed) {
    logServerAction('auth.admin.login', 'warn', { reason: 'rate_limited', retryAfterSec: gate.retryAfterSec });
    return NextResponse.json({ error: 'Too many attempts', retryAfterSec: gate.retryAfterSec }, { status: 429 });
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('auth.admin.login', 'warn', { reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const configuredPasskey = normalizePasskey(process.env.ADMIN_PASSKEY || DEFAULT_ADMIN_PASSKEY);
  const success = normalizePasskey(parsed.data.passkey) === configuredPasskey;
  await recordLoginAttempt(ipHash, 'ADMIN', success);

  if (!success) {
    await logAuditEvent('login_failed', 'ADMIN', { ipHash, roleAttempted: 'ADMIN' });
    logServerAction('auth.admin.login', 'warn', { reason: 'unauthorized' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId, expiresAt } = await createSession('ADMIN');
  const res = NextResponse.json({ ok: true });
  attachSessionCookie(res, sessionId, expiresAt);
  await logAuditEvent('login_success', 'ADMIN', { sessionId });
  logServerAction('auth.admin.login', 'success', { sessionId });
  return res;
}
