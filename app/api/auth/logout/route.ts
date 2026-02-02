import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, getSessionFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (session) {
    await prisma.authSession.delete({ where: { sessionToken: session.token } }).catch(() => null);
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
