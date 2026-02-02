import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession } from '@/lib/auth';
import { defaultTradeSize, getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';

export async function POST(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const wallet = await getWallet();
  const open = await prisma.position.findFirst({ where: { isOpen: true } });
  if (open) return NextResponse.json({ error: 'Position already open' }, { status: 400 });

  const price = dealEngine.getCurrentPrice() || 100;
  const activeDealId = dealEngine.getActiveDealId();
  const sizeUsd = defaultTradeSize();

  if (wallet.cashBalance < sizeUsd) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
  }

  const position = await prisma.position.create({
    data: {
      isOpen: true,
      symbol: 'SCENARIO',
      entryPrice: price,
      entryTime: new Date(),
      sizeUsd,
      walletId: wallet.id,
      metaDealId: activeDealId ?? undefined,
    },
  });

  await prisma.trade.create({
    data: {
      symbol: position.symbol,
      side: 'BUY',
      price,
      sizeUsd,
      walletId: wallet.id,
      dealId: activeDealId ?? undefined,
    },
  });

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { cashBalance: wallet.cashBalance - sizeUsd, equity: wallet.equity },
  });

  return NextResponse.json({ position, price });
}
