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
  const { sellPercent } = await req.json().catch(() => ({}));

  if (typeof sellPercent !== 'number' || Number.isNaN(sellPercent) || !Number.isFinite(sellPercent)) {
    return NextResponse.json({ error: 'sellPercent must be a number' }, { status: 400 });
  }
  if (sellPercent <= 0 || sellPercent > 100) {
    return NextResponse.json({ error: 'sellPercent must be between 0 and 100' }, { status: 400 });
  }

  const position = await prisma.position.findFirst({ where: { isOpen: true } });
  if (!position || !position.entryPrice || !position.sizeUsd) {
    return NextResponse.json({ error: 'No open position' }, { status: 400 });
  }

  const price = dealEngine.getCurrentPrice() || position.entryPrice;
  const fraction = sellPercent / 100;
  const qtyTotal = position.sizeUsd / position.entryPrice;
  const qtyToSell = qtyTotal * fraction;
  const proceeds = qtyToSell * price;
  const pnl = (price - position.entryPrice) * qtyToSell;
  const remainingSizeUsd = position.sizeUsd * (1 - fraction);
  const soldSizeUsd = position.sizeUsd * fraction;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.trade.create({
        data: {
          symbol: position.symbol,
          side: 'SELL',
          price,
          sizeUsd: soldSizeUsd,
          pnl,
          walletId: wallet.id,
          dealId: position.metaDealId ?? dealEngine.getActiveDealId() ?? undefined,
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          cashBalance: { increment: proceeds },
          equity: { increment: pnl },
          pnlTotal: { increment: pnl },
        },
      });

      await tx.position.update({
        where: { id: position.id },
        data: {
          isOpen: fraction >= 1 ? false : true,
          sizeUsd: fraction >= 1 ? 0 : remainingSizeUsd,
        },
      });
    });

    return NextResponse.json({ pnl, price });
  } catch (err) {
    console.error('SELL transaction failed', err);
    return NextResponse.json({ error: 'Trade failed' }, { status: 500 });
  }
}
