import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { ensureWithdrawConfig, normalizeTaxPercent } from '@/lib/withdrawals';
import { logServerAction } from '@/lib/serverLogger';
import { prisma } from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit';

const bodySchema = z.object({
  taxPercent: z.number().finite().min(0).max(100),
});

export async function GET(req: NextRequest) {
  logServerAction('admin.withdrawTax.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.withdrawTax.get', 'error', error);
    return authErrorResponse(error);
  }

  const config = await ensureWithdrawConfig();
  logServerAction('admin.withdrawTax.get', 'success', { taxPercent: config.taxPercent });
  return NextResponse.json({ taxPercent: config.taxPercent });
}

export async function POST(req: NextRequest) {
  logServerAction('admin.withdrawTax.post', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.withdrawTax.post', 'error', error);
    return authErrorResponse(error);
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('admin.withdrawTax.post', 'warn', { reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid tax percent' }, { status: 400 });
  }

  const taxPercent = normalizeTaxPercent(parsed.data.taxPercent);

  const current = await ensureWithdrawConfig();
  const updated = await prisma.withdrawConfig.update({
    where: { id: current.id },
    data: { taxPercent },
  });

  await logAuditEvent('withdraw_tax_updated', 'ADMIN', {
    previousTaxPercent: current.taxPercent,
    nextTaxPercent: updated.taxPercent,
  });

  logServerAction('admin.withdrawTax.post', 'success', {
    previousTaxPercent: current.taxPercent,
    nextTaxPercent: updated.taxPercent,
  });

  return NextResponse.json({ taxPercent: updated.taxPercent });
}
