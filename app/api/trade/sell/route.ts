import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';
import { simulateExecution } from '@/lib/execution';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

export async function POST(req: NextRequest) {
  logServerAction('trade.sell', 'start');
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const wallet = await getWallet();
  const { sellPercent } = await req.json().catch(() => ({}));
  if (typeof sellPercent !== 'number' || !Number.isFinite(sellPercent) || sellPercent <= 0 || sellPercent > 100) {
    logServerAction('trade.sell', 'warn', { reason: 'invalid_sell_percent' });
    return NextResponse.json({ error: 'sellPercent must be between 0 and 100' }, { status: 400 });
  }

  const position = await prisma.position.findFirst({ where: { isOpen: true } });
  if (!position || !position.entryPrice || !position.sizeUsd) {
    logServerAction('trade.sell', 'warn', { reason: 'no_open_position' });
    return NextResponse.json({ error: 'No open position' }, { status: 400 });
  }

  const midPrice = dealEngine.getCurrentPrice() || position.entryPrice;
  const regimeVolatility = dealEngine.getRegimeVolatility();
  const rules = dealEngine.getTradingRules();

  const fraction = sellPercent / 100;
  const qtyTotal = position.sizeUsd / position.entryPrice;
  const qtyToSell = qtyTotal * fraction;
  const { fillPrice, feeUsd: unitFeeUsd, slippageUsd: unitSlippageUsd, latencyMs } = simulateExecution(midPrice, 'sell', regimeVolatility, rules.feeBps);

  const proceeds = qtyToSell * fillPrice;
  const feeUsd = unitFeeUsd * qtyToSell;
  const pnl = (fillPrice - position.entryPrice) * qtyToSell - feeUsd;
  const slippageUsd = unitSlippageUsd * qtyToSell;
  const remainingSizeUsd = position.sizeUsd * (1 - fraction);
  const soldSizeUsd = position.sizeUsd * fraction;

  if (soldSizeUsd < rules.minNotionalUsd) {
    return NextResponse.json({ error: `sell notional must be >= ${rules.minNotionalUsd}` }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const trade = await tx.trade.create({
        data: {
          symbol: position.symbol,
          side: 'SELL',
          price: fillPrice,
          fillPrice,
          feeUsd,
          slippageUsd,
          latencyMs,
          sizeUsd: soldSizeUsd,
          pnl,
          walletId: wallet.id,
          dealId: position.metaDealId ?? dealEngine.getActiveDealId() ?? undefined,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          cashBalance: { increment: proceeds - feeUsd },
          pnlTotal: { increment: pnl },
        },
      });

      const updatedPosition = await tx.position.update({
        where: { id: position.id },
        data: {
          isOpen: fraction >= 1 ? false : true,
          sizeUsd: fraction >= 1 ? 0 : remainingSizeUsd,
        },
      });

      return { trade, updatedWallet, updatedPosition };
    });

    await logAuditEvent('trade_sell_executed', 'USER', {
      sellPercent,
      soldSizeUsd,
      fillPrice,
      feeUsd,
      slippageUsd,
      latencyMs,
      pnl,
      tradeId: result.trade.id,
      symbol: position.symbol,
      dealId: position.metaDealId ?? dealEngine.getActiveDealId() ?? null,
    });

    logServerAction('trade.sell', 'success', { tradeId: result.trade.id, symbol: position.symbol });
    return NextResponse.json({ trade: result.trade, wallet: result.updatedWallet, position: result.updatedPosition });
  } catch (err) {
    logServerAction('trade.sell', 'error', err);
    return NextResponse.json({ error: 'Trade failed' }, { status: 500 });
  }
}
