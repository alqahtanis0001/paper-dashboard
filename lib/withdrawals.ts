import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

const CONFIG_ID = 'global';
const DEFAULT_WITHDRAW_TAX_PERCENT = 5;
const CURRENCY_PRECISION = 100;

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * CURRENCY_PRECISION) / CURRENCY_PRECISION;
}

type PrismaLikeClient = Prisma.TransactionClient | typeof prisma;

export async function ensureWithdrawConfig(db: PrismaLikeClient = prisma) {
  const existing = await db.withdrawConfig.findUnique({
    where: { id: CONFIG_ID },
  });
  if (existing) return existing;

  try {
    return await db.withdrawConfig.create({
      data: {
        id: CONFIG_ID,
        taxPercent: DEFAULT_WITHDRAW_TAX_PERCENT,
      },
    });
  } catch {
    const row = await db.withdrawConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    if (row) return row;
    throw new Error('WITHDRAW_CONFIG_INIT_FAILED');
  }
}

export function normalizeTaxPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return roundCurrency(value);
}

export function computeWithdrawalBreakdown(amount: number, rawTaxPercent: number) {
  const taxPercent = normalizeTaxPercent(rawTaxPercent);
  const grossAmount = roundCurrency(amount);
  const taxAmount = roundCurrency((grossAmount * taxPercent) / 100);
  const netAmount = roundCurrency(Math.max(0, grossAmount - taxAmount));

  return {
    taxPercent,
    grossAmount,
    taxAmount,
    netAmount,
  };
}

export function parsePositiveMoney(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = roundCurrency(value);
  if (rounded <= 0) return null;
  if (rounded > 1_000_000_000) return null;
  return rounded;
}
