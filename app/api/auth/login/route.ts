import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';

const bodySchema = z.object({ passkey: z.string().min(1) });
const rateLimiter = new Map<string, { count: number; ts: number }>();

function checkRateLimit(ip: string) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 10;
  const entry = rateLimiter.get(ip);
  if (!entry || now - entry.ts > windowMs) {
    rateLimiter.set(ip, { count: 1, ts: now });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for') ?? 'local';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  const { passkey } = parsed.data;
  if (passkey !== process.env.USER_PASSKEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionToken, expiresAt } = await createSession(false);
  const res = NextResponse.json({ ok: true });
  attachSessionCookie(res, sessionToken, expiresAt);
  return res;
}
