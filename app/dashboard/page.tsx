'use client';

import { useCallback, useEffect, useMemo, useRef, useState, CSSProperties } from 'react';
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  LineData,
  Time,
  UTCTimestamp,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import io, { type Socket } from 'socket.io-client';
import {
  GRAPH_MODES,
  GRAPH_TIMEFRAMES,
  type GraphMode,
  type GraphTimeframe,
  normalizeGraphMode,
  normalizeGraphTimeframe,
} from '@/lib/engine/graphModes';

type Wallet = {
  cashBalance: number;
  equity: number;
  liveEquity?: number;
  positionValue?: number;
  unrealizedPnl?: number;
  pnlTotal: number;
  withdrawTaxPercent?: number;
  reservedWithdrawalAmount?: number;
  withdrawableBalance?: number;
};
type Trade = {
  id: string;
  time: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  sizeUsd: number;
  pnl: number | null;
  fillPrice?: number;
  feeUsd?: number;
  slippageUsd?: number;
  latencyMs?: number;
};
type SignalState = 'BUY' | 'SELL' | 'NO_TRADE';
type RawSignalState = SignalState | 'OFF';
type ModelSignal = { model: string; signal: RawSignalState; confidence: number; reasons: string[] };
type NormalizedModelSignal = Omit<ModelSignal, 'signal'> & { signal: SignalState };
type Meta = { action: 'BUY' | 'SELL' | 'NO_TRADE'; confidence: number; reason: string };
type ActivityEvent = { id: string; eventType: string; actorRole: string; createdAt: string; metadata: Record<string, unknown> };
type BlinkerSignal = {
  model: string;
  signal: SignalState;
  confidence: number;
  hitRate: number;
  reason: string;
};

type ChartPreference = {
  selectedSymbol?: string | null;
  timeframe?: string | null;
  zoomLogical?: number | null;
  collapsedJson?: Record<string, boolean> | null;
};

type ChartBootstrapResponse = {
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  symbol: string;
  timeframe?: string;
};

const BAND_MULTIPLIER = 1.85;
const KEEP_ALIVE_PING_INTERVAL_MS = 6 * 60 * 1000;
const COMMITTEE_MODELS = ['Trend Agent', 'Momentum Agent', 'Volatility Agent', 'Volume Agent', 'Pattern Agent'] as const;
const AR_LOCALE = 'ar-SA';

const SIGNAL_LABELS_AR: Record<SignalState, string> = {
  BUY: 'شراء',
  SELL: 'بيع',
  NO_TRADE: 'حياد',
};

const ROLE_LABELS_AR: Record<string, string> = {
  USER: 'مستخدم',
  ADMIN: 'مشرف',
};

const EVENT_LABELS_AR: Record<string, string> = {
  login_success: 'تسجيل دخول ناجح',
  login_failed: 'فشل تسجيل الدخول',
  trade_buy: 'شراء',
  trade_sell: 'بيع',
  withdrawal_request: 'طلب سحب',
  withdrawal_approved: 'موافقة على السحب',
  withdrawal_rejected: 'رفض السحب',
};

const API_ERROR_AR: Record<string, string> = {
  'amountUsd must be > 0': 'يجب أن يكون مبلغ الشراء أكبر من 0.',
  'Position already open': 'يوجد مركز مفتوح بالفعل.',
  'amountUsd exceeds wallet cash after fees': 'قيمة الشراء تتجاوز الرصيد النقدي بعد الرسوم.',
  'sellPercent must be between 0 and 100': 'نسبة البيع يجب أن تكون بين 0 و100.',
  'No open position': 'لا يوجد مركز مفتوح.',
  'Trade failed': 'فشلت الصفقة.',
  Unauthorized: 'غير مصرح.',
  Forbidden: 'غير مسموح.',
  'Invalid payload': 'البيانات المرسلة غير صحيحة.',
  'Too many attempts': 'محاولات كثيرة جدًا. حاول لاحقًا.',
  'Invalid amount': 'قيمة السحب غير صحيحة.',
  'Request already processed': 'تمت معالجة الطلب مسبقًا.',
  'Insufficient wallet cash at approval time': 'الرصيد النقدي غير كافٍ للموافقة على السحب.',
};

const formatPrice = (value: number) => {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return '--';
  if (abs >= 10000) return value.toFixed(2);
  if (abs >= 1000) return value.toFixed(3);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(5);
  return value.toFixed(7);
};

const formatVolumeCompact = (value: number) => {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
};

const computeEma = (values: number[], period: number) => {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  let prev = values[0];
  return values.map((value, index) => {
    if (index === 0) {
      prev = value;
      return value;
    }
    prev = prev + alpha * (value - prev);
    return prev;
  });
};

const computeAtr = (candles: CandlestickData<Time>[], period: number) => {
  if (!candles.length) return [];
  const trValues = candles.map((candle, index) => {
    const prevClose = index === 0 ? candle.close : candles[index - 1].close;
    const hl = candle.high - candle.low;
    const hc = Math.abs(candle.high - prevClose);
    const lc = Math.abs(candle.low - prevClose);
    return Math.max(hl, hc, lc);
  });

  const alpha = 1 / Math.max(period, 1);
  let prevAtr = trValues[0];
  return trValues.map((value, index) => {
    if (index === 0) {
      prevAtr = value;
      return value;
    }
    prevAtr = prevAtr + alpha * (value - prevAtr);
    return prevAtr;
  });
};

