import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';

export async function GET(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const wallet = await getWallet();
  const openPosition = await prisma.position.findFirst({ where: { isOpen: true } });
  const trades = await prisma.trade.findMany({ orderBy: { time: 'desc' }, take: 20 });

  let positionValue = 0;
  let unrealizedPnl = 0;
  if (openPosition?.entryPrice && openPosition.sizeUsd) {
    const quantity = openPosition.sizeUsd / openPosition.entryPrice;
    const currentPrice = dealEngine.getCurrentPrice() || openPosition.entryPrice;
    positionValue = quantity * currentPrice;
    unrealizedPnl = positionValue - openPosition.sizeUsd;
  }

  const liveEquity = wallet.cashBalance + positionValue;

  return NextResponse.json({
    wallet: {
      ...wallet,
      equity: liveEquity,
      liveEquity,
      positionValue,
      unrealizedPnl,
    },
    openPosition,
    trades,
    positionValue,
    unrealizedPnl,
    liveEquity,
  });
}
