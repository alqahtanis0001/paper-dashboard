import { prisma } from './prisma';

const DEFAULT_BALANCE = 10000;
const DEFAULT_SIZE_USD = 1000;

export async function ensureWallet() {
  const wallet = await prisma.wallet.findFirst();
  if (wallet) return wallet;
  return prisma.wallet.create({
    data: {
      cashBalance: DEFAULT_BALANCE,
      equity: DEFAULT_BALANCE,
      pnlTotal: 0,
    },
  });
}

export async function getWallet() {
  return ensureWallet();
}

export function defaultTradeSize() {
  return DEFAULT_SIZE_USD;
}