const nearestCandleTime = (candles: CandlestickData<Time>[], tsSec: number) => {
  if (!candles.length) return tsSec as UTCTimestamp;
  let nearest = candles[0].time as number;
  let best = Math.abs((candles[0].time as number) - tsSec);
  for (const c of candles) {
    const time = c.time as number;
    const distance = Math.abs(time - tsSec);
    if (distance < best) {
      best = distance;
      nearest = time;
    }
  }
  return nearest as UTCTimestamp;
};

const normalizeSignalState = (signal: RawSignalState): SignalState => (signal === 'OFF' ? 'NO_TRADE' : signal);

const signalLightClassName = (signal: SignalState) => {
  if (signal === 'BUY') return 'status-light status-light-buy';
  if (signal === 'SELL') return 'status-light status-light-sell';
  return 'status-light status-light-neutral';
};

const signalLabelAr = (signal: SignalState) => SIGNAL_LABELS_AR[signal];

const formatTimeAr = (value: string | number | Date) => new Date(value).toLocaleTimeString(AR_LOCALE);

const formatDateTimeAr = (value: string | number | Date) => new Date(value).toLocaleString(AR_LOCALE);

const localizeApiError = (message: string) => API_ERROR_AR[message] ?? message;

const localizeRole = (role: string) => ROLE_LABELS_AR[role] ?? role;

const localizeEventType = (eventType: string) => EVENT_LABELS_AR[eventType] ?? eventType;

const localizeReasonText = (text: string) =>
  text
    .replace(/Committee incomplete/g, 'اللجنة غير مكتملة')
    .replace(/conservative no-trade/g, 'عدم تداول احترازي')
    .replace(/BUY consensus/g, 'إجماع شراء')
    .replace(/SELL consensus/g, 'إجماع بيع')
    .replace(/BUY votes/g, 'أصوات الشراء')
    .replace(/SELL votes/g, 'أصوات البيع')
    .replace(/No-trade majority/g, 'أغلبية عدم التداول')
    .replace(/Consensus below 4\/5; Meta remains conservative by default/g, 'الإجماع أقل من 4/5؛ والقرار الاحترازي هو عدم التداول')
    .replace(/Conflict/g, 'تعارض')
    .replace(/confidence/g, 'الثقة')
    .replace(/edge/g, 'الفارق')
    .replace(/awaiting live signal/gi, 'بانتظار إشارة مباشرة')
    .replace(/Awaiting live signal/gi, 'بانتظار إشارة مباشرة')
    .replace(/No reason available/gi, 'لا يوجد سبب متاح')
    .replace(/BUY/g, 'شراء')
    .replace(/SELL/g, 'بيع')
    .replace(/NO_TRADE/g, 'بدون تداول')
    .replace(/RSI oversold \(([^)]+)\)/g, 'RSI في تشبع بيعي ($1)')
    .replace(/RSI overbought \(([^)]+)\)/g, 'RSI في تشبع شرائي ($1)')
    .replace(/RSI neutral \(([^)]+)\)/g, 'RSI محايد ($1)');

const aiBlinkerClassName = (signal: SignalState) => {
  if (signal === 'BUY') return 'ai-blinker-orb ai-blinker-orb-buy';
  if (signal === 'SELL') return 'ai-blinker-orb ai-blinker-orb-sell';
  return 'ai-blinker-orb ai-blinker-orb-neutral';
};

