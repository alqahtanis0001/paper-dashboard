import { NextResponse } from 'next/server';
import { createSession, attachSessionCookie } from '@/lib/auth';
import { z } from 'zod';

const bodySchema = z.object({ passkey: z.string().min(1) });

export async function POST(req: Request) {
  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  if (parsed.data.passkey !== process.env.ADMIN_PASSKEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { sessionToken, expiresAt } = await createSession(true);
  const res = NextResponse.json({ ok: true });
  attachSessionCookie(res, sessionToken, expiresAt);
  return res;
}
