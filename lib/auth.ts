import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './prisma';
import { Role } from '@prisma/client';

const SESSION_COOKIE = 'session_id';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24; // 24h

export type SessionContext = {
  id: string;
  role: Role;
  expiresAt: Date;
};

export async function createSession(role: Role) {
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.authSession.updateMany({
    where: {
      role,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { revokedAt: new Date() },
  });

  const session = await prisma.authSession.create({
    data: {
      expiresAt,
      role,
      isAdmin: role === 'ADMIN',
      sessionToken: randomUUID(),
    },
  });
  return { sessionId: session.id, expiresAt };
}

export function attachSessionCookie(res: NextResponse, sessionId: string, expiresAt: Date) {
  res.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function getSessionFromRequest(req: NextRequest): Promise<SessionContext | null> {
  const sessionId = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;
  const session = await prisma.authSession.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => null);
    return null;
  }
  await prisma.authSession.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } }).catch(() => null);
  return { id: session.id, role: session.role, expiresAt: session.expiresAt };
}

export async function requireUserSession(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) throw new Error('UNAUTHENTICATED');
  return session;
}

export async function requireAdminSession(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) throw new Error('UNAUTHENTICATED');
  if (session.role !== 'ADMIN') throw new Error('FORBIDDEN');
  return session;
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, expires: new Date(0), path: '/' });
}

export function authErrorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'FORBIDDEN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
