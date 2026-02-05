import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';
import { dealEngine } from '@/lib/engine/dealEngine';

const bodySchema = z.object({
  id: z.string().uuid(),
  startNow: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  logServerAction('admin.deal.activate', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.deal.activate', 'error', error);
    return authErrorResponse(error);
  }
  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('admin.deal.activate', 'warn', { reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const startTimeUtc = parsed.data.startNow ? new Date() : undefined;

  const deal = await prisma.deal.update({
    where: { id: parsed.data.id },
    data: {
      startTimeUtc: startTimeUtc ?? undefined,
      status: 'SCHEDULED',
    },
    include: { jumps: { orderBy: { orderIndex: 'asc' } } },
  });

  if (parsed.data.startNow) {
    dealEngine.setChartPreferences(deal.symbol, dealEngine.getSelectedTimeframe());
    dealEngine.notifyControlState();
  }

  await logAuditEvent('deal_activated', 'ADMIN', { dealId: deal.id, startNow: !!parsed.data.startNow });
  logServerAction('admin.deal.activate', 'success', { dealId: deal.id, startNow: !!parsed.data.startNow });
  return NextResponse.json({ deal });
}
