import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';
import { ensureWithdrawConfig } from '@/lib/withdrawals';

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

  const [requests, withdrawConfig] = await Promise.all([
    prisma.withdrawalRequest.findMany({
      orderBy: { time: 'desc' },
    }),
    ensureWithdrawConfig(),
  ]);
  logServerAction('admin.withdrawals.get', 'success', { count: requests.length, taxPercent: withdrawConfig.taxPercent });
  return NextResponse.json({ requests, taxPercent: withdrawConfig.taxPercent });
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

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingRequest = await tx.withdrawalRequest.findUnique({
        where: { id: parsed.data.id },
      });
      if (!existingRequest) throw new Error('NOT_FOUND');
      if (existingRequest.status !== 'PENDING') throw new Error('ALREADY_PROCESSED');

      if (parsed.data.action === 'REJECT') {
        const updateResult = await tx.withdrawalRequest.updateMany({
          where: { id: existingRequest.id, status: 'PENDING' },
          data: { status: 'REJECTED', processedAt: new Date() },
        });
        if (updateResult.count !== 1) throw new Error('ALREADY_PROCESSED');

        const updatedRequest = await tx.withdrawalRequest.findUnique({
          where: { id: existingRequest.id },
        });
        if (!updatedRequest) throw new Error('NOT_FOUND');

        return { updatedRequest, updatedWallet: null };
      }

      const wallet = await tx.wallet.findFirst();
      if (!wallet) throw new Error('WALLET_NOT_FOUND');
      if (wallet.cashBalance < existingRequest.amount) throw new Error('INSUFFICIENT_CASH');

      const updateResult = await tx.withdrawalRequest.updateMany({
        where: { id: existingRequest.id, status: 'PENDING' },
        data: { status: 'APPROVED', processedAt: new Date() },
      });
      if (updateResult.count !== 1) throw new Error('ALREADY_PROCESSED');

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { cashBalance: { decrement: existingRequest.amount } },
      });
      const updatedRequest = await tx.withdrawalRequest.findUnique({
        where: { id: existingRequest.id },
      });
      if (!updatedRequest) throw new Error('NOT_FOUND');

      return { updatedRequest, updatedWallet };
    });

    if (parsed.data.action === 'REJECT') {
      await logAuditEvent('withdrawal_rejected', 'ADMIN', {
        withdrawalId: result.updatedRequest.id,
        amount: result.updatedRequest.amount,
        taxPercent: result.updatedRequest.taxPercent,
        taxAmount: result.updatedRequest.taxAmount,
        netAmount: result.updatedRequest.netAmount,
        status: result.updatedRequest.status,
        processedAt: result.updatedRequest.processedAt?.toISOString() ?? null,
      });
      logServerAction('admin.withdrawals.post', 'success', {
        action: 'REJECT',
        withdrawalId: result.updatedRequest.id,
      });
      return NextResponse.json({ request: result.updatedRequest });
    }

    await logAuditEvent('withdrawal_approved', 'ADMIN', {
      withdrawalId: result.updatedRequest.id,
      amount: result.updatedRequest.amount,
      taxPercent: result.updatedRequest.taxPercent,
      taxAmount: result.updatedRequest.taxAmount,
      netAmount: result.updatedRequest.netAmount,
      status: result.updatedRequest.status,
      processedAt: result.updatedRequest.processedAt?.toISOString() ?? null,
      walletCashBalance: result.updatedWallet?.cashBalance ?? null,
    });

    logServerAction('admin.withdrawals.post', 'success', {
      action: 'APPROVE',
      withdrawalId: result.updatedRequest.id,
      walletCashBalance: result.updatedWallet?.cashBalance ?? null,
    });
    return NextResponse.json({ request: result.updatedRequest, wallet: result.updatedWallet });
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      logServerAction('admin.withdrawals.post', 'warn', { reason: 'not_found', withdrawalId: parsed.data.id });
      return NextResponse.json({ error: 'Withdrawal request not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'ALREADY_PROCESSED') {
      logServerAction('admin.withdrawals.post', 'warn', { reason: 'already_processed', withdrawalId: parsed.data.id });
      return NextResponse.json({ error: 'Request already processed' }, { status: 409 });
    }
    if (error instanceof Error && error.message === 'INSUFFICIENT_CASH') {
      logServerAction('admin.withdrawals.post', 'warn', { reason: 'insufficient_cash', withdrawalId: parsed.data.id });
      return NextResponse.json({ error: 'Insufficient wallet cash at approval time' }, { status: 400 });
    }
    logServerAction('admin.withdrawals.post', 'error', error);
    return NextResponse.json({ error: 'Approval failed' }, { status: 500 });
  }
}
