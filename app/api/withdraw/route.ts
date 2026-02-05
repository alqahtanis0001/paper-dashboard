import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getWallet } from '@/lib/wallet';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

const bodySchema = z.object({ amount: z.number().positive() });

export async function POST(req: NextRequest) {
  logServerAction('withdraw.request', 'start');
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('withdraw.request', 'warn', { reason: 'invalid_amount' });
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const wallet = await getWallet();
  if (wallet.cashBalance < parsed.data.amount) {
    logServerAction('withdraw.request', 'warn', { reason: 'insufficient_balance' });
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
  }

  const request = await prisma.withdrawalRequest.create({
    data: { amount: parsed.data.amount, status: 'PENDING' },
  });

  await logAuditEvent('withdrawal_requested', 'USER', {
    withdrawalId: request.id,
    amount: parsed.data.amount,
    status: request.status,
  });

  logServerAction('withdraw.request', 'success', { withdrawalId: request.id, amount: request.amount });
  return NextResponse.json({ request });
}
