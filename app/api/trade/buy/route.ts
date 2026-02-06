import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';
import { dealEngine } from '@/lib/engine/dealEngine';
import { simulateExecution } from '@/lib/execution';
import { logAuditEvent } from '@/lib/audit';
import { logServerAction } from '@/lib/serverLogger';

async function getExecutionDeal() {
  const activeDealId = dealEngine.getActiveDealId();
  if (activeDealId) {
    const deal = await prisma.deal.findUnique({ where: { id: activeDealId } });
    if (deal) return deal;
  }
  return prisma.deal.findFirst({ where: { status: 'RUNNING' }, orderBy: { startTimeUtc: 'desc' } });
}

export async function POST(req: NextRequest) {
  logServerAction('trade.buy', 'start');
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const wallet = await getWallet();
  const { amountUsd } = await req.json().catch(() => ({}));
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    logServerAction('trade.buy', 'warn', { reason: 'invalid_amount' });
    return NextResponse.json({ error: 'amountUsd must be > 0' }, { status: 400 });
  }

  const open = await prisma.position.findFirst({ where: { isOpen: true } });
  if (open) {
    logServerAction('trade.buy', 'warn', { reason: 'position_already_open' });
    return NextResponse.json({ error: 'Position already open' }, { status: 400 });
  }

  const activeDeal = await getExecutionDeal();
  const symbol = activeDeal?.symbol ?? 'MARKET';
  const midPrice = dealEngine.getCurrentPrice() || activeDeal?.basePrice || 100;
  const regimeVolatility = dealEngine.getRegimeVolatility();

  const { fillPrice, feeUsd: unitFeeUsd, slippageUsd: unitSlippageUsd, latencyMs } = simulateExecution(midPrice, 'buy', regimeVolatility);
  const quantity = amountUsd / fillPrice;
  const feeUsd = unitFeeUsd * quantity;
  const slippageUsd = unitSlippageUsd * quantity;
  const pendingAggregate = await prisma.withdrawalRequest.aggregate({
    where: { status: 'PENDING' },
    _sum: { amount: true },
  });
  const reservedWithdrawalAmount = pendingAggregate._sum.amount ?? 0;
  const availableCashForTrading = Math.max(0, wallet.cashBalance - reservedWithdrawalAmount);

  if (availableCashForTrading < amountUsd + feeUsd) {
    logServerAction('trade.buy', 'warn', {
      reason: 'cash_reserved_for_withdrawals',
      reservedWithdrawalAmount,
      availableCashForTrading,
    });
    return NextResponse.json({ error: 'amountUsd exceeds wallet cash after fees' }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const position = await tx.position.create({
        data: {
          isOpen: true,
          symbol,
          entryPrice: fillPrice,
          entryTime: new Date(),
          sizeUsd: amountUsd,
          walletId: wallet.id,
          metaDealId: activeDeal?.id ?? undefined,
        },
      });

      const trade = await tx.trade.create({
        data: {
          symbol,
          side: 'BUY',
          price: fillPrice,
          fillPrice,
          feeUsd,
          slippageUsd,
          latencyMs,
          sizeUsd: amountUsd,
          walletId: wallet.id,
          dealId: activeDeal?.id ?? undefined,
        },
      });

      const updatedWallet = await tx.wallet.update({ where: { id: wallet.id }, data: { cashBalance: { decrement: amountUsd + feeUsd } } });
      return { position, updatedWallet, trade };
    });

    await logAuditEvent('trade_buy_executed', 'USER', {
      amountUsd,
      fillPrice,
      feeUsd,
      slippageUsd,
      latencyMs,
      tradeId: result.trade.id,
      symbol,
      dealId: activeDeal?.id ?? null,
    });

    logServerAction('trade.buy', 'success', { tradeId: result.trade.id, symbol });
    return NextResponse.json({ position: result.position, trade: result.trade, wallet: result.updatedWallet });
  } catch (err) {
    logServerAction('trade.buy', 'error', err);
    return NextResponse.json({ error: 'Trade failed' }, { status: 500 });
  }
}
