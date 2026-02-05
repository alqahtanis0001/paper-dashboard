import { Deal, DealJump } from '@prisma/client';
import { prisma } from '../prisma';
import { buildSignals, aggregateSignals, type ModelSignal } from '../ai';
import { getIO } from '../socketServer';

type Candle = {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type MarketRegime = 'TRENDING' | 'CHOPPY' | 'HIGH_VOL' | 'LOW_VOL';

type RegimeState = {
  kind: MarketRegime;
  driftBpsPerSec: number;
  noiseBps: number;
  wickBps: number;
  volumeBase: number;
  volumeJitter: number;
  meanRevert: number;
  trendDirection?: 1 | -1;
};

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

class DealEngine {
  private watcher: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private candleTimer: NodeJS.Timeout | null = null;
  private currentDeal: Deal | null = null;
  private price = 0;
  private startTime = 0;
  private candles: Candle[] = [];
  private volumes: number[] = [];
  private regime: RegimeState | null = null;
  private nextRegimeSwitch = 0;
  private lastTickAt = 0;
  private signalOutcomes: { id: string; time: number; price: number; action: 'BUY' | 'SELL' | 'NO_TRADE'; horizonSec: number }[] = [];

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
    try {
      const deal = await prisma.deal.findFirst({
        where: { status: 'SCHEDULED', startTimeUtc: { lte: now } },
        include: { jumps: { orderBy: { orderIndex: 'asc' } } },
        orderBy: { startTimeUtc: 'asc' },
      });
      if (deal) {
        await prisma.deal.update({ where: { id: deal.id }, data: { status: 'RUNNING' } });
        this.runDeal(deal);
      }
    } catch (err: unknown) {
      // If tables are not ready (P2021) or connection issue, skip and retry on next tick
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[DealEngine] checkDeals skipped due to error:', code ?? (err instanceof Error ? err.message : err));
      }
    }
  }

  async runDeal(deal: Deal & { jumps: DealJump[] }) {
    if (this.currentDeal) return;
    this.currentDeal = deal;
    this.price = deal.basePrice;
    this.startTime = Date.now();
    this.candles = [];
    this.volumes = [];
    this.lastTickAt = Date.now();
    this.scheduleRegime();

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

    const noise = base * 0.0006 * (Math.random() - 0.5);
    return base * (1 + biasPct / 100) + noise;
  }

  private pickRegime(prev?: RegimeState | null): RegimeState {
    const pool: { kind: MarketRegime; weight: number }[] = [
      { kind: 'TRENDING', weight: 0.32 },
      { kind: 'CHOPPY', weight: 0.28 },
      { kind: 'HIGH_VOL', weight: 0.22 },
      { kind: 'LOW_VOL', weight: 0.18 },
    ];
    const total = pool.reduce((sum, r) => sum + r.weight, 0);
    let roll = Math.random() * total;
    let chosen: MarketRegime = pool[0].kind;
    for (const regime of pool) {
      roll -= regime.weight;
      if (roll <= 0) {
        chosen = regime.kind;
        break;
      }
    }

    // Nudge away from repeating the exact same regime too often
    if (prev && prev.kind === chosen && Math.random() < 0.45) {
      const alt = pool.filter((r) => r.kind !== prev.kind);
      chosen = alt[Math.floor(Math.random() * alt.length)].kind;
    }

    switch (chosen) {
      case 'TRENDING': {
        const direction =
          prev?.kind === 'TRENDING' && prev.trendDirection && Math.random() < 0.55
            ? prev.trendDirection
            : Math.random() < 0.5
              ? -1
              : 1;
        return {
          kind: 'TRENDING',
          driftBpsPerSec: randomBetween(2.5, 6.5),
          noiseBps: randomBetween(6, 14),
          wickBps: randomBetween(12, 26),
          volumeBase: randomBetween(110, 190),
          volumeJitter: randomBetween(40, 90),
          meanRevert: 0.12,
          trendDirection: direction,
        };
      }
      case 'HIGH_VOL':
        return {
          kind: 'HIGH_VOL',
          driftBpsPerSec: randomBetween(-0.6, 0.6),
          noiseBps: randomBetween(18, 40),
          wickBps: randomBetween(30, 70),
          volumeBase: randomBetween(160, 260),
          volumeJitter: randomBetween(70, 140),
          meanRevert: 0.18,
        };
      case 'CHOPPY':
        return {
          kind: 'CHOPPY',
          driftBpsPerSec: randomBetween(-0.4, 0.4),
          noiseBps: randomBetween(8, 18),
          wickBps: randomBetween(10, 20),
          volumeBase: randomBetween(70, 140),
          volumeJitter: randomBetween(30, 70),
          meanRevert: 0.28,
        };
      case 'LOW_VOL':
      default:
        return {
          kind: 'LOW_VOL',
          driftBpsPerSec: randomBetween(-0.2, 0.2),
          noiseBps: randomBetween(2, 6),
          wickBps: randomBetween(6, 12),
          volumeBase: randomBetween(35, 80),
          volumeJitter: randomBetween(14, 40),
          meanRevert: 0.34,
        };
    }
  }

  private scheduleRegime(now: number = Date.now()) {
    this.regime = this.pickRegime(this.regime);
    this.nextRegimeSwitch = now + randomBetween(12000, 24000);
    this.log(`Regime -> ${this.regime.kind}`);
  }

  private maybeRotateRegime(now: number) {
    if (!this.regime || now >= this.nextRegimeSwitch || Math.random() < 0.003) {
      this.scheduleRegime(now);
    }
  }

  private generateTick(deal: Deal & { jumps: DealJump[] }) {
    const now = Date.now();
    const elapsedSec = (now - this.startTime) / 1000;
    this.maybeRotateRegime(now);

    const anchorPrice = this.computeScenarioPrice(deal, elapsedSec);
    const prevPrice = this.price || anchorPrice;
    const dtSec = Math.max((now - (this.lastTickAt || now)) / 1000, 0.05);
    this.lastTickAt = now;

    const regime = this.regime ?? this.pickRegime();
    const driftDirection = regime.kind === 'TRENDING' ? regime.trendDirection ?? 1 : 1;
    const driftTerm = anchorPrice * ((regime.driftBpsPerSec * driftDirection * dtSec) / 10000);
    const noiseScale = Math.sqrt(dtSec * 4);
    const noiseTerm = anchorPrice * (regime.noiseBps / 10000) * (Math.random() - 0.5) * 2 * noiseScale;
    const pullTerm = (anchorPrice - prevPrice) * regime.meanRevert * Math.min(dtSec * 1.1, 1);

    const unclampedPrice = prevPrice + pullTerm + driftTerm + noiseTerm;
    const maxJump = Math.max(prevPrice * 0.25, anchorPrice * 0.1);
    const boundedPrice = Math.min(Math.max(unclampedPrice, prevPrice - maxJump), prevPrice + maxJump);
    const price = Math.max(anchorPrice * 0.2, boundedPrice);

    const wickSwing =
      (regime.wickBps / 10000) *
      (Math.random() - 0.5) *
      2 *
      (Math.random() < (regime.kind === 'HIGH_VOL' ? 0.6 : 0.35) ? 3 : 1.5);
    const wickPrice = Math.max(anchorPrice * 0.15, price * (1 + wickSwing));

    const lastCandle = this.candles[this.candles.length - 1];
    if (!lastCandle || now - lastCandle.time >= 1000) {
      const vol = regime.volumeBase + Math.random() * regime.volumeJitter;
      this.candles.push({
        time: now,
        open: price,
        high: Math.max(price, wickPrice),
        low: Math.min(price, wickPrice),
        close: price,
        volume: Math.max(5, vol),
      });
    } else {
      lastCandle.high = Math.max(lastCandle.high, wickPrice, price);
      lastCandle.low = Math.min(lastCandle.low, wickPrice, price);
      lastCandle.close = price;
      const incrementalVolume = regime.volumeBase * 0.08 + Math.random() * (regime.volumeJitter * 0.25);
      lastCandle.volume += Math.max(0, incrementalVolume);
    }

    this.price = price;
    const io = getIO();
    io?.emit('price_tick', { timestamp: now, price, candle: this.candles[this.candles.length - 1], regime: regime.kind });
  }

  private async computeLast50HitRates() {
    const resolved = await prisma.aiSignalLog.findMany({
      where: { resolvedAt: { not: null }, outcomePct: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      take: 50,
    });

    const thresholdPct = 0.15;
    const metaStats = { wins: 0, total: 0 };
    const agentStats: Record<string, { wins: number; total: number }> = {};

    for (const row of resolved) {
      const outcomePct = row.outcomePct ?? 0;
      const resolvedFlat = Math.abs(outcomePct) <= thresholdPct;
      const meta = (row.metaDecisionJson ?? {}) as { action?: 'BUY' | 'SELL' | 'NO_TRADE' };
      const metaAction = meta.action ?? 'NO_TRADE';
      const metaCorrect = metaAction === 'BUY' ? outcomePct > 0 : metaAction === 'SELL' ? outcomePct < 0 : resolvedFlat;
      metaStats.total += 1;
      if (metaCorrect) metaStats.wins += 1;

      const signals = (row.signalsJson as ModelSignal[] | null) ?? [];
      for (const signal of signals) {
        if (!agentStats[signal.model]) agentStats[signal.model] = { wins: 0, total: 0 };
        const stat = agentStats[signal.model];
        stat.total += 1;
        const ok = signal.signal === 'BUY' ? outcomePct > 0 : signal.signal === 'SELL' ? outcomePct < 0 : resolvedFlat;
        if (ok) stat.wins += 1;
      }
    }

    return {
      meta: metaStats.total ? Math.round((metaStats.wins / metaStats.total) * 100) : 0,
      agents: Object.fromEntries(Object.entries(agentStats).map(([k, v]) => [k, v.total ? Math.round((v.wins / v.total) * 100) : 0])),
    };
  }

  private async settleSignalOutcomes(currentPrice: number) {
    const now = Date.now();
    const matured = this.signalOutcomes.filter((s) => now - s.time >= s.horizonSec * 1000);
    this.signalOutcomes = this.signalOutcomes.filter((s) => now - s.time < s.horizonSec * 1000);

    for (const sig of matured) {
      const outcomePct = ((currentPrice - sig.price) / sig.price) * 100;
      const isFlat = Math.abs(outcomePct) <= 0.15;
      const metaCorrect = sig.action === 'BUY' ? outcomePct > 0 : sig.action === 'SELL' ? outcomePct < 0 : isFlat;
      await prisma.aiSignalLog.update({
        where: { id: sig.id },
        data: {
          resolvedAt: new Date(),
          outcomePct,
          metaCorrect,
        },
      }).catch(() => null);
    }

    const hitRates = await this.computeLast50HitRates().catch(() => ({ meta: 0, agents: {} as Record<string, number> }));
    if (matured.length > 0) {
      await prisma.aiSignalLog.updateMany({
        where: { id: { in: matured.map((m) => m.id) } },
        data: { hitRatesJson: hitRates as unknown as object },
      }).catch(() => null);
    }

    return hitRates;
  }

  private async emitSignals(deal: Deal & { jumps: DealJump[] }) {
    const prices = this.candles.map((c) => c.close);
    if (prices.length < 5) return;
    const signals = buildSignals(prices, this.candles.map((c) => c.volume));
    const meta = aggregateSignals(signals);

    const created = await prisma.aiSignalLog.create({
      data: {
        dealId: deal.id,
        signalsJson: signals as unknown as object,
        metaDecisionJson: meta as unknown as object,
        horizonSec: 60,
      },
    }).catch(() => null);

    if (created) {
      this.signalOutcomes.push({ id: created.id, time: Date.now(), price: prices[prices.length - 1], action: meta.action, horizonSec: created.horizonSec });
    }

    const hitRates = await this.settleSignalOutcomes(prices[prices.length - 1]);

    const io = getIO();
    io?.emit('ai_signals', {
      signals,
      meta,
      hitRates,
    });
    io?.emit('deal_state', { status: 'RUNNING', dealId: deal.id });
  }

  private async finishDeal() {
    if (!this.currentDeal) return;
    const dealId = this.currentDeal.id;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.candleTimer) clearInterval(this.candleTimer);
    this.tickTimer = null;
    this.candleTimer = null;
    this.regime = null;
    this.nextRegimeSwitch = 0;
    this.lastTickAt = 0;
    await prisma.deal.update({ where: { id: dealId }, data: { status: 'FINISHED' } }).catch(() => null);
    const io = getIO();
    io?.emit('deal_state', { status: 'FINISHED', dealId });
    this.currentDeal = null;
  }

  getCurrentPrice() {
    return this.price || this.currentDeal?.basePrice || 0;
  }

  getRegimeVolatility() {
    if (!this.regime) return 0.5;
    if (this.regime.kind === 'HIGH_VOL') return 1.5;
    if (this.regime.kind === 'LOW_VOL') return 0.2;
    if (this.regime.kind === 'CHOPPY') return 0.8;
    return 1;
  }

  getActiveDealId() {
    return this.currentDeal?.id ?? null;
  }

  getRecentCandles(limit = 250): Candle[] {
    return this.candles.slice(-Math.max(1, limit));
  }

  getSelectedSymbol() {
    return this.currentDeal?.symbol ?? 'AUTO';
  }
}

// singleton
class DealEngineDisabled {
  // minimal interface to avoid crashes during build when DATABASE_URL is absent
  getCurrentPrice() {
    return 0;
  }
  getActiveDealId() {
    return null;
  }
  getRegimeVolatility() {
    return 0.5;
  }
  getRecentCandles() {
    return [];
  }
  getSelectedSymbol() {
    return 'AUTO';
  }
}

const shouldRunEngine = !!process.env.DATABASE_URL;
const globalEngine = (globalThis as unknown as { dealEngine?: DealEngine | DealEngineDisabled });
export const dealEngine = globalEngine.dealEngine ?? (shouldRunEngine ? new DealEngine() : new DealEngineDisabled());
if (!globalEngine.dealEngine) globalEngine.dealEngine = dealEngine;
