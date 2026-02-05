import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';
import { simulateExecution } from '@/lib/execution';

export async function POST(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const wallet = await getWallet();

  const { amountUsd, midPrice, regimeVolatility } = await req.json().catch(() => ({}));
  if (typeof amountUsd !== 'number' || Number.isNaN(amountUsd) || !Number.isFinite(amountUsd)) {
    return NextResponse.json({ error: 'amountUsd must be a number' }, { status: 400 });
  }
  if (amountUsd <= 0) {
    return NextResponse.json({ error: 'amountUsd must be greater than 0' }, { status: 400 });
  }

  const open = await prisma.position.findFirst({ where: { isOpen: true } });
  if (open) return NextResponse.json({ error: 'Position already open' }, { status: 400 });

  const fallbackMid = dealEngine.getCurrentPrice() || 100;
  const effectiveMid =
    typeof midPrice === 'number' && Number.isFinite(midPrice) && midPrice > 0 ? midPrice : fallbackMid;
  const vol =
    typeof regimeVolatility === 'number' && Number.isFinite(regimeVolatility) && regimeVolatility >= 0
      ? regimeVolatility
      : 0.5;

  const { fillPrice, feeUsd: unitFeeUsd, slippageUsd: unitSlippageUsd, latencyMs } = simulateExecution(
    effectiveMid,
    'buy',
    vol
  );

  const quantity = amountUsd / fillPrice;
  const feeUsd = unitFeeUsd * quantity;
  const slippageUsd = unitSlippageUsd * quantity;

  const activeDealId = dealEngine.getActiveDealId();

  if (wallet.cashBalance < amountUsd + feeUsd) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const position = await tx.position.create({
        data: {
          isOpen: true,
          symbol: 'SCENARIO',
          entryPrice: fillPrice,
          entryTime: new Date(),
          sizeUsd: amountUsd,
          walletId: wallet.id,
          metaDealId: activeDealId ?? undefined,
        },
      });

      const trade = await tx.trade.create({
        data: {
          symbol: position.symbol,
          side: 'BUY',
          price: fillPrice,
          fillPrice,
          feeUsd,
          slippageUsd,
          latencyMs,
          sizeUsd: amountUsd,
          walletId: wallet.id,
          dealId: activeDealId ?? undefined,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { cashBalance: { decrement: amountUsd + feeUsd } },
      });

      return { position, wallet: updatedWallet, trade };
    });

    return NextResponse.json({
      position: result.position,
      price: fillPrice,
      feeUsd,
      slippageUsd,
      latencyMs,
    });
  } catch (err) {
    console.error('BUY transaction failed', err);
    return NextResponse.json({ error: 'Trade failed' }, { status: 500 });
  }
}
