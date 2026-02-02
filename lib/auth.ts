import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './prisma';
import { v4 as uuidv4 } from 'uuid';

const SESSION_COOKIE = 'session_token';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24; // 24h

export type SessionContext = {
  token: string;
  isAdmin: boolean;
  expiresAt: Date;
};

export async function createSession(isAdmin: boolean) {
  const sessionToken = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await prisma.authSession.create({
    data: {
      sessionToken,
      expiresAt,
      isAdmin,
    },
  });
  return { sessionToken, expiresAt };
}

export function attachSessionCookie(res: NextResponse, sessionToken: string, expiresAt: Date) {
  res.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function getSessionFromRequest(req: NextRequest): Promise<SessionContext | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.authSession.findUnique({ where: { sessionToken: token } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.authSession.delete({ where: { sessionToken: token } });
    return null;
  }
  return { token, isAdmin: session.isAdmin, expiresAt: session.expiresAt };
}

export async function requireUserSession(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) throw new Error('UNAUTHENTICATED');
  if (session.isAdmin) return session; // admins can act as user too
  return session;
}

export async function requireAdminSession(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session || !session.isAdmin) throw new Error('FORBIDDEN');
  return session;
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, expires: new Date(0), path: '/' });
}
