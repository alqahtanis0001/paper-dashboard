import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getWallet } from '@/lib/wallet';
import { z } from 'zod';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';
import { computeWithdrawalBreakdown, ensureWithdrawConfig, parsePositiveMoney } from '@/lib/withdrawals';

const bodySchema = z.object({ amount: z.number().finite() });

const INSUFFICIENT_BALANCE_AR = 'تم رفض الطلب: المبلغ المطلوب أكبر من الرصيد المتاح في المحفظة.';

export async function GET(req: NextRequest) {
  logServerAction('withdraw.config', 'start');
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const wallet = await getWallet();
  const [pendingAggregate, config] = await Promise.all([
    prisma.withdrawalRequest.aggregate({
      where: { status: 'PENDING' },
      _sum: { amount: true },
    }),
    ensureWithdrawConfig(),
  ]);

  const reservedAmount = pendingAggregate._sum.amount ?? 0;
  const availableBalance = Math.max(0, wallet.cashBalance - reservedAmount);

  logServerAction('withdraw.config', 'success', {
    taxPercent: config.taxPercent,
    walletBalance: wallet.cashBalance,
    reservedAmount,
    availableBalance,
  });

  return NextResponse.json({
    taxPercent: config.taxPercent,
    walletBalance: wallet.cashBalance,
    reservedAmount,
    availableBalance,
  });
}

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
    return NextResponse.json({ error: 'قيمة السحب غير صحيحة.' }, { status: 400 });
  }

  const amount = parsePositiveMoney(parsed.data.amount);
  if (amount === null) {
    logServerAction('withdraw.request', 'warn', { reason: 'invalid_amount_value' });
    return NextResponse.json({ error: 'قيمة السحب يجب أن تكون رقمًا أكبر من صفر.' }, { status: 400 });
  }

  await getWallet();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst();
      if (!wallet) throw new Error('WALLET_NOT_FOUND');

      const pendingAggregate = await tx.withdrawalRequest.aggregate({
        where: { status: 'PENDING' },
        _sum: { amount: true },
      });
      const reservedAmount = pendingAggregate._sum.amount ?? 0;
      const availableBalance = Math.max(0, wallet.cashBalance - reservedAmount);
      if (amount > availableBalance + 0.000001) throw new Error('INSUFFICIENT_WITHDRAWABLE_BALANCE');

      const config = await ensureWithdrawConfig(tx);
      const breakdown = computeWithdrawalBreakdown(amount, config.taxPercent);
      const request = await tx.withdrawalRequest.create({
        data: {
          amount: breakdown.grossAmount,
          taxPercent: breakdown.taxPercent,
          taxAmount: breakdown.taxAmount,
          netAmount: breakdown.netAmount,
          status: 'PENDING',
        },
      });

      return {
        request,
        taxPercent: breakdown.taxPercent,
        availableBalance,
        walletBalance: wallet.cashBalance,
        reservedAmount,
      };
    });

    await logAuditEvent('withdrawal_requested', 'USER', {
      withdrawalId: result.request.id,
      amount: result.request.amount,
      taxPercent: result.request.taxPercent,
      taxAmount: result.request.taxAmount,
      netAmount: result.request.netAmount,
      status: result.request.status,
      walletBalance: result.walletBalance,
      reservedAmount: result.reservedAmount,
      availableBalance: result.availableBalance,
    });

    logServerAction('withdraw.request', 'success', {
      withdrawalId: result.request.id,
      amount: result.request.amount,
      taxPercent: result.taxPercent,
      availableBalance: result.availableBalance,
    });
    return NextResponse.json({ request: result.request });
  } catch (error) {
    if (error instanceof Error && error.message === 'INSUFFICIENT_WITHDRAWABLE_BALANCE') {
      logServerAction('withdraw.request', 'warn', { reason: 'insufficient_withdrawable_balance' });
      return NextResponse.json({ error: INSUFFICIENT_BALANCE_AR }, { status: 400 });
    }
    logServerAction('withdraw.request', 'error', error);
    return NextResponse.json({ error: 'تعذر إرسال طلب السحب.' }, { status: 500 });
  }
}
