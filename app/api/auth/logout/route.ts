import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, getSessionFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

export async function POST(req: NextRequest) {
  logServerAction('auth.logout', 'start');
  const session = await getSessionFromRequest(req);
  if (session) {
    await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }).catch(() => null);
    await logAuditEvent('logout', session.role, { sessionId: session.id });
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  logServerAction('auth.logout', 'success', { hadSession: !!session });
  return res;
}
