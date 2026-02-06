import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';
import { logServerAction } from '@/lib/serverLogger';
import { ensureWithdrawConfig } from '@/lib/withdrawals';

export async function GET(req: NextRequest) {
  logServerAction('wallet.get', 'start');
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const wallet = await getWallet();
  const [openPosition, trades, pendingAggregate, withdrawConfig] = await Promise.all([
    prisma.position.findFirst({ where: { isOpen: true } }),
    prisma.trade.findMany({ orderBy: { time: 'desc' }, take: 20 }),
    prisma.withdrawalRequest.aggregate({
      where: { status: 'PENDING' },
      _sum: { amount: true },
    }),
    ensureWithdrawConfig(),
  ]);

  let positionValue = 0;
  let unrealizedPnl = 0;
  if (openPosition?.entryPrice && openPosition.sizeUsd) {
    const quantity = openPosition.sizeUsd / openPosition.entryPrice;
    const currentPrice = dealEngine.getCurrentPrice() || openPosition.entryPrice;
    positionValue = quantity * currentPrice;
    unrealizedPnl = positionValue - openPosition.sizeUsd;
  }

  const liveEquity = wallet.cashBalance + positionValue;
  const reservedWithdrawalAmount = pendingAggregate._sum.amount ?? 0;
  const withdrawableBalance = Math.max(0, wallet.cashBalance - reservedWithdrawalAmount);

  logServerAction('wallet.get', 'success', {
    hasOpenPosition: !!openPosition,
    tradesCount: trades.length,
    taxPercent: withdrawConfig.taxPercent,
    withdrawableBalance,
  });
  return NextResponse.json({
    wallet: {
      ...wallet,
      equity: liveEquity,
      liveEquity,
      positionValue,
      unrealizedPnl,
      withdrawTaxPercent: withdrawConfig.taxPercent,
      reservedWithdrawalAmount,
      withdrawableBalance,
    },
    openPosition,
    trades,
    positionValue,
    unrealizedPnl,
    liveEquity,
    withdrawTaxPercent: withdrawConfig.taxPercent,
    reservedWithdrawalAmount,
    withdrawableBalance,
  });
}
