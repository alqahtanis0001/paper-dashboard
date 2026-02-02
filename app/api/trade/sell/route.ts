import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';

export async function POST(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const wallet = await getWallet();
  const position = await prisma.position.findFirst({ where: { isOpen: true } });
  if (!position || !position.entryPrice || !position.sizeUsd) {
    return NextResponse.json({ error: 'No open position' }, { status: 400 });
  }

  const price = dealEngine.getCurrentPrice() || position.entryPrice;
  const qty = position.sizeUsd / position.entryPrice;
  const pnl = (price - position.entryPrice) * qty;

  await prisma.position.update({ where: { id: position.id }, data: { isOpen: false } });

  await prisma.trade.create({
    data: {
      symbol: position.symbol,
      side: 'SELL',
      price,
      sizeUsd: position.sizeUsd,
      pnl,
      walletId: wallet.id,
      dealId: position.metaDealId ?? dealEngine.getActiveDealId() ?? undefined,
    },
  });

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      cashBalance: wallet.cashBalance + position.sizeUsd + pnl,
      equity: wallet.equity + pnl,
      pnlTotal: wallet.pnlTotal + pnl,
    },
  });

  return NextResponse.json({ pnl, price });
}
