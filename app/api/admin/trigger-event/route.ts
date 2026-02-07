import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { dealEngine } from '@/lib/engine/dealEngine';

const schema = z.object({
  kind: z.enum(['NEWS_SPIKE', 'DUMP', 'SQUEEZE']),
  strength: z.number().positive().optional(),
});

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch (e) {
    return authErrorResponse(e);
  }

  const data = await req.json().catch(() => null);
  const parsed = schema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const event = dealEngine.triggerMarketEvent(parsed.data.kind, parsed.data.strength ?? 1);
  return NextResponse.json({ ok: true, event });
}
