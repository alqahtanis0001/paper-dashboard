import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, getSessionFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (session) {
    await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }).catch(() => null);
    await logAuditEvent('logout', session.role, { sessionId: session.id });
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
