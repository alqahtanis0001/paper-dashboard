import { randomInt } from 'crypto';

const DEFAULT_FEE_BPS = 8;
const SPREAD_BPS = 0.0004;
const BASE_SLIPPAGE_BPS = 0.00005;

type Side = 'buy' | 'sell';

export function simulateExecution(midPrice: number, side: Side, regimeVolatility: number, feeBps = DEFAULT_FEE_BPS) {
  const safeMid = Number.isFinite(midPrice) && midPrice > 0 ? midPrice : 0;
  const vol = Math.max(0, regimeVolatility ?? 0);

  const spreadSigned = safeMid * SPREAD_BPS * (side === 'buy' ? 1 : -1);

  const volScale = Math.min(vol, 5);
  const slippageBps = BASE_SLIPPAGE_BPS + Math.random() * BASE_SLIPPAGE_BPS * 6 * volScale;
  const slippageSigned = safeMid * slippageBps * (side === 'buy' ? 1 : -1);

  const fillPrice = safeMid + spreadSigned + slippageSigned;
  const feeUsd = fillPrice * (Math.max(0, feeBps) / 10000);
  const latencyMs = randomInt(100, 601);

  return { fillPrice, feeUsd, slippageUsd: Math.abs(slippageSigned), latencyMs };
}
