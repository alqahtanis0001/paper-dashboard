import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { dealEngine } from '@/lib/engine/dealEngine';

const schema = z.object({
  activeMarketId: z.string().optional(),
  regimeOverride: z.enum(['AUTO', 'BULL', 'BEAR', 'CHOPPY', 'HIGH_VOL', 'LOW_VOL']).optional(),
  intensity: z.number().min(0.25).max(2.5).optional(),
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

  const controlState = await dealEngine.setMarketAndOverride(parsed.data);
  return NextResponse.json({ controlState });
}
