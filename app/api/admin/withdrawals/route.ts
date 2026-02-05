import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';

const bodySchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['APPROVE', 'REJECT']),
});

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const requests = await prisma.withdrawalRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { time: 'asc' },
  });
  return NextResponse.json({ requests });
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const request = await prisma.withdrawalRequest.findUnique({ where: { id: parsed.data.id } });
  if (!request) return NextResponse.json({ error: 'Withdrawal request not found' }, { status: 404 });
  if (request.status !== 'PENDING') {
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

    return NextResponse.json({ request: result.updatedRequest, wallet: result.updatedWallet });
  } catch (error) {
    if (error instanceof Error && error.message === 'INSUFFICIENT_CASH') {
      return NextResponse.json({ error: 'Insufficient wallet cash at approval time' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Approval failed' }, { status: 500 });
  }
}
