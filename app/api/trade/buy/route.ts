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

  const { amountUsd } = await req.json().catch(() => ({}));
  if (typeof amountUsd !== 'number' || Number.isNaN(amountUsd) || !Number.isFinite(amountUsd)) {
    return NextResponse.json({ error: 'amountUsd must be a number' }, { status: 400 });
  }
  if (amountUsd <= 0) {
    return NextResponse.json({ error: 'amountUsd must be greater than 0' }, { status: 400 });
  }

  const open = await prisma.position.findFirst({ where: { isOpen: true } });
  if (open) return NextResponse.json({ error: 'Position already open' }, { status: 400 });

  const price = dealEngine.getCurrentPrice() || 100;
  const activeDealId = dealEngine.getActiveDealId();

  if (wallet.cashBalance < amountUsd) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const position = await tx.position.create({
        data: {
          isOpen: true,
          symbol: 'SCENARIO',
          entryPrice: price,
          entryTime: new Date(),
          sizeUsd: amountUsd,
          walletId: wallet.id,
          metaDealId: activeDealId ?? undefined,
        },
      });

      await tx.trade.create({
        data: {
          symbol: position.symbol,
          side: 'BUY',
          price,
          sizeUsd: amountUsd,
          walletId: wallet.id,
          dealId: activeDealId ?? undefined,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { cashBalance: { decrement: amountUsd } },
      });

      return { position, wallet: updatedWallet };
    });

    return NextResponse.json({ position: result.position, price });
  } catch (err) {
    console.error('BUY transaction failed', err);
    return NextResponse.json({ error: 'Trade failed' }, { status: 500 });
  }
}
