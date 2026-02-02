import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const jumpSchema = z.object({
  id: z.string().uuid().optional(),
  riseDelaySec: z.number().int().nonnegative(),
  riseMagnitudePct: z.number(),
  holdSec: z.number().int().nonnegative(),
  orderIndex: z.number().int().nonnegative(),
});

const bodySchema = z.object({
  symbol: z.string().optional(),
  chainName: z.string().optional(),
  basePrice: z.number().positive().optional(),
  startTimeUtc: z.string().optional(),
  totalDurationSec: z.number().int().positive().optional(),
  dropDelaySec: z.number().int().nonnegative().optional(),
  dropMagnitudePct: z.number().optional(),
  status: z.enum(['SCHEDULED', 'RUNNING', 'FINISHED']).optional(),
  jumps: z.array(jumpSchema).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAdminSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const updates: any = { ...parsed.data };
  if (updates.startTimeUtc) {
    updates.startTimeUtc = new Date(updates.startTimeUtc);
  }
  delete updates.jumps;

  const deal = await prisma.deal.update({
    where: { id: params.id },
    data: updates,
    include: { jumps: true },
  });

  if (parsed.data.jumps) {
    // replace jumps
    await prisma.dealJump.deleteMany({ where: { dealId: params.id } });
    await prisma.dealJump.createMany({
      data: parsed.data.jumps.map((j) => ({
        dealId: params.id,
        riseDelaySec: j.riseDelaySec,
        riseMagnitudePct: j.riseMagnitudePct,
        holdSec: j.holdSec,
        orderIndex: j.orderIndex,
      })),
    });
  }

  const updated = await prisma.deal.findUnique({ where: { id: params.id }, include: { jumps: true } });
  return NextResponse.json({ deal: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAdminSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  await prisma.deal.delete({ where: { id: params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
