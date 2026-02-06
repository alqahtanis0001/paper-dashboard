import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';
import { assertLoginAllowed, getClientIp, hashIp, recordLoginAttempt } from '@/lib/security';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';
import { verifyRolePasskey } from '@/lib/passkeys';
import { isDatabaseConnectivityError } from '@/lib/dbErrors';

const bodySchema = z.object({ passkey: z.string().min(1) });

export async function POST(req: Request) {
  logServerAction('auth.admin.login', 'start');
  try {
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

    const passkeyCheck = verifyRolePasskey('ADMIN', parsed.data.passkey);
    if (passkeyCheck.reason === 'not_configured') {
      await logAuditEvent('login_failed', 'ADMIN', { ipHash, roleAttempted: 'ADMIN', reason: 'passkey_not_configured' });
      logServerAction('auth.admin.login', 'error', { reason: 'passkey_not_configured' });
      return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
    }

    const success = passkeyCheck.ok;
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
    logServerAction('auth.admin.login', 'success', {
      sessionId,
      passkeySource: passkeyCheck.source ?? 'unknown',
      usedFallbackPasskey: passkeyCheck.usedFallback,
    });
    return res;
  } catch (error) {
    if (isDatabaseConnectivityError(error)) {
      logServerAction('auth.admin.login', 'error', { reason: 'database_unavailable' });
      return NextResponse.json({ error: 'Database unavailable. Start Postgres and retry.' }, { status: 503 });
    }
    throw error;
  }
}
