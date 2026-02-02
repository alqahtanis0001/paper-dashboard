import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const jumpSchema = z.object({
  riseDelaySec: z.number().int().nonnegative(),
  riseMagnitudePct: z.number(),
  holdSec: z.number().int().nonnegative(),
  orderIndex: z.number().int().nonnegative(),
});

const bodySchema = z.object({
  symbol: z.string(),
  chainName: z.string(),
  basePrice: z.number().positive(),
  startTimeUtc: z.string(), // ISO
  totalDurationSec: z.number().int().positive(),
  dropDelaySec: z.number().int().nonnegative(),
  dropMagnitudePct: z.number(),
  jumps: z.array(jumpSchema).default([]),
});

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const deal = await prisma.deal.create({
    data: {
      symbol: parsed.data.symbol,
      chainName: parsed.data.chainName,
      basePrice: parsed.data.basePrice,
      startTimeUtc: new Date(parsed.data.startTimeUtc),
      totalDurationSec: parsed.data.totalDurationSec,
      dropDelaySec: parsed.data.dropDelaySec,
      dropMagnitudePct: parsed.data.dropMagnitudePct,
      status: 'SCHEDULED',
      jumps: {
        create: parsed.data.jumps,
      },
    },
    include: { jumps: true },
  });

  return NextResponse.json({ deal });
}
