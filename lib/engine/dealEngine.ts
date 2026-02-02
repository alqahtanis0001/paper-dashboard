import { Deal, DealJump } from '@prisma/client';
import { prisma } from '../prisma';
import { buildSignals, aggregateSignals } from '../ai';
import { getIO } from '../socketServer';

type Candle = {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

class DealEngine {
  private watcher: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private candleTimer: NodeJS.Timeout | null = null;
  private currentDeal: Deal | null = null;
  private price = 0;
  private startTime = 0;
  private candles: Candle[] = [];
  private volumes: number[] = [];

  constructor() {
    this.startWatcher();
  }

  private log(msg: string) {
    if (process.env.NODE_ENV !== 'production') console.log('[DealEngine]', msg);
  }

  private startWatcher() {
    if (this.watcher) return;
    this.watcher = setInterval(() => this.checkDeals(), 5000);
    this.checkDeals();
  }

  private async checkDeals() {
    if (this.currentDeal) return;
    const now = new Date();
    const deal = await prisma.deal.findFirst({
      where: { status: 'SCHEDULED', startTimeUtc: { lte: now } },
      include: { jumps: { orderBy: { orderIndex: 'asc' } } },
      orderBy: { startTimeUtc: 'asc' },
    });
    if (deal) {
      await prisma.deal.update({ where: { id: deal.id }, data: { status: 'RUNNING' } });
      this.runDeal(deal);
    }
  }

  async runDeal(deal: Deal & { jumps: DealJump[] }) {
    if (this.currentDeal) return;
    this.currentDeal = deal;
    this.price = deal.basePrice;
    this.startTime = Date.now();
    this.candles = [];
    this.volumes = [];

    const io = getIO();
    io?.emit('meta_status', { text: 'Scanning markets...', stage: 'scanning' });

    setTimeout(() => {
      io?.emit('market_selected', {
        symbol: deal.symbol,
        chainName: deal.chainName,
        basePrice: deal.basePrice,
        startTime: deal.startTimeUtc,
      });
      io?.emit('meta_status', { text: `Trade identified: ${deal.symbol} (${deal.chainName})`, stage: 'identified' });
    }, 1000);

    this.tickTimer = setInterval(() => this.generateTick(deal), 200);
    this.candleTimer = setInterval(() => this.emitSignals(deal), 1000);

    setTimeout(() => this.finishDeal(), deal.totalDurationSec * 1000);
  }

  private computeScenarioPrice(deal: Deal & { jumps: DealJump[] }, elapsedSec: number) {
    const base = deal.basePrice;
    let biasPct = 0;

    // drop
    if (elapsedSec >= deal.dropDelaySec) {
      const prog = Math.min((elapsedSec - deal.dropDelaySec) / 4, 1);
      biasPct -= deal.dropMagnitudePct * prog;
    }

    // rises
    for (const jump of deal.jumps) {
      const phase = elapsedSec - jump.riseDelaySec;
      if (phase < 0) continue;
      if (phase <= 3) {
        const ramp = Math.min(phase / 3, 1);
        biasPct += jump.riseMagnitudePct * ramp;
      } else if (phase <= jump.holdSec + 3) {
        biasPct += jump.riseMagnitudePct;
      } else {
        const decay = Math.min((phase - jump.holdSec - 3) / 5, 1);
        biasPct += jump.riseMagnitudePct * Math.max(1 - decay, 0);
      }
    }

    const noise = base * 0.002 * (Math.random() - 0.5);
    return base * (1 + biasPct / 100) + noise;
  }

  private generateTick(deal: Deal & { jumps: DealJump[] }) {
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    const price = this.computeScenarioPrice(deal, elapsedSec);
    const lastCandle = this.candles[this.candles.length - 1];
    const now = Date.now();
    if (!lastCandle || now - lastCandle.time >= 1000) {
      this.candles.push({
        time: now,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Math.random() * 100 + 50,
      });
    } else {
      lastCandle.high = Math.max(lastCandle.high, price);
      lastCandle.low = Math.min(lastCandle.low, price);
      lastCandle.close = price;
      lastCandle.volume += Math.random() * 20;
    }
    this.price = price;
    const io = getIO();
    io?.emit('price_tick', { timestamp: now, price, candle: this.candles[this.candles.length - 1] });
  }

  private emitSignals(deal: Deal & { jumps: DealJump[] }) {
    const prices = this.candles.map((c) => c.close);
    if (prices.length < 5) return;
    const signals = buildSignals(prices, this.candles.map((c) => c.volume));
    const meta = aggregateSignals(signals);

    const io = getIO();
    io?.emit('ai_signals', { signals, meta });
    io?.emit('deal_state', { status: 'RUNNING', dealId: deal.id });

    // Optionally persist logs
    prisma.aiSignalLog
      .create({
        data: {
          dealId: deal.id,
          signalsJson: signals as unknown as object,
          metaDecisionJson: meta as unknown as object,
        },
      })
      .catch(() => null);
  }

  private async finishDeal() {
    if (!this.currentDeal) return;
    const dealId = this.currentDeal.id;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.candleTimer) clearInterval(this.candleTimer);
    this.tickTimer = null;
    this.candleTimer = null;
    await prisma.deal.update({ where: { id: dealId }, data: { status: 'FINISHED' } }).catch(() => null);
    const io = getIO();
    io?.emit('deal_state', { status: 'FINISHED', dealId });
    this.currentDeal = null;
  }

  getCurrentPrice() {
    return this.price || this.currentDeal?.basePrice || 0;
  }

  getActiveDealId() {
    return this.currentDeal?.id ?? null;
  }
}

// singleton
const globalEngine = (globalThis as unknown as { dealEngine?: DealEngine });
export const dealEngine = globalEngine.dealEngine ?? new DealEngine();
if (!globalEngine.dealEngine) globalEngine.dealEngine = dealEngine;
