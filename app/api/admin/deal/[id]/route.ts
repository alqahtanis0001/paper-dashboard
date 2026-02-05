import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

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

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  logServerAction('admin.deal.update', 'start', { dealId: params.id });
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.deal.update', 'error', error);
    return authErrorResponse(error);
  }
  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('admin.deal.update', 'warn', { dealId: params.id, reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const updates: Record<string, unknown> = { ...parsed.data };
  if (updates.startTimeUtc) {
    updates.startTimeUtc = new Date(updates.startTimeUtc as string);
  }
  delete updates.jumps;

  await prisma.deal.update({
    where: { id: params.id },
    data: updates,
    include: { jumps: true },
  });

  if (parsed.data.jumps) {
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
  await logAuditEvent('deal_updated', 'ADMIN', { dealId: params.id });
  logServerAction('admin.deal.update', 'success', { dealId: params.id, hasDeal: !!updated });
  return NextResponse.json({ deal: updated });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  logServerAction('admin.deal.delete', 'start', { dealId: params.id });
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.deal.delete', 'error', error);
    return authErrorResponse(error);
  }
  await prisma.deal.delete({ where: { id: params.id } }).catch(() => null);
  await logAuditEvent('deal_deleted', 'ADMIN', { dealId: params.id });
  logServerAction('admin.deal.delete', 'success', { dealId: params.id });
  return NextResponse.json({ ok: true });
}
