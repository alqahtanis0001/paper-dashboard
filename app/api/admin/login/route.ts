import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';
import { assertLoginAllowed, getClientIp, hashIp, recordLoginAttempt } from '@/lib/security';
import { logAuditEvent } from '@/lib/audit';

const bodySchema = z.object({ passkey: z.string().min(1) });

const DEFAULT_ADMIN_PASSKEY = 'admin-pass-456';

export async function POST(req: Request) {
  const ipHash = hashIp(getClientIp(req.headers));
  const gate = await assertLoginAllowed(ipHash, 'ADMIN');
  if (!gate.allowed) {
    return NextResponse.json({ error: 'Too many attempts', retryAfterSec: gate.retryAfterSec }, { status: 429 });
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const configuredPasskey = process.env.ADMIN_PASSKEY?.trim() || DEFAULT_ADMIN_PASSKEY;
  const success = parsed.data.passkey.trim() === configuredPasskey;
  await recordLoginAttempt(ipHash, 'ADMIN', success);

  if (!success) {
    await logAuditEvent('login_failed', 'ADMIN', { ipHash, roleAttempted: 'ADMIN' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId, expiresAt } = await createSession('ADMIN');
  const res = NextResponse.json({ ok: true });
  attachSessionCookie(res, sessionId, expiresAt);
  await logAuditEvent('login_success', 'ADMIN', { sessionId });
  return res;
}
