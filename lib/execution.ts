import { randomInt } from 'crypto';

// Constants for fees and spread
const MAKER_FEE = 0.0002; // 0.02%
const TAKER_FEE = 0.0005; // 0.05%
const SPREAD = 0.01; // 1% spread

export function simulateExecution(midPrice: number, side: 'buy' | 'sell', regimeVolatility: number) {
    // Calculate spread
    const spread = side === 'buy' ? midPrice * (1 + SPREAD) : midPrice * (1 - SPREAD);

    // Calculate slippage
    const slippage = (Math.random() * regimeVolatility) * (side === 'buy' ? 1 : -1);

    // Calculate fill price
    const fillPrice = spread + slippage;

    // Calculate fees
    const feeUsd = side === 'buy' ? fillPrice * MAKER_FEE : fillPrice * TAKER_FEE;

    // Simulate latency
    const latencyMs = randomInt(100, 601); // Random latency between 100ms and 600ms

    return { fillPrice, feeUsd, slippageUsd: Math.abs(slippage), latencyMs };
}