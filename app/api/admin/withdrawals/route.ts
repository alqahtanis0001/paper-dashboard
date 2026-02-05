import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

const bodySchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['APPROVE', 'REJECT']),
});

export async function GET(req: NextRequest) {
  logServerAction('admin.withdrawals.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.withdrawals.get', 'error', error);
    return authErrorResponse(error);
  }

  const requests = await prisma.withdrawalRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { time: 'asc' },
  });
  logServerAction('admin.withdrawals.get', 'success', { count: requests.length });
  return NextResponse.json({ requests });
}

export async function POST(req: NextRequest) {
  logServerAction('admin.withdrawals.post', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.withdrawals.post', 'error', error);
    return authErrorResponse(error);
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('admin.withdrawals.post', 'warn', { reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const request = await prisma.withdrawalRequest.findUnique({ where: { id: parsed.data.id } });
  if (!request) {
    logServerAction('admin.withdrawals.post', 'warn', { reason: 'not_found', withdrawalId: parsed.data.id });
    return NextResponse.json({ error: 'Withdrawal request not found' }, { status: 404 });
  }
  if (request.status !== 'PENDING') {
    logServerAction('admin.withdrawals.post', 'warn', { reason: 'already_processed', status: request.status });
    return NextResponse.json({ error: `Request already ${request.status}` }, { status: 400 });
  }

  if (parsed.data.action === 'REJECT') {
    const updated = await prisma.withdrawalRequest.update({
      where: { id: request.id },
      data: { status: 'REJECTED' },
    });
    await logAuditEvent('withdrawal_rejected', 'ADMIN', {
      withdrawalId: request.id,
      amount: request.amount,
      status: updated.status,
    });
    logServerAction('admin.withdrawals.post', 'success', { action: 'REJECT', withdrawalId: request.id });
    return NextResponse.json({ request: updated });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst();
      if (!wallet) throw new Error('WALLET_NOT_FOUND');
      if (wallet.cashBalance < request.amount) throw new Error('INSUFFICIENT_CASH');

      const updatedRequest = await tx.withdrawalRequest.update({
        where: { id: request.id },
        data: { status: 'APPROVED' },
      });
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { cashBalance: { decrement: request.amount } },
      });

      return { updatedRequest, updatedWallet };
    });

    await logAuditEvent('withdrawal_approved', 'ADMIN', {
      withdrawalId: request.id,
      amount: request.amount,
      status: result.updatedRequest.status,
      walletCashBalance: result.updatedWallet.cashBalance,
    });

    logServerAction('admin.withdrawals.post', 'success', { action: 'APPROVE', withdrawalId: request.id });
    return NextResponse.json({ request: result.updatedRequest, wallet: result.updatedWallet });
  } catch (error) {
    if (error instanceof Error && error.message === 'INSUFFICIENT_CASH') {
      logServerAction('admin.withdrawals.post', 'warn', { reason: 'insufficient_cash', withdrawalId: request.id });
      return NextResponse.json({ error: 'Insufficient wallet cash at approval time' }, { status: 400 });
    }
    logServerAction('admin.withdrawals.post', 'error', error);
    return NextResponse.json({ error: 'Approval failed' }, { status: 500 });
  }
}