const blinkerSignalText = (signal: SignalState) => signalLabelAr(signal);

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema20Series = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Series = useRef<ISeriesApi<'Line'> | null>(null);
  const upperBandSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const lowerBandSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const buyInputRef = useRef<HTMLInputElement>(null);
  const sellInputRef = useRef<HTMLInputElement>(null);
  const candlesRef = useRef<CandlestickData<Time>[]>([]);
  const volumesRef = useRef<Map<number, number>>(new Map());
  const zoomLogicalRef = useRef<number | undefined>(undefined);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [signals, setSignals] = useState<ModelSignal[]>([]);
  const [meta, setMeta] = useState<Meta>({ action: 'NO_TRADE', confidence: 0, reason: 'بانتظار البيانات' });
  const [hitRates, setHitRates] = useState<{ meta: number; agents: Record<string, number> }>({ meta: 0, agents: {} });
  const [lastAiUpdate, setLastAiUpdate] = useState('');
  const [metaStatusText, setMetaStatusText] = useState('');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPercent, setSellPercent] = useState(100);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawNotice, setWithdrawNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [tooltip, setTooltip] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState<GraphMode>('AUTO');
  const [timeframe, setTimeframe] = useState<GraphTimeframe>('1s');
  const [zoomLogical, setZoomLogical] = useState<number | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ ai: false, tape: false, activity: false });
  const [prefHydrated, setPrefHydrated] = useState(false);
  const [chartReady, setChartReady] = useState(false);
  const [marketChip, setMarketChip] = useState<{ id: string; regimeOverride: string; intensity: number; aiName: string; aiTone: string }>({ id: 'BTC', regimeOverride: 'AUTO', intensity: 1, aiName: 'Calm Analyst', aiTone: 'calm' });

  const fetchWallet = async () => {
    const res = await fetch('/api/wallet');
    if (res.ok) {
      const data = await res.json();
      setWallet(data.wallet);
      setTrades(data.trades);
    } else if (res.status === 401) {
      window.location.href = '/login';
    }
  };

  const fetchActivity = async () => {
    const res = await fetch('/api/activity');
    if (res.ok) {
      const data = await res.json();
      setEvents(data.events);
    }
  };

  const applyDerivedIndicators = useCallback((nextCandles: CandlestickData<Time>[]) => {
    const closes = nextCandles.map((candle) => candle.close);
    const ema20 = computeEma(closes, 20);
    const ema50 = computeEma(closes, 50);
    const atr14 = computeAtr(nextCandles, 14);
    ema20Series.current?.setData(nextCandles.map((candle, index) => ({ time: candle.time, value: ema20[index] } as LineData)));
    ema50Series.current?.setData(nextCandles.map((candle, index) => ({ time: candle.time, value: ema50[index] } as LineData)));

    upperBandSeries.current?.setData(
      nextCandles.map((candle, index) => ({ time: candle.time, value: ema20[index] + atr14[index] * BAND_MULTIPLIER } as LineData)),
    );
    lowerBandSeries.current?.setData(
      nextCandles.map((candle, index) => ({ time: candle.time, value: Math.max(0.0000001, ema20[index] - atr14[index] * BAND_MULTIPLIER) } as LineData)),
    );
  }, []);

  const applyBootstrapData = useCallback((bootstrap: ChartBootstrapResponse | null, fitContent: boolean) => {
    if (!bootstrap) return;

    const nextSymbol = normalizeGraphMode(bootstrap.symbol);
    const nextTimeframe = normalizeGraphTimeframe(bootstrap.timeframe);
    setSelectedSymbol((prev) => (prev === nextSymbol ? prev : nextSymbol));
    setTimeframe((prev) => (prev === nextTimeframe ? prev : nextTimeframe));

    const seedCandles = bootstrap.candles.map((candle) => ({
      time: (candle.time / 1000) as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    candlesRef.current = seedCandles;
    volumesRef.current = new Map(bootstrap.candles.map((candle) => [Math.floor(candle.time / 1000), candle.volume]));
    candleSeries.current?.setData(seedCandles);
    volumeSeries.current?.setData(
      bootstrap.candles.map((candle) => ({
        time: (candle.time / 1000) as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? 'rgba(60,255,141,0.4)' : 'rgba(255,92,141,0.4)',
      } as HistogramData)),
    );

    if (seedCandles.length === 0) {
      ema20Series.current?.setData([]);
      ema50Series.current?.setData([]);
      upperBandSeries.current?.setData([]);
      lowerBandSeries.current?.setData([]);
      return;
    }

    applyDerivedIndicators(seedCandles);
    if (fitContent) {
      chartApi.current?.timeScale().fitContent();
    }
  }, [applyDerivedIndicators]);

  useEffect(() => {
    fetchWallet();
    fetchActivity();
    const interval = setInterval(() => {
      fetchWallet();
      fetchActivity();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void fetch('/api/chart-state')
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data: { preference?: ChartPreference } | null) => {
        const pref = data?.preference;
        if (!pref) return;
        if (pref.selectedSymbol) setSelectedSymbol(normalizeGraphMode(pref.selectedSymbol));
        if (pref.timeframe) setTimeframe(normalizeGraphTimeframe(pref.timeframe));
        if (typeof pref.zoomLogical === 'number') setZoomLogical(pref.zoomLogical);
        if (pref.collapsedJson) setCollapsed({ ai: false, tape: false, activity: false, ...pref.collapsedJson });
      })
      .catch(() => null)
      .finally(() => setPrefHydrated(true));
  }, []);

  useEffect(() => {
    if (!prefHydrated) return;
    const timer = setTimeout(() => {
      void fetch('/api/chart-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSymbol, timeframe, zoomLogical, collapsed }),
      }).catch(() => null);
    }, 350);
    return () => clearTimeout(timer);
  }, [selectedSymbol, timeframe, zoomLogical, collapsed, prefHydrated]);

  useEffect(() => {
    const pingWebsite = () => {
      void fetch('/api/ping', {
        method: 'GET',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => null);
    };

    pingWebsite();
    const pingInterval = setInterval(pingWebsite, KEEP_ALIVE_PING_INTERVAL_MS);
    return () => clearInterval(pingInterval);
  }, []);

  useEffect(() => {
    zoomLogicalRef.current = zoomLogical;
  }, [zoomLogical]);

  useEffect(() => {
    let isDisposed = false;
    let socket: Socket | null = null;
    let chart: IChartApi | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let onResize: (() => void) | null = null;

    const setup = async () => {
      const { createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers } = await import('lightweight-charts');
      const mount = chartRef.current;
      if (!mount || isDisposed) return;

      chart = createChart(mount, {
        layout: { background: { color: 'transparent' }, textColor: '#b8c7f0', attributionLogo: false },
        width: mount.clientWidth,
        height: mount.clientHeight || 430,
        grid: {
          vertLines: { color: 'rgba(120,140,180,0.13)' },
          horzLines: { color: 'rgba(120,140,180,0.13)' },
        },
        rightPriceScale: {
          borderColor: 'rgba(184,199,240,0.28)',
          scaleMargins: { top: 0.08, bottom: 0.12 },
        },
        timeScale: {
          borderColor: 'rgba(184,199,240,0.28)',
          rightOffset: 2,
          barSpacing: 9,
          minBarSpacing: 3,
          timeVisible: true,
          secondsVisible: true,
        },
        crosshair: {
          mode: 1,
          vertLine: { labelBackgroundColor: '#1b3c6d' },
          horzLine: { labelBackgroundColor: '#1b3c6d' },
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      });
      chartApi.current = chart;
      candleSeries.current = chart.addSeries(CandlestickSeries, {
        upColor: '#3cff8d',
        downColor: '#ff5c8d',
        wickUpColor: '#3cff8d',
        wickDownColor: '#ff5c8d',
        borderVisible: false,
        priceLineVisible: true,
        lastValueVisible: true,
      });
      markersApi.current = createSeriesMarkers(candleSeries.current, []);
      volumeSeries.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
      volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      ema20Series.current = chart.addSeries(LineSeries, { color: '#ffd166', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
      ema50Series.current = chart.addSeries(LineSeries, { color: '#6ea8ff', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
      upperBandSeries.current = chart.addSeries(LineSeries, {
        color: 'rgba(255,92,141,0.55)',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      lowerBandSeries.current = chart.addSeries(LineSeries, {
        color: 'rgba(92,255,173,0.55)',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      });

      onResize = () => {
        if (!chart || !mount) return;
        chart.applyOptions({ width: mount.clientWidth, height: mount.clientHeight || 430 });
      };
      onResize();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => onResize?.());
        resizeObserver.observe(mount);
      }
      window.addEventListener('resize', onResize);

      chart.subscribeCrosshairMove((param) => {
        const c = param.seriesData.get(candleSeries.current! as never) as unknown as CandlestickData | undefined;
        if (!c) return setTooltip('');
        const volume = volumesRef.current.get(Number(c.time));
        const absChange = c.close - c.open;
        const pct = ((c.close - c.open) / c.open) * 100;
        setTooltip(
          `افتتاح:${formatPrice(c.open)} أعلى:${formatPrice(c.high)} أدنى:${formatPrice(c.low)} إغلاق:${formatPrice(c.close)} ` +
          `التغير:${absChange >= 0 ? '+' : ''}${formatPrice(absChange)} (${pct.toFixed(2)}%) ` +
          `الحجم:${formatVolumeCompact(volume ?? Number.NaN)}`,
        );
      });

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!range) return;
        setZoomLogical(range.to);
      });

      if (typeof zoomLogicalRef.current === 'number') {
        chart.timeScale().setVisibleLogicalRange({ from: zoomLogicalRef.current - 120, to: zoomLogicalRef.current });
      }

      const bootstrap = await fetch('/api/chart', { cache: 'no-store' })
        .then(async (res) => (res.ok ? (res.json() as Promise<ChartBootstrapResponse>) : null))
        .catch(() => null);
      if (isDisposed) return;
      applyBootstrapData(bootstrap, true);
      setChartReady(true);

      await fetch('/api/socket').catch(() => null);
      if (isDisposed) return;

      socket = io('', { path: '/api/socket' });
      socket.on('market_selected', (payload: { symbol?: string; timeframe?: string }) => {
        if (payload.symbol) setSelectedSymbol(normalizeGraphMode(payload.symbol));
        if (payload.timeframe) setTimeframe(normalizeGraphTimeframe(payload.timeframe));
      });
      socket.on('control_state', (payload: {
        symbol?: string;
        timeframe?: string;
        market?: { id?: string; regimeOverride?: string; intensity?: number; ai?: { name?: string; tone?: string } };
        metaStatus?: { text?: string };
        ai?: {
          signals?: ModelSignal[];
          meta?: Meta;
          hitRates?: { meta: number; agents: Record<string, number> };
          lastSignalAt?: number | null;
        };
      }) => {
        if (payload.symbol) setSelectedSymbol(normalizeGraphMode(payload.symbol));
        if (payload.timeframe) setTimeframe(normalizeGraphTimeframe(payload.timeframe));
        if (payload.market?.id) {
          setMarketChip({
            id: payload.market.id,
            regimeOverride: payload.market.regimeOverride ?? 'AUTO',
            intensity: payload.market.intensity ?? 1,
            aiName: payload.market.ai?.name ?? 'Calm Analyst',
            aiTone: payload.market.ai?.tone ?? 'calm',
          });
        }
        if (payload.metaStatus?.text) setMetaStatusText(payload.metaStatus.text);
        if (payload.ai?.signals) setSignals(payload.ai.signals);
        if (payload.ai?.meta) setMeta(payload.ai.meta);
        if (payload.ai?.hitRates) setHitRates(payload.ai.hitRates);
        if (typeof payload.ai?.lastSignalAt === 'number') {
          setLastAiUpdate(formatTimeAr(payload.ai.lastSignalAt));
        }
      });
      socket.on('meta_status', (payload: { text?: string }) => {
        if (payload.text) setMetaStatusText(payload.text);
      });
      socket.on('price_tick', (payload: { candle: { time: number; open: number; high: number; low: number; close: number; volume: number } }) => {
        const c = payload.candle;
        const item = { time: (c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
        candleSeries.current?.update(item);
        volumeSeries.current?.update({ time: item.time, value: c.volume, color: c.close >= c.open ? 'rgba(60,255,141,0.4)' : 'rgba(255,92,141,0.4)' } as HistogramData);

        const next = [...candlesRef.current.filter((x) => x.time !== item.time), item].slice(-250);
        candlesRef.current = next;
        const nextVolumes = new Map(volumesRef.current);
        nextVolumes.set(Number(item.time), c.volume);
        const keepTimes = new Set(next.map((candle) => Number(candle.time)));
        for (const time of nextVolumes.keys()) {
          if (!keepTimes.has(time)) nextVolumes.delete(time);
        }
        volumesRef.current = nextVolumes;
        applyDerivedIndicators(next);
      });
      socket.on('ai_signals', (payload: { signals: ModelSignal[]; meta: Meta; hitRates: { meta: number; agents: Record<string, number> } }) => {
        setSignals(payload.signals);
        setMeta(payload.meta);
        setHitRates(payload.hitRates);
        setLastAiUpdate(formatTimeAr(new Date()));
        setMetaStatusText(payload.meta.reason);
      });
    };
    void setup();

    return () => {
      isDisposed = true;
      socket?.disconnect();
      resizeObserver?.disconnect();
      if (onResize) window.removeEventListener('resize', onResize);
      markersApi.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
      ema20Series.current = null;
      ema50Series.current = null;
      upperBandSeries.current = null;
      lowerBandSeries.current = null;
      chartApi.current = null;
      volumesRef.current = new Map();
      chart?.remove();
      setChartReady(false);
    };
  }, [applyBootstrapData, applyDerivedIndicators]);

  useEffect(() => {
    if (!chartReady || !prefHydrated) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      candleSeries.current?.setData([]);
      volumeSeries.current?.setData([]);
      candlesRef.current = [];
      volumesRef.current = new Map();
      const params = new URLSearchParams({ selectedSymbol, timeframe });
      void fetch(`/api/chart?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
        .then(async (res) => (res.ok ? (res.json() as Promise<ChartBootstrapResponse>) : null))
        .then((bootstrap) => applyBootstrapData(bootstrap, false))
        .catch(() => null);
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedSymbol, timeframe, chartReady, prefHydrated, applyBootstrapData]);


  useEffect(() => {
    if (!chartReady || !prefHydrated) return;
    const controller = new AbortController();
    candleSeries.current?.setData([]);
    volumeSeries.current?.setData([]);
    candlesRef.current = [];
    volumesRef.current = new Map();
    void fetch('/api/chart', { cache: 'no-store', signal: controller.signal })
      .then(async (res) => (res.ok ? (res.json() as Promise<ChartBootstrapResponse>) : null))
      .then((bootstrap) => applyBootstrapData(bootstrap, true))
      .catch(() => null);
    return () => controller.abort();
  }, [marketChip.id, chartReady, prefHydrated, applyBootstrapData]);

  useEffect(() => {
    if (!chartApi.current || typeof zoomLogical !== 'number') return;
    chartApi.current.timeScale().setVisibleLogicalRange({ from: zoomLogical - 120, to: zoomLogical });
  }, [zoomLogical]);

  useEffect(() => {
    if (!candleSeries.current) return;
    const markers: SeriesMarker<Time>[] = trades.slice(0, 30).map((t) => {
      const eventSec = Math.floor(new Date(t.time).getTime() / 1000);
      const candleTime = nearestCandleTime(candlesRef.current, eventSec);
      return {
        time: candleTime,
        position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: t.side === 'BUY' ? '#3cff8d' : '#ff5c8d',
        shape: t.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `${signalLabelAr(t.side)} $${t.sizeUsd.toFixed(2)} @ ${(t.fillPrice ?? t.price).toFixed(2)} · رسوم ${(t.feeUsd ?? 0).toFixed(2)} · انزلاق ${(t.slippageUsd ?? 0).toFixed(2)} · ${(t.latencyMs ?? 0)}ms · ${formatTimeAr(t.time)}`,
      };
    });
    markersApi.current?.setMarkers(markers);
  }, [trades]);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b') buyInputRef.current?.focus();
      if (e.key.toLowerCase() === 's') sellInputRef.current?.focus();
      if (e.key === 'Escape') {
        setWarning('');
        setTooltip('');
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, []);

  useEffect(() => {
    if (wallet && !buyAmount) setBuyAmount((wallet.cashBalance * 0.25).toFixed(2));
  }, [wallet, buyAmount]);

  const act = async (side: 'BUY' | 'SELL', payload: Record<string, unknown>) => {
    const endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const errorMessage = typeof body.error === 'string' ? body.error : 'Trade failed';
      setWarning(localizeApiError(errorMessage));
      return;
    }
    if (meta.action !== side && meta.action !== 'NO_TRADE') setWarning(`الذكاء الفوقي غير متوافق: ${localizeReasonText(meta.reason)}`);
    else setWarning('');
    fetchWallet();
    fetchActivity();
  };

  const withdrawTaxPercent = wallet?.withdrawTaxPercent ?? 0;
  const reservedWithdrawalAmount = wallet?.reservedWithdrawalAmount ?? 0;
  const withdrawableBalance = wallet?.withdrawableBalance ?? wallet?.cashBalance ?? 0;

  const withdrawPreview = useMemo(() => {
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const taxAmount = Math.round((((amount * withdrawTaxPercent) / 100) + Number.EPSILON) * 100) / 100;
    const netAmount = Math.round((Math.max(0, amount - taxAmount) + Number.EPSILON) * 100) / 100;
    return { amount, taxAmount, netAmount };
  }, [withdrawAmount, withdrawTaxPercent]);

  const requestWithdrawal = async () => {
    setWarning('');
    setWithdrawNotice('');

    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawNotice('يرجى إدخال مبلغ سحب صحيح أكبر من صفر.');
      return;
    }

    setWithdrawBusy(true);
    const res = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    setWithdrawBusy(false);

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errorMessage = typeof body.error === 'string' ? body.error : 'تعذر إرسال طلب السحب.';
      setWithdrawNotice(localizeApiError(errorMessage));
      return;
    }

    setWithdrawAmount('');
    setWithdrawNotice('تم إرسال طلب السحب بنجاح. الطلب بانتظار موافقة الإدارة.');
    fetchWallet();
    fetchActivity();
  };

  const normalizedSignals = useMemo<NormalizedModelSignal[]>(
    () =>
      signals.map((signal) => ({
        ...signal,
        signal: normalizeSignalState(signal.signal),
      })),
    [signals],
  );

  const aiBlinkers = useMemo<BlinkerSignal[]>(
    () =>
      COMMITTEE_MODELS.map((model) => {
        const signal = normalizedSignals.find((entry) => entry.model === model);
        if (signal) {
          return {
            model,
            signal: signal.signal,
            confidence: signal.confidence,
            hitRate: hitRates.agents[model] ?? 0,
            reason: signal.reasons[0] ?? 'No reason available',
          };
        }
        return {
          model,
          signal: 'NO_TRADE',
          confidence: 0,
          hitRate: hitRates.agents[model] ?? 0,
          reason: 'بانتظار إشارة مباشرة',
        };
      }),
    [normalizedSignals, hitRates.agents],
  );

  const committeeSummary = useMemo(() => {
    const buy = normalizedSignals.filter((signal) => signal.signal === 'BUY').length;
    const sell = normalizedSignals.filter((signal) => signal.signal === 'SELL').length;
    const noTrade = normalizedSignals.filter((signal) => signal.signal === 'NO_TRADE').length;
    const hasConflict = buy > 0 && sell > 0;
    const hasStrongConsensus = buy >= 4 || sell >= 4;
    const confidenceGatePass = meta.confidence > 70;
    const decisionAligned = meta.action === 'BUY' ? buy >= 4 : meta.action === 'SELL' ? sell >= 4 : true;

    return {
      buy,
      sell,
      noTrade,
      hasConflict,
      hasStrongConsensus,
      confidenceGatePass,
      decisionAligned,
    };
  }, [normalizedSignals, meta.action, meta.confidence]);

  const tradeTape = useMemo(() => trades.slice(0, 20), [trades]);

  return (
    <div style={styles.page} dir="rtl" lang="ar">
      <div className="glass" style={styles.row}>
        <div>الرصيد النقدي ${wallet?.cashBalance.toFixed(2) ?? '--'}</div>
        <div>صافي القيمة ${(wallet?.liveEquity ?? wallet?.equity ?? 0).toFixed(2)}</div>
        <div>قيمة المركز ${(wallet?.positionValue ?? 0).toFixed(2)}</div>
        <div style={{ color: (wallet?.pnlTotal ?? 0) >= 0 ? '#3cff8d' : '#ff5c8d' }}>الأرباح/الخسائر ${wallet?.pnlTotal.toFixed(2) ?? '--'}</div>
        <div>ضريبة السحب {withdrawTaxPercent.toFixed(2)}%</div>
        <div>المتاح للسحب ${withdrawableBalance.toFixed(2)}</div>
      </div>

      <div className="glass" style={styles.chartShell}>
        <div style={styles.controls}>
          <select value={selectedSymbol} onChange={(e) => setSelectedSymbol(normalizeGraphMode(e.target.value))} style={styles.input}>
            {GRAPH_MODES.map((symbol) => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
          <select value={timeframe} onChange={(e) => setTimeframe(normalizeGraphTimeframe(e.target.value))} style={styles.input}>
            {GRAPH_TIMEFRAMES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
        <div style={{ color: 'var(--muted)', marginBottom: 6 }}>
          {marketChip.id} • {marketChip.regimeOverride} • x{marketChip.intensity.toFixed(2)}
        </div>
        <div style={{ color: 'var(--muted)', marginBottom: 6 }}>AI: {marketChip.aiName} ({marketChip.aiTone})</div>
        <div style={styles.legendRow}>
          <span style={{ ...styles.legendItem, color: '#ffd166' }}>المتوسط الأسي 20</span>
          <span style={{ ...styles.legendItem, color: '#6ea8ff' }}>المتوسط الأسي 50</span>
          <span style={{ ...styles.legendItem, color: 'rgba(255,92,141,0.85)' }}>النطاق العلوي</span>
          <span style={{ ...styles.legendItem, color: 'rgba(92,255,173,0.85)' }}>النطاق السفلي</span>
        </div>
        <div style={styles.chartViewport}>
          <div ref={chartRef} style={styles.chartCanvas} />
        </div>
        <div style={{ color: 'var(--muted)', marginTop: 6 }}>{tooltip || localizeReasonText(metaStatusText || meta.reason)}</div>
      </div>

      <div style={styles.tradeGrid}>
        <div className="glass" style={styles.card}>
          <h3>شراء (B)</h3>
          <input ref={buyInputRef} value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} type="number" style={styles.input} />
          <div style={styles.quickRow}>{[0.25, 0.5, 1].map((pct) => <button key={pct} style={styles.quickBtn} onClick={() => setBuyAmount(((wallet?.cashBalance ?? 0) * pct).toFixed(2))}>{pct * 100}%</button>)}</div>
          <button style={{ ...styles.button, background: '#ff5c8d' }} onClick={() => act('BUY', { amountUsd: Number(buyAmount) })}>تنفيذ الشراء</button>
        </div>
        <div className="glass" style={styles.card}>
          <h3>بيع (S)</h3>
          <input ref={sellInputRef} type="number" value={sellPercent} min={1} max={100} onChange={(e) => setSellPercent(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} style={styles.input} />
          <div style={styles.quickRow}>{[25, 50, 100].map((pct) => <button key={pct} style={styles.quickBtn} onClick={() => setSellPercent(pct)}>{pct}%</button>)}</div>
          <button style={{ ...styles.button, background: '#3cff8d', color: '#07110b' }} onClick={() => act('SELL', { sellPercent })}>بيع {sellPercent}%</button>
        </div>
        <div className="glass" style={styles.card}>
          <h3>سحب</h3>
          <div style={styles.signalStats}>الضريبة الحالية: {withdrawTaxPercent.toFixed(2)}%</div>
          <input
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            type="number"
            min={0}
            step="0.01"
            placeholder="أدخل مبلغ السحب"
            style={styles.input}
          />
          <div style={styles.quickRow}>
            {[0.25, 0.5, 1].map((pct) => (
              <button key={pct} style={styles.quickBtn} onClick={() => setWithdrawAmount((withdrawableBalance * pct).toFixed(2))}>
                {pct * 100}%
              </button>
            ))}
          </div>
          {withdrawPreview && (
            <div style={styles.summaryRow}>
              <span style={styles.statusChipInfo}>الإجمالي ${withdrawPreview.amount.toFixed(2)}</span>
              <span style={styles.statusChipWarn}>الضريبة ${withdrawPreview.taxAmount.toFixed(2)}</span>
              <span style={styles.statusChipPass}>الصافي ${withdrawPreview.netAmount.toFixed(2)}</span>
            </div>
          )}
          <div style={styles.signalStats}>محجوز لطلبات معلّقة: ${reservedWithdrawalAmount.toFixed(2)}</div>
          <button style={{ ...styles.button, background: '#ffd166', color: '#121212' }} onClick={() => void requestWithdrawal()} disabled={withdrawBusy}>
            {withdrawBusy ? 'جاري الإرسال...' : 'إرسال طلب السحب'}
          </button>
          {withdrawNotice && (
            <div style={{ color: withdrawNotice.startsWith('تم ') ? '#5df3a6' : '#ffb347', fontSize: 12, marginTop: 8 }}>
              {withdrawNotice}
            </div>
          )}
        </div>
      </div>

      {warning && <div style={{ color: '#ffb347' }}>{warning}</div>}

      <div style={styles.panels}>
        <div className="glass" style={styles.card}>
          <button style={styles.toggle} onClick={() => setCollapsed((v) => ({ ...v, ai: !v.ai }))}><h3>لوحة الذكاء الاصطناعي</h3></button>
          {!collapsed.ai && <>
            <div style={styles.signalRow}>
              <span className={signalLightClassName(meta.action)} />
              <strong>الفوقي</strong>
              <span>{signalLabelAr(meta.action)}</span>
              <span style={styles.signalStats}>({meta.confidence}% · إصابة {hitRates.meta}%)</span>
            </div>
            <div style={styles.summaryRow}>
              <span style={styles.voteChipBuy}>شراء {committeeSummary.buy}</span>
              <span style={styles.voteChipSell}>بيع {committeeSummary.sell}</span>
              <span style={styles.voteChipNeutral}>حياد {committeeSummary.noTrade}</span>
            </div>
            <div style={styles.summaryRow}>
              <span style={committeeSummary.hasStrongConsensus ? styles.statusChipPass : styles.statusChipWarn}>
                الإجماع {committeeSummary.hasStrongConsensus ? 'قوي' : 'ضعيف'}
              </span>
              <span style={committeeSummary.confidenceGatePass ? styles.statusChipPass : styles.statusChipWarn}>
                بوابة الثقة {committeeSummary.confidenceGatePass ? 'ناجحة' : 'فاشلة'}
              </span>
              <span style={committeeSummary.hasConflict ? styles.statusChipWarn : styles.statusChipInfo}>
                {committeeSummary.hasConflict ? 'تم رصد تعارض' : 'بدون تعارض'}
              </span>
              <span style={committeeSummary.decisionAligned ? styles.statusChipInfo : styles.statusChipWarn}>
                {committeeSummary.decisionAligned ? 'القرار متوافق' : 'القرار يحتاج حذر'}
              </span>
              <span style={styles.signalStats}>آخر تحديث {lastAiUpdate || '--'}</span>
            </div>
            <div style={styles.signalReason}>{localizeReasonText(meta.reason)}</div>
            <div className="ai-blinker-grid">
              {aiBlinkers.map((s) => (
                <div key={s.model} className="ai-blinker-card">
                  <span className={aiBlinkerClassName(s.signal)}>
                    <span className="ai-blinker-core">{blinkerSignalText(s.signal)}</span>
                  </span>
                  <span className="ai-blinker-stats">{s.confidence}% · إصابة {s.hitRate}%</span>
                  <span className="ai-blinker-reason">{localizeReasonText(s.reason)}</span>
                </div>
              ))}
            </div>
          </>}
        </div>

        <div className="glass" style={styles.card}>
          <button style={styles.toggle} onClick={() => setCollapsed((v) => ({ ...v, tape: !v.tape }))}><h3>سجل الصفقات (20)</h3></button>
          {!collapsed.tape && tradeTape.map((t) => <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{formatTimeAr(t.time)}</span><span>{signalLabelAr(t.side)}</span><span>${t.sizeUsd.toFixed(0)}</span></div>)}
        </div>

        <div className="glass" style={styles.card}>
          <button style={styles.toggle} onClick={() => setCollapsed((v) => ({ ...v, activity: !v.activity }))}><h3>سجل النشاط</h3></button>
          {!collapsed.activity && events.slice(0, 20).map((e) => <div key={e.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, fontSize: 12 }}><strong>{localizeEventType(e.eventType)}</strong> · {localizeRole(e.actorRole)}<div style={{ color: 'var(--muted)' }}>{formatDateTimeAr(e.createdAt)}</div></div>)}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 1200, margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 16, padding: 12, flexWrap: 'wrap' },
  chartShell: {
    padding: 12,
    position: 'relative',
    overflow: 'hidden',
    isolation: 'isolate',
  },
  controls: { display: 'flex', gap: 10, marginBottom: 8 },
  legendRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' },
  legendItem: {
    fontSize: 11,
    border: '1px solid var(--border)',
    borderRadius: 999,
    padding: '3px 8px',
    background: 'rgba(15,23,43,0.8)',
    letterSpacing: 0.3,
  },
  chartViewport: {
    width: '100%',
    height: 430,
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    isolation: 'isolate',
    contain: 'layout paint',
    background: 'rgba(6,10,22,0.78)',
    zIndex: 0,
  },
  chartCanvas: { width: '100%', height: '100%', position: 'relative', overflow: 'hidden', display: 'block', zIndex: 0 },
  tradeGrid: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', position: 'relative', zIndex: 1 },
  panels: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', position: 'relative', zIndex: 1 },
  card: { padding: 12 },
  input: { width: '100%', padding: '0.6rem', border: '1px solid var(--border)', borderRadius: 8, background: '#0f172b', color: 'var(--text)' },
  quickRow: { display: 'flex', gap: 6, marginTop: 6, marginBottom: 8 },
  quickBtn: { border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', background: 'transparent', color: 'var(--text)' },
  button: { width: '100%', border: 'none', borderRadius: 10, padding: '0.8rem', fontWeight: 700, color: '#fff' },
  toggle: { width: '100%', textAlign: 'right', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  signalRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
  signalStats: { color: 'var(--muted)', fontSize: 12 },
  summaryRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 },
  voteChipBuy: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#3cff8d',
    border: '1px solid rgba(60,255,141,0.35)',
    background: 'rgba(60,255,141,0.12)',
  },
  voteChipSell: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#ff5c8d',
    border: '1px solid rgba(255,92,141,0.35)',
    background: 'rgba(255,92,141,0.12)',
  },
  voteChipNeutral: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#ffd166',
    border: '1px solid rgba(255,209,102,0.35)',
    background: 'rgba(255,209,102,0.12)',
  },
  statusChipPass: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#3cff8d',
    border: '1px solid rgba(60,255,141,0.3)',
    background: 'rgba(60,255,141,0.08)',
  },
  statusChipWarn: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#ffb347',
    border: '1px solid rgba(255,179,71,0.35)',
    background: 'rgba(255,179,71,0.1)',
  },
  statusChipInfo: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#9cb7ff',
    border: '1px solid rgba(156,183,255,0.3)',
    background: 'rgba(156,183,255,0.1)',
  },
  signalReason: { color: 'var(--muted)', fontSize: 12, marginTop: 4 },
};
