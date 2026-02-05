import { Deal, DealJump } from '@prisma/client';
import { prisma } from '../prisma';
import { buildSignals, aggregateSignals, type ModelSignal } from '../ai';
import { getIO } from '../socketServer';
import {
  type GraphMode,
  type GraphProfile,
  type GraphTimeframe,
  type NonAutoGraphMode,
  DEFAULT_GRAPH_MODE,
  DEFAULT_GRAPH_TIMEFRAME,
  GRAPH_MODE_PROFILES,
  NON_AUTO_GRAPH_MODES,
  normalizeGraphMode,
  normalizeGraphTimeframe,
  timeframeToMs,
} from './graphModes';

type Candle = {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type DealWithJumps = Deal & { jumps: DealJump[] };

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

type ModeRuntimeState = {
  phaseOffset: number;
  driftTilt: number;
  noiseTilt: number;
  volumeTilt: number;
  shockTilt: number;
};

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

const buildModeRuntime = (): Record<NonAutoGraphMode, ModeRuntimeState> => {
  const entries = NON_AUTO_GRAPH_MODES.map((mode) => [
    mode,
    {
      phaseOffset: randomBetween(0, Math.PI * 2),
      driftTilt: randomBetween(0.82, 1.18),
      noiseTilt: randomBetween(0.86, 1.22),
      volumeTilt: randomBetween(0.8, 1.24),
      shockTilt: randomBetween(0.8, 1.3),
    } satisfies ModeRuntimeState,
  ] as const);

  return Object.fromEntries(entries) as Record<NonAutoGraphMode, ModeRuntimeState>;
};

class DealEngine {
  private watcher: NodeJS.Timeout | null = null;
  private marketTickTimer: NodeJS.Timeout | null = null;
  private signalTimer: NodeJS.Timeout | null = null;
  private currentDeal: DealWithJumps | null = null;
  private price = 0;
  private startTime = 0;
  private candles: Candle[] = [];
  private regime: RegimeState | null = null;
  private nextRegimeSwitch = 0;
  private lastTickAt = 0;
  private signalOutcomes: { id: string; time: number; price: number; action: 'BUY' | 'SELL' | 'NO_TRADE'; horizonSec: number }[] = [];

  private selectedGraphMode: GraphMode = DEFAULT_GRAPH_MODE;
  private selectedTimeframe: GraphTimeframe = DEFAULT_GRAPH_TIMEFRAME;
  private autoGraphMode: NonAutoGraphMode = NON_AUTO_GRAPH_MODES[0];
  private autoGraphModeUntil = 0;
  private modeRuntime: Record<NonAutoGraphMode, ModeRuntimeState> = buildModeRuntime();

  constructor() {
    this.reseedSyntheticMarket(false);
    this.startMarketTicks();
    this.startWatcher();
  }

  private log(msg: string) {
    if (process.env.NODE_ENV !== 'production') console.log('[DealEngine]', msg);
  }

  private static gaussianRandom() {
    return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  }

  private startWatcher() {
    if (this.watcher) return;
    this.watcher = setInterval(() => void this.checkDeals(), 5000);
    void this.checkDeals();
  }

  private startMarketTicks() {
    if (this.marketTickTimer) return;
    this.marketTickTimer = setInterval(() => {
      if (this.currentDeal) {
        this.generateDealTick(this.currentDeal);
      } else {
        this.generateSyntheticTick();
      }
    }, 200);
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
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[DealEngine] checkDeals skipped due to error:', code ?? (err instanceof Error ? err.message : err));
      }
    }
  }

  private pickAutoMode(now: number) {
    const candidates = NON_AUTO_GRAPH_MODES.filter((mode) => mode !== this.autoGraphMode);
    const chosen = candidates[Math.floor(Math.random() * candidates.length)] ?? NON_AUTO_GRAPH_MODES[0];
    this.autoGraphMode = chosen;
    this.autoGraphModeUntil = now + Math.floor(randomBetween(25000, 70000));
    this.log(`Auto graph mode -> ${chosen}`);
  }

  private getResolvedGraphMode(now: number): NonAutoGraphMode {
    if (this.selectedGraphMode !== 'AUTO') return this.selectedGraphMode;
    if (now >= this.autoGraphModeUntil || !this.autoGraphMode) {
      this.pickAutoMode(now);
    }
    return this.autoGraphMode;
  }

  private pickRegime(prev?: RegimeState | null): RegimeState {
    const pool: { kind: MarketRegime; weight: number }[] = [
      { kind: 'TRENDING', weight: 0.32 },
      { kind: 'CHOPPY', weight: 0.28 },
      { kind: 'HIGH_VOL', weight: 0.24 },
      { kind: 'LOW_VOL', weight: 0.16 },
    ];
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;
    let chosen: MarketRegime = pool[0].kind;

    for (const item of pool) {
      roll -= item.weight;
      if (roll <= 0) {
        chosen = item.kind;
        break;
      }
    }

    if (prev && prev.kind === chosen && Math.random() < 0.42) {
      const alternatives = pool.filter((item) => item.kind !== prev.kind);
      chosen = alternatives[Math.floor(Math.random() * alternatives.length)].kind;
    }

    if (chosen === 'TRENDING') {
      const direction =
        prev?.kind === 'TRENDING' && prev.trendDirection && Math.random() < 0.58
          ? prev.trendDirection
          : Math.random() < 0.5
            ? -1
            : 1;
      return {
        kind: 'TRENDING',
        driftBpsPerSec: randomBetween(2.3, 6.8),
        noiseBps: randomBetween(6, 14),
        wickBps: randomBetween(12, 26),
        volumeBase: randomBetween(105, 190),
        volumeJitter: randomBetween(42, 92),
        meanRevert: 0.12,
        trendDirection: direction,
      };
    }

    if (chosen === 'HIGH_VOL') {
      return {
        kind: 'HIGH_VOL',
        driftBpsPerSec: randomBetween(-0.7, 0.7),
        noiseBps: randomBetween(18, 40),
        wickBps: randomBetween(30, 72),
        volumeBase: randomBetween(165, 270),
        volumeJitter: randomBetween(76, 145),
        meanRevert: 0.18,
      };
    }

    if (chosen === 'CHOPPY') {
      return {
        kind: 'CHOPPY',
        driftBpsPerSec: randomBetween(-0.45, 0.45),
        noiseBps: randomBetween(8, 18),
        wickBps: randomBetween(10, 20),
        volumeBase: randomBetween(72, 140),
        volumeJitter: randomBetween(30, 70),
        meanRevert: 0.28,
      };
    }

    return {
      kind: 'LOW_VOL',
      driftBpsPerSec: randomBetween(-0.25, 0.25),
      noiseBps: randomBetween(2, 6),
      wickBps: randomBetween(6, 12),
      volumeBase: randomBetween(35, 80),
      volumeJitter: randomBetween(14, 40),
      meanRevert: 0.34,
    };
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

  private getBucketTime(now: number) {
    const bucketMs = timeframeToMs(this.selectedTimeframe);
    return Math.floor(now / bucketMs) * bucketMs;
  }

  private computeSyntheticAnchor(now: number, profile: GraphProfile, runtime: ModeRuntimeState): number {
    const phase = (now / 1000 + runtime.phaseOffset) / profile.cycleSec;
    const macroWave = Math.sin(phase * Math.PI * 2) * (profile.waveBps / 10000);
    const microWave = Math.sin(phase * Math.PI * 2.8 + runtime.phaseOffset * 0.4) * (profile.microWaveBps / 10000);
    const longWave = Math.sin((now / 1000 + runtime.phaseOffset) / (profile.cycleSec * 6)) * ((profile.waveBps / 10000) * 0.35);
    return profile.basePrice * (1 + macroWave + microWave + longWave);
  }

  private upsertCandle(now: number, price: number, regime: RegimeState, anchorPrice: number): Candle {
    const bucketTime = this.getBucketTime(now);
    const bucketMs = timeframeToMs(this.selectedTimeframe);
    const bucketScale = Math.max(1, Math.sqrt(bucketMs / 1000));

    const wickSwing =
      (regime.wickBps / 10000) *
      DealEngine.gaussianRandom() *
      (Math.random() < (regime.kind === 'HIGH_VOL' ? 0.6 : 0.35) ? 3.2 : 1.8);
    const wickPrice = Math.max(anchorPrice * 0.08, price * (1 + wickSwing));

    const lastCandle = this.candles[this.candles.length - 1];
    if (!lastCandle || lastCandle.time !== bucketTime) {
      const open = lastCandle?.close ?? price;
      const initialVolume =
        Math.max(3, regime.volumeBase * bucketScale * randomBetween(0.55, 1.35) + Math.random() * regime.volumeJitter * 0.45 * bucketScale);
      this.candles.push({
        time: bucketTime,
        open,
        high: Math.max(open, price, wickPrice),
        low: Math.max(0.0000001, Math.min(open, price, wickPrice)),
        close: price,
        volume: initialVolume,
      });
    } else {
      lastCandle.high = Math.max(lastCandle.high, wickPrice, price);
      lastCandle.low = Math.max(0.0000001, Math.min(lastCandle.low, wickPrice, price));
      lastCandle.close = price;
      const incrementalVolume =
        (regime.volumeBase * 0.09 + Math.random() * (regime.volumeJitter * 0.35)) * (bucketScale / 2.4);
      lastCandle.volume += Math.max(0, incrementalVolume);
    }

    if (this.candles.length > 3000) {
      this.candles = this.candles.slice(-2500);
    }

    return this.candles[this.candles.length - 1];
  }

  private reseedSyntheticMarket(emitSocketUpdate: boolean) {
    if (this.currentDeal) return;

    const now = Date.now();
    this.maybeRotateRegime(now);

    const mode = this.getResolvedGraphMode(now);
    const profile = GRAPH_MODE_PROFILES[mode];
    const runtime = this.modeRuntime[mode];
    const bucketMs = timeframeToMs(this.selectedTimeframe);

    const seedCount = 250;
    const seeded: Candle[] = [];
    let workingPrice = profile.basePrice * randomBetween(0.94, 1.06);
    let prevClose = workingPrice;

    for (let i = seedCount - 1; i >= 0; i -= 1) {
      const ts = now - i * bucketMs;
      const anchor = this.computeSyntheticAnchor(ts, profile, runtime);
      const drift =
        profile.basePrice *
        ((profile.trendBpsPerSec * runtime.driftTilt) / 10000) *
        (0.4 + Math.sin((ts / 1000 + runtime.phaseOffset) / (profile.cycleSec * 4)) * 0.6);
      const pull = (anchor - workingPrice) * profile.meanRevert * 0.55;
      const noise = profile.basePrice * ((profile.noiseBps * runtime.noiseTilt) / 10000) * DealEngine.gaussianRandom() * 0.55;
      workingPrice = Math.max(profile.basePrice * 0.08, workingPrice + drift + pull + noise);

      const wickRange =
        workingPrice *
        ((profile.wickBps * runtime.noiseTilt) / 10000) *
        randomBetween(0.5, 1.8);
      const high = Math.max(prevClose, workingPrice) + wickRange * randomBetween(0.12, 0.9);
      const low = Math.max(0.0000001, Math.min(prevClose, workingPrice) - wickRange * randomBetween(0.12, 0.9));
      const volume =
        Math.max(3, (profile.volumeBase * runtime.volumeTilt + Math.random() * profile.volumeJitter) * Math.max(1, Math.sqrt(bucketMs / 1000)));

      seeded.push({
        time: Math.floor(ts / bucketMs) * bucketMs,
        open: prevClose,
        high,
        low,
        close: workingPrice,
        volume,
      });

      prevClose = workingPrice;
    }

    this.candles = seeded;
    this.price = seeded[seeded.length - 1]?.close ?? profile.basePrice;
    this.lastTickAt = now;
    this.startTime = now;

    if (emitSocketUpdate) {
      const io = getIO();
      io?.emit('market_selected', { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe, source: 'synthetic' });
      const latest = this.candles[this.candles.length - 1];
      if (latest) {
        io?.emit('price_tick', {
          timestamp: latest.time,
          price: latest.close,
          candle: latest,
          regime: this.regime?.kind ?? 'CHOPPY',
          mode,
        });
      }
    }
  }

  private computeScenarioPrice(deal: DealWithJumps, elapsedSec: number) {
    const base = deal.basePrice;
    let biasPct = 0;

    if (elapsedSec >= deal.dropDelaySec) {
      const prog = Math.min((elapsedSec - deal.dropDelaySec) / 4, 1);
      biasPct -= deal.dropMagnitudePct * prog;
    }

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

    const noise = base * 0.0006 * DealEngine.gaussianRandom();
    return base * (1 + biasPct / 100) + noise;
  }

  private generateDealTick(deal: DealWithJumps) {
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
    const noiseTerm = anchorPrice * (regime.noiseBps / 10000) * DealEngine.gaussianRandom() * noiseScale;
    const pullTerm = (anchorPrice - prevPrice) * regime.meanRevert * Math.min(dtSec * 1.1, 1);

    const unclampedPrice = prevPrice + pullTerm + driftTerm + noiseTerm;
    const maxJump = Math.max(prevPrice * 0.25, anchorPrice * 0.1);
    const boundedPrice = Math.min(Math.max(unclampedPrice, prevPrice - maxJump), prevPrice + maxJump);
    const price = Math.max(anchorPrice * 0.2, boundedPrice);

    const candle = this.upsertCandle(now, price, regime, anchorPrice);
    this.price = price;

    const io = getIO();
    io?.emit('price_tick', { timestamp: now, price, candle, regime: regime.kind, mode: deal.symbol });
  }

  private generateSyntheticTick() {
    const now = Date.now();
    this.maybeRotateRegime(now);

    const mode = this.getResolvedGraphMode(now);
    const profile = GRAPH_MODE_PROFILES[mode];
    const runtime = this.modeRuntime[mode];
    const regime = this.regime ?? this.pickRegime();

    const anchorPrice = this.computeSyntheticAnchor(now, profile, runtime);
    const prevPrice = this.price || profile.basePrice;
    const dtSec = Math.max((now - (this.lastTickAt || now)) / 1000, 0.05);
    this.lastTickAt = now;

    const driftDirection = regime.kind === 'TRENDING' ? regime.trendDirection ?? 1 : 1;
    const profileDrift = profile.trendBpsPerSec * runtime.driftTilt;
    const regimeDrift = regime.driftBpsPerSec * 0.65 * driftDirection;
    const longSwing = Math.sin((now / 1000 + runtime.phaseOffset) / (profile.cycleSec * 4));
    const driftTerm =
      profile.basePrice *
      ((profileDrift + regimeDrift) / 10000) *
      dtSec *
      (0.62 + longSwing * 0.68);

    const noiseBps = profile.noiseBps * runtime.noiseTilt + regime.noiseBps * 0.55;
    const noiseTerm =
      profile.basePrice * (noiseBps / 10000) * DealEngine.gaussianRandom() * Math.sqrt(dtSec * 1.9);

    const pullStrength = Math.min(profile.meanRevert + regime.meanRevert * 0.25, 0.85);
    const pullTerm = (anchorPrice - prevPrice) * pullStrength * Math.min(dtSec * 1.15, 1);

    let shockTerm = 0;
    const shockProb = profile.shockChance * runtime.shockTilt * Math.max(0.1, dtSec);
    if (Math.random() < shockProb) {
      const shockDirection = Math.random() < 0.5 ? -1 : 1;
      shockTerm =
        profile.basePrice *
        (profile.shockBps / 10000) *
        shockDirection *
        randomBetween(0.45, 1.2);
    }

    const unclampedPrice = prevPrice + driftTerm + noiseTerm + pullTerm + shockTerm;
    const maxJump = Math.max(prevPrice * 0.2, profile.basePrice * 0.07);
    const boundedPrice = Math.min(Math.max(unclampedPrice, prevPrice - maxJump), prevPrice + maxJump);
    const price = Math.max(profile.basePrice * 0.08, boundedPrice);

    const syntheticRegime: RegimeState = {
      ...regime,
      noiseBps: regime.noiseBps + profile.noiseBps * 0.5,
      wickBps: regime.wickBps + profile.wickBps * runtime.noiseTilt * 0.6,
      volumeBase: regime.volumeBase + profile.volumeBase * runtime.volumeTilt * 0.7,
      volumeJitter: regime.volumeJitter + profile.volumeJitter * runtime.volumeTilt * 0.55,
      meanRevert: Math.min(0.85, regime.meanRevert + profile.meanRevert * 0.45),
    };

    const candle = this.upsertCandle(now, price, syntheticRegime, anchorPrice);
    this.price = price;

    const io = getIO();
    io?.emit('price_tick', { timestamp: now, price, candle, regime: syntheticRegime.kind, mode });

    if (this.selectedGraphMode === 'AUTO' && now >= this.autoGraphModeUntil) {
      this.pickAutoMode(now);
    }
  }

  async runDeal(deal: DealWithJumps) {
    if (this.currentDeal) return;

    this.currentDeal = deal;
    this.price = deal.basePrice;
    this.startTime = Date.now();
    this.candles = [];
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
        timeframe: this.selectedTimeframe,
      });
      io?.emit('meta_status', { text: `Trade identified: ${deal.symbol} (${deal.chainName})`, stage: 'identified' });
    }, 1000);

    if (this.signalTimer) clearInterval(this.signalTimer);
    this.signalTimer = setInterval(() => void this.emitSignals(deal), 1000);

    setTimeout(() => {
      void this.finishDeal();
    }, deal.totalDurationSec * 1000);
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
      agents: Object.fromEntries(Object.entries(agentStats).map(([key, value]) => [key, value.total ? Math.round((value.wins / value.total) * 100) : 0])),
    };
  }

  private async settleSignalOutcomes(currentPrice: number) {
    const now = Date.now();
    const matured = this.signalOutcomes.filter((signal) => now - signal.time >= signal.horizonSec * 1000);
    this.signalOutcomes = this.signalOutcomes.filter((signal) => now - signal.time < signal.horizonSec * 1000);

    for (const signal of matured) {
      const outcomePct = ((currentPrice - signal.price) / signal.price) * 100;
      const isFlat = Math.abs(outcomePct) <= 0.15;
      const metaCorrect = signal.action === 'BUY' ? outcomePct > 0 : signal.action === 'SELL' ? outcomePct < 0 : isFlat;
      await prisma.aiSignalLog
        .update({
          where: { id: signal.id },
          data: {
            resolvedAt: new Date(),
            outcomePct,
            metaCorrect,
          },
        })
        .catch(() => null);
    }

    const hitRates = await this.computeLast50HitRates().catch(() => ({ meta: 0, agents: {} as Record<string, number> }));
    if (matured.length > 0) {
      await prisma.aiSignalLog
        .updateMany({
          where: { id: { in: matured.map((item) => item.id) } },
          data: { hitRatesJson: hitRates as unknown as object },
        })
        .catch(() => null);
    }

    return hitRates;
  }

  private async emitSignals(deal: DealWithJumps) {
    const prices = this.candles.map((candle) => candle.close);
    if (prices.length < 5) return;

    const signals = buildSignals(prices, this.candles.map((candle) => candle.volume));
    const meta = aggregateSignals(signals);

    const created = await prisma.aiSignalLog
      .create({
        data: {
          dealId: deal.id,
          signalsJson: signals as unknown as object,
          metaDecisionJson: meta as unknown as object,
          horizonSec: 60,
        },
      })
      .catch(() => null);

    if (created) {
      this.signalOutcomes.push({
        id: created.id,
        time: Date.now(),
        price: prices[prices.length - 1],
        action: meta.action,
        horizonSec: created.horizonSec,
      });
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
    if (this.signalTimer) clearInterval(this.signalTimer);
    this.signalTimer = null;
    this.regime = null;
    this.nextRegimeSwitch = 0;
    this.lastTickAt = 0;

    await prisma.deal.update({ where: { id: dealId }, data: { status: 'FINISHED' } }).catch(() => null);
    const io = getIO();
    io?.emit('deal_state', { status: 'FINISHED', dealId });

    this.currentDeal = null;
    this.reseedSyntheticMarket(true);
  }

  setChartPreferences(inputMode?: string | null, inputTimeframe?: string | null) {
    const modeProvided = typeof inputMode === 'string';
    const timeframeProvided = typeof inputTimeframe === 'string';

    const nextMode = modeProvided ? normalizeGraphMode(inputMode) : this.selectedGraphMode;
    const nextTimeframe = timeframeProvided ? normalizeGraphTimeframe(inputTimeframe) : this.selectedTimeframe;

    const modeChanged = nextMode !== this.selectedGraphMode;
    const timeframeChanged = nextTimeframe !== this.selectedTimeframe;

    if (!modeChanged && !timeframeChanged) {
      return { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe };
    }

    this.selectedGraphMode = nextMode;
    this.selectedTimeframe = nextTimeframe;

    if (!this.currentDeal) {
      this.reseedSyntheticMarket(true);
    } else if (timeframeChanged) {
      this.candles = this.candles.slice(-250);
      this.lastTickAt = Date.now();
      const io = getIO();
      io?.emit('market_selected', { symbol: this.currentDeal.symbol, timeframe: this.selectedTimeframe, source: 'deal' });
    }

    return { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe };
  }

  getCurrentPrice() {
    return this.price || this.currentDeal?.basePrice || 0;
  }

  getRegimeVolatility() {
    if (!this.regime) return 0.65;
    if (this.regime.kind === 'HIGH_VOL') return 1.6;
    if (this.regime.kind === 'LOW_VOL') return 0.3;
    if (this.regime.kind === 'CHOPPY') return 0.85;
    return 1.05;
  }

  getActiveDealId() {
    return this.currentDeal?.id ?? null;
  }

  getRecentCandles(limit = 250): Candle[] {
    return this.candles.slice(-Math.max(1, limit));
  }

  getSelectedSymbol() {
    return this.currentDeal?.symbol ?? this.selectedGraphMode;
  }

  getSelectedTimeframe() {
    return this.selectedTimeframe;
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
    return DEFAULT_GRAPH_MODE;
  }

  getSelectedTimeframe() {
    return DEFAULT_GRAPH_TIMEFRAME;
  }

  setChartPreferences(inputMode?: string | null, inputTimeframe?: string | null) {
    void inputMode;
    void inputTimeframe;
    return { symbol: DEFAULT_GRAPH_MODE, timeframe: DEFAULT_GRAPH_TIMEFRAME };
  }
}

const shouldRunEngine = !!process.env.DATABASE_URL;
const globalEngine = globalThis as unknown as { dealEngine?: DealEngine | DealEngineDisabled };
export const dealEngine = globalEngine.dealEngine ?? (shouldRunEngine ? new DealEngine() : new DealEngineDisabled());
if (!globalEngine.dealEngine) globalEngine.dealEngine = dealEngine;
