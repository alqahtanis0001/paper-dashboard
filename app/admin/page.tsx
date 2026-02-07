'use client';

import { CSSProperties, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import io, { type Socket } from 'socket.io-client';
import {
  GRAPH_MODES,
  GRAPH_TIMEFRAMES,
  NON_AUTO_GRAPH_MODES,
  type GraphMode,
  type GraphTimeframe,
  normalizeGraphMode,
  normalizeGraphTimeframe,
} from '@/lib/engine/graphModes';

type DealStatus = 'SCHEDULED' | 'RUNNING' | 'FINISHED';

type Deal = {
  id: string;
  symbol: string;
  chainName: string;
  basePrice: number;
  startTimeUtc: string;
  totalDurationSec: number;
  dropDelaySec: number;
  dropMagnitudePct: number;
  status: DealStatus;
  jumps: {
    riseDelaySec: number;
    riseMagnitudePct: number;
    holdSec: number;
    orderIndex: number;
  }[];
};

type WithdrawalRequest = {
  id: string;
  time: string;
  amount: number;
  taxPercent: number;
  taxAmount: number;
  netAmount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  processedAt: string | null;
};

type JumpDraft = {
  riseDelaySec: number;
  riseMagnitudePct: number;
  holdSec: number;
};

type DealFormState = {
  symbol: string;
  chainName: string;
  basePrice: number;
  startTimeLocal: string;
  totalDurationSec: number;
  dropDelaySec: number;
  dropMagnitudePct: number;
};

type AiSignal = {
  model: string;
  signal: 'BUY' | 'SELL' | 'NO_TRADE';
  confidence: number;
  reasons: string[];
};

type ControlState = {
  symbol: string;
  market: {
    id: string;
    label: string;
    regimeOverride: 'AUTO' | 'BULL' | 'BEAR' | 'CHOPPY' | 'HIGH_VOL' | 'LOW_VOL';
    intensity: number;
  };
  selectedGraphMode: GraphMode;
  timeframe: GraphTimeframe;
  activeDealId: string | null;
  hasRunningDeal: boolean;
  metaStatus: { text: string; stage: string };
  ai: {
    signals: AiSignal[];
    meta: { action: 'BUY' | 'SELL' | 'NO_TRADE'; confidence: number; reason: string };
    hitRates: { meta: number; agents: Record<string, number> };
    lastSignalAt: number | null;
  };
};

type UserAccessContext = {
  lastLoginAt: string | null;
  ip: string | null;
  ipHash: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timezone: string | null;
  org: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: string | null;
  privateIp: boolean | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  deviceName: string;
  userAgent: string | null;
  marketing: {
    landingPath: string | null;
    referrer: string | null;
    referrerHost: string | null;
    language: string | null;
    languages: string[];
    locale: string | null;
    clientTimezone: string | null;
    platform: string | null;
    deviceModel: string | null;
    devicePlatform: string | null;
    devicePlatformVersion: string | null;
    deviceArchitecture: string | null;
    deviceBitness: string | null;
    browserFullVersion: string | null;
    browserBrands: string[];
    deviceMemoryGb: number | null;
    hardwareConcurrency: number | null;
    trafficChannel: string | null;
    campaignLabel: string | null;
    audienceSegment: string | null;
    partOfDay: string | null;
    localHour: number | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmTerm: string | null;
    utmContent: string | null;
    clickIds: {
      gclid: string | null;
      fbclid: string | null;
      ttclid: string | null;
      msclkid: string | null;
    };
    connectionType: string | null;
    downlinkMbps: number | null;
    rttMs: number | null;
    saveData: boolean | null;
    viewportWidth: number | null;
    viewportHeight: number | null;
    screenWidth: number | null;
    screenHeight: number | null;
    colorDepth: number | null;
  };
  session: {
    id: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    revokedAt: string | null;
    isActive: boolean;
  } | null;
  sessionInsights: {
    freshnessLabel: string;
    lastSeenLabel: string;
    expiresInLabel: string;
  };
  aggregates: {
    loginsLast24h: number;
    loginsLast7d: number;
    trafficVolumeLabel: string;
    topChannels: { label: string; count: number; sharePct: number }[];
    topCountries: { label: string; count: number; sharePct: number }[];
    topDevices: { label: string; count: number; sharePct: number }[];
    topCampaigns: { label: string; count: number; sharePct: number }[];
    plainSummary: string;
  };
};

type RuntimeDiagnostics = {
  runtimeTarget: 'render' | 'local' | 'other';
  nodeEnv: string;
  isRender: boolean;
  isLocal: boolean;
  storageMode:
    | 'render-internal-postgres'
    | 'render-external-postgres'
    | 'local-postgres'
    | 'external-postgres'
    | 'unconfigured';
  hasDatabase: boolean;
  databaseHost: string | null;
  databaseSslMode: string | null;
  databaseSource:
    | 'database_url'
    | 'render_internal_database_url'
    | 'internal_database_url'
    | 'local_database_url'
    | 'none';
  databaseUrlAdapted: boolean;
  secureCookies: boolean;
  notes: string[];
};

const CHAIN_PRESETS: Record<string, { chainName: string; basePrice: number }> = {
  'BTC/USDT': { chainName: 'Bitcoin', basePrice: 62000 },
  'ETH/USDT': { chainName: 'Ethereum', basePrice: 3200 },
  'SOL/USDT': { chainName: 'Solana', basePrice: 170 },
  'BNB/USDT': { chainName: 'BNB Chain', basePrice: 560 },
  'XRP/USDT': { chainName: 'XRP Ledger', basePrice: 0.62 },
  'ADA/USDT': { chainName: 'Cardano', basePrice: 0.56 },
  'DOGE/USDT': { chainName: 'Dogecoin', basePrice: 0.16 },
  'AVAX/USDT': { chainName: 'Avalanche', basePrice: 41 },
  'LINK/USDT': { chainName: 'Chainlink', basePrice: 22 },
  'DOT/USDT': { chainName: 'Polkadot', basePrice: 8.5 },
  'MATIC/USDT': { chainName: 'Polygon', basePrice: 1.15 },
  'LTC/USDT': { chainName: 'Litecoin', basePrice: 92 },
  'BCH/USDT': { chainName: 'Bitcoin Cash', basePrice: 420 },
  'ATOM/USDT': { chainName: 'Cosmos', basePrice: 12 },
  'UNI/USDT': { chainName: 'Uniswap', basePrice: 8 },
  'TRX/USDT': { chainName: 'Tron', basePrice: 0.11 },
};

const statusColor: Record<DealStatus, string> = {
  SCHEDULED: '#ffd166',
  RUNNING: '#5df3a6',
  FINISHED: '#8aa0cc',
};
const withdrawalStatusColor: Record<WithdrawalRequest['status'], string> = {
  PENDING: '#ffd166',
  APPROVED: '#5df3a6',
  REJECTED: '#ff5c8d',
};

const fromLocalInput = (localDateTime: string) => dayjs(localDateTime).toISOString();
const nextStartLocal = (mins: number) => dayjs().add(mins, 'minute').format('YYYY-MM-DDTHH:mm');
const formatMoney = (amount: number) =>
  amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const formatPercent = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const KEEP_ALIVE_PING_INTERVAL_MS = 6 * 60 * 1000;
const formatClock = (value: number | null | undefined) => (typeof value === 'number' ? dayjs(value).format('HH:mm:ss') : '--');
const formatDateTime = (value: string | null | undefined) => (value ? dayjs(value).format('MMM D, YYYY HH:mm:ss') : '--');
const formatDistribution = (rows: { label: string; count: number; sharePct: number }[]) =>
  rows.map((row) => `${row.label} (${row.sharePct}% • ${row.count})`);
const metaActionColor = (action: 'BUY' | 'SELL' | 'NO_TRADE' | undefined) =>
  action === 'BUY' ? '#5df3a6' : action === 'SELL' ? '#ff5c8d' : '#ffd166';

const defaultForm = (): DealFormState => ({
  symbol: 'BTC/USDT',
  chainName: 'Bitcoin',
  basePrice: 62000,
  startTimeLocal: nextStartLocal(2),
  totalDurationSec: 90,
  dropDelaySec: 10,
  dropMagnitudePct: 8,
});

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [passkey, setPasskey] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const [deals, setDeals] = useState<Deal[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);

  const [loadingDeals, setLoadingDeals] = useState(false);
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(false);
  const [savingDeal, setSavingDeal] = useState(false);
  const [busyDealId, setBusyDealId] = useState<string | null>(null);
  const [busyWithdrawalId, setBusyWithdrawalId] = useState<string | null>(null);
  const [withdrawTaxPercent, setWithdrawTaxPercent] = useState(0);
  const [savingWithdrawTax, setSavingWithdrawTax] = useState(false);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'ALL' | DealStatus>('ALL');
  const [search, setSearch] = useState('');
  const [controlState, setControlState] = useState<ControlState | null>(null);
  const [controlSymbol, setControlSymbol] = useState<GraphMode>('AUTO');
  const [controlTimeframe, setControlTimeframe] = useState<GraphTimeframe>('1s');
  const [syncingControl, setSyncingControl] = useState(false);
  const [markets, setMarkets] = useState<Array<{ id: string; label: string }>>([]);
  const [activeMarketId, setActiveMarketId] = useState('BTC');
  const [regimeOverride, setRegimeOverride] = useState<'AUTO' | 'BULL' | 'BEAR' | 'CHOPPY' | 'HIGH_VOL' | 'LOW_VOL'>('AUTO');
  const [intensity, setIntensity] = useState(1);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeDiagnostics | null>(null);
  const [loadingRuntimeInfo, setLoadingRuntimeInfo] = useState(false);
  const [userAccess, setUserAccess] = useState<UserAccessContext | null>(null);
  const [loadingUserAccess, setLoadingUserAccess] = useState(false);

  const [form, setForm] = useState<DealFormState>(defaultForm());
  const [jumps, setJumps] = useState<JumpDraft[]>([{ riseDelaySec: 30, riseMagnitudePct: 12, holdSec: 8 }]);

  const loadDeals = useCallback(async () => {
    setLoadingDeals(true);
    const res = await fetch('/api/admin/deals');
    setLoadingDeals(false);
    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }
    if (!res.ok) {
      setError('Failed to load deals.');
      return;
    }
    const body = await res.json();
    setDeals(body.deals ?? []);
  }, []);

  const loadWithdrawals = useCallback(async () => {
    setLoadingWithdrawals(true);
    const res = await fetch('/api/admin/withdrawals');
    setLoadingWithdrawals(false);
    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }
    if (!res.ok) {
      setError('Failed to load withdrawals.');
      return;
    }
    const body = (await res.json()) as { requests?: WithdrawalRequest[]; taxPercent?: number };
    setWithdrawals(body.requests ?? []);
    if (typeof body.taxPercent === 'number' && Number.isFinite(body.taxPercent)) {
      setWithdrawTaxPercent(body.taxPercent);
    }
  }, []);

  const applyControlState = useCallback((next: ControlState) => {
    setControlState(next);
    setControlSymbol(normalizeGraphMode(next.selectedGraphMode));
    setControlTimeframe(normalizeGraphTimeframe(next.timeframe));
    if (next.market?.id) setActiveMarketId(next.market.id);
    if (next.market?.regimeOverride) setRegimeOverride(next.market.regimeOverride);
    if (typeof next.market?.intensity === 'number') setIntensity(next.market.intensity);
  }, []);

  const loadControlState = useCallback(async () => {
    const res = await fetch('/api/admin/control-state', { cache: 'no-store' });
    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }
    if (!res.ok) {
      setError('Failed to load control state.');
      return;
    }
    const body = (await res.json()) as { controlState?: ControlState };
    if (body.controlState) applyControlState(body.controlState);
  }, [applyControlState]);

  const loadUserAccess = useCallback(async () => {
    setLoadingUserAccess(true);
    const res = await fetch('/api/admin/user-context', { cache: 'no-store' });
    setLoadingUserAccess(false);
    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }
    if (!res.ok) {
      setError('Failed to load user access details.');
      return;
    }
    const body = (await res.json()) as { userContext?: UserAccessContext };
    setUserAccess(body.userContext ?? null);
  }, []);

  const loadRuntimeInfo = useCallback(async () => {
    setLoadingRuntimeInfo(true);
    const res = await fetch('/api/admin/runtime', { cache: 'no-store' });
    setLoadingRuntimeInfo(false);
    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }
    if (!res.ok) {
      setError('Failed to load runtime diagnostics.');
      return;
    }
    const body = (await res.json()) as { runtime?: RuntimeDiagnostics };
    setRuntimeInfo(body.runtime ?? null);
  }, []);

  const loadMarkets = useCallback(async () => {
    const res = await fetch('/api/markets', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { markets?: Array<{ id: string; label: string }> };
    setMarkets(body.markets ?? []);
  }, []);

  const refreshAll = useCallback(async () => {
    setError('');
    await Promise.all([loadDeals(), loadWithdrawals(), loadControlState(), loadUserAccess(), loadRuntimeInfo(), loadMarkets()]);
  }, [loadDeals, loadWithdrawals, loadControlState, loadUserAccess, loadRuntimeInfo, loadMarkets]);

  useEffect(() => {
    if (!authed || !autoRefresh) return;
    const timer = setInterval(() => {
      void refreshAll();
    }, 10000);
    return () => clearInterval(timer);
  }, [authed, autoRefresh, refreshAll]);

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
    if (!authed) return;
    let disposed = false;
    let socket: Socket | null = null;

    const setup = async () => {
      await fetch('/api/socket').catch(() => null);
      if (disposed) return;

      socket = io('', { path: '/api/socket' });
      socket.on('control_state', (payload: ControlState) => {
        applyControlState(payload);
      });
      socket.on('market_selected', (payload: { symbol?: string; timeframe?: string }) => {
        if (payload.symbol) setControlSymbol(normalizeGraphMode(payload.symbol));
        if (payload.timeframe) setControlTimeframe(normalizeGraphTimeframe(payload.timeframe));
      });
      socket.on('meta_status', (payload: { text?: string; stage?: string }) => {
        if (!payload.text && !payload.stage) return;
        setControlState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            metaStatus: {
              text: payload.text ?? prev.metaStatus.text,
              stage: payload.stage ?? prev.metaStatus.stage,
            },
          };
        });
      });
    };

    void setup();
    return () => {
      disposed = true;
      socket?.disconnect();
    };
  }, [authed, applyControlState]);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Login failed');
      return;
    }

    setAuthed(true);
    setPasskey('');
    setInfo('Authenticated.');
    await refreshAll();
  };

  const setStartOffset = (mins: number) => {
    setForm((prev) => ({ ...prev, startTimeLocal: nextStartLocal(mins) }));
  };

  const syncControlState = async () => {
    setError('');
    setInfo('');
    setSyncingControl(true);

    const res = await fetch('/api/admin/control-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedSymbol: controlSymbol, timeframe: controlTimeframe }),
    });

    setSyncingControl(false);
    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Control sync failed.');
      return;
    }

    const body = (await res.json()) as { controlState?: ControlState };
    if (body.controlState) applyControlState(body.controlState);

    await fetch('/api/admin/market-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeMarketId, regimeOverride, intensity }),
    }).catch(() => null);

    setInfo('Control state synchronized.');
  };

  const triggerEvent = async (kind: 'NEWS_SPIKE' | 'DUMP' | 'SQUEEZE') => {
    await fetch('/api/admin/trigger-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, strength: intensity }),
    }).catch(() => null);
  };

  const applySymbolPreset = (symbol: string) => {
    const preset = CHAIN_PRESETS[symbol];
    setForm((prev) => ({
      ...prev,
      symbol,
      chainName: preset?.chainName ?? prev.chainName,
      basePrice: preset?.basePrice ?? prev.basePrice,
    }));
  };

  const validateDealForm = () => {
    const issues: string[] = [];
    if (!form.symbol.trim()) issues.push('Symbol is required.');
    if (!form.chainName.trim()) issues.push('Chain name is required.');
    if (!Number.isFinite(form.basePrice) || form.basePrice <= 0) issues.push('Base price must be greater than 0.');
    if (!dayjs(form.startTimeLocal).isValid()) issues.push('Start time is invalid.');
    if (!Number.isFinite(form.totalDurationSec) || form.totalDurationSec <= 0) issues.push('Duration must be greater than 0.');
    if (!Number.isFinite(form.dropDelaySec) || form.dropDelaySec < 0) issues.push('Drop delay must be 0 or greater.');
    if (form.dropDelaySec >= form.totalDurationSec) issues.push('Drop delay should be less than duration.');
    if (!Number.isFinite(form.dropMagnitudePct)) issues.push('Drop % must be a valid number.');

    if (!jumps.length) issues.push('Add at least one rise jump.');

    jumps.forEach((jump, index) => {
      if (!Number.isFinite(jump.riseDelaySec) || jump.riseDelaySec < 0) issues.push(`Jump ${index + 1}: rise delay must be 0 or greater.`);
      if (!Number.isFinite(jump.riseMagnitudePct)) issues.push(`Jump ${index + 1}: rise % must be a valid number.`);
      if (!Number.isFinite(jump.holdSec) || jump.holdSec < 0) issues.push(`Jump ${index + 1}: hold sec must be 0 or greater.`);
    });

    return issues;
  };

  const createDeal = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');

    const issues = validateDealForm();
    if (issues.length > 0) {
      setError(issues[0]);
      return;
    }

    setSavingDeal(true);
    const payload = {
      symbol: form.symbol.trim(),
      chainName: form.chainName.trim(),
      basePrice: form.basePrice,
      startTimeUtc: fromLocalInput(form.startTimeLocal),
      totalDurationSec: form.totalDurationSec,
      dropDelaySec: form.dropDelaySec,
      dropMagnitudePct: form.dropMagnitudePct,
      jumps: jumps.map((jump, index) => ({ ...jump, orderIndex: index })),
    };

    const res = await fetch('/api/admin/deal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSavingDeal(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Create failed');
      return;
    }

    setInfo('Deal created successfully.');
    setForm((prev) => ({ ...prev, startTimeLocal: nextStartLocal(3) }));
    await refreshAll();
  };

  const activateDeal = async (id: string) => {
    setError('');
    setInfo('');
    setBusyDealId(id);

    const res = await fetch('/api/admin/deal/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, startNow: true }),
    });

    setBusyDealId(null);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Activation failed');
      return;
    }

    setInfo('Deal activated.');
    await refreshAll();
  };

  const deleteDeal = async (id: string) => {
    if (!window.confirm('Delete this deal? This cannot be undone.')) return;

    setError('');
    setInfo('');
    setBusyDealId(id);

    const res = await fetch(`/api/admin/deal/${id}`, { method: 'DELETE' });
    setBusyDealId(null);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Delete failed');
      return;
    }

    setInfo('Deal deleted.');
    await refreshAll();
  };

  const handleWithdrawal = async (id: string, action: 'APPROVE' | 'REJECT') => {
    setError('');
    setInfo('');
    setBusyWithdrawalId(id);

    const res = await fetch('/api/admin/withdrawals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });

    setBusyWithdrawalId(null);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `${action} failed`);
      return;
    }

    setInfo(action === 'APPROVE' ? 'Withdrawal approved.' : 'Withdrawal rejected.');
    await refreshAll();
  };

  const saveWithdrawTax = async () => {
    setError('');
    setInfo('');

    if (!Number.isFinite(withdrawTaxPercent) || withdrawTaxPercent < 0 || withdrawTaxPercent > 100) {
      setError('Tax % must be between 0 and 100.');
      return;
    }

    setSavingWithdrawTax(true);
    const res = await fetch('/api/admin/withdraw-tax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taxPercent: withdrawTaxPercent }),
    });
    setSavingWithdrawTax(false);

    if (res.status === 401) {
      setAuthed(false);
      setError('Admin session expired. Please log in again.');
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to update withdrawal tax.');
      return;
    }

    const body = (await res.json()) as { taxPercent?: number };
    if (typeof body.taxPercent === 'number') {
      setWithdrawTaxPercent(body.taxPercent);
      setInfo(`Withdrawal tax updated to ${formatPercent(body.taxPercent)}%.`);
    } else {
      setInfo('Withdrawal tax updated.');
    }
    await loadWithdrawals();
  };

  const filteredDeals = useMemo(() => {
    return deals.filter((deal) => {
      if (statusFilter !== 'ALL' && deal.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return deal.symbol.toLowerCase().includes(q) || deal.chainName.toLowerCase().includes(q);
    });
  }, [deals, statusFilter, search]);

  const summary = useMemo(() => {
    const scheduled = deals.filter((d) => d.status === 'SCHEDULED').length;
    const running = deals.filter((d) => d.status === 'RUNNING').length;
    const finished = deals.filter((d) => d.status === 'FINISHED').length;

    const nextDeal = deals
      .filter((d) => d.status === 'SCHEDULED')
      .sort((a, b) => dayjs(a.startTimeUtc).valueOf() - dayjs(b.startTimeUtc).valueOf())[0];

    return {
      scheduled,
      running,
      finished,
      nextStartLabel: nextDeal ? dayjs(nextDeal.startTimeUtc).format('MMM D, HH:mm:ss') : 'None',
    };
  }, [deals]);

  const userLocationLabel = [userAccess?.city, userAccess?.region, userAccess?.country].filter(Boolean).join(', ') || 'Unknown';
  const userSessionState = userAccess?.session?.isActive ? 'Active session' : 'No active session';
  const topChannelList = userAccess ? formatDistribution(userAccess.aggregates.topChannels) : [];
  const topCountryList = userAccess ? formatDistribution(userAccess.aggregates.topCountries) : [];
  const topDeviceList = userAccess ? formatDistribution(userAccess.aggregates.topDevices) : [];
  const topCampaignList = userAccess ? formatDistribution(userAccess.aggregates.topCampaigns) : [];
  const clickIdSummary = userAccess
    ? [
        userAccess.marketing.clickIds.gclid ? 'Google Ads ID' : null,
        userAccess.marketing.clickIds.fbclid ? 'Meta Ads ID' : null,
        userAccess.marketing.clickIds.ttclid ? 'TikTok Ads ID' : null,
        userAccess.marketing.clickIds.msclkid ? 'Microsoft Ads ID' : null,
      ].filter(Boolean).join(' • ')
    : '';

  if (!authed) {
    return (
      <div style={styles.pageCenter}>
        <div style={styles.loginCard} className="glass">
          <h1>Admin Console</h1>
          <p style={styles.mutedText}>Enter admin passkey to orchestrate scenarios.</p>
          <form onSubmit={login} style={{ width: '100%' }}>
            <input
              type="password"
              value={passkey}
              onChange={(e) => setPasskey(e.target.value)}
              placeholder="Admin passkey"
              style={styles.input}
              autoFocus
            />
            {error && <p style={styles.error}>{error}</p>}
            <button style={styles.button}>Authenticate</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Admin Dashboard</h1>
          <div style={styles.mutedText}>Manage scenarios, monitor execution, and control withdrawals.</div>
        </div>
        <div style={styles.headerActions}>
          <button onClick={() => void refreshAll()} style={{ ...styles.button, width: 'auto' }}>
            Refresh
          </button>
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto refresh
          </label>
        </div>
      </div>

      <div style={styles.summaryGrid}>
        <div className="glass" style={styles.summaryCard}><strong>{summary.scheduled}</strong><span style={styles.mutedText}>Scheduled</span></div>
        <div className="glass" style={styles.summaryCard}><strong>{summary.running}</strong><span style={styles.mutedText}>Running</span></div>
        <div className="glass" style={styles.summaryCard}><strong>{summary.finished}</strong><span style={styles.mutedText}>Finished</span></div>
        <div className="glass" style={styles.summaryCard}><strong>{summary.nextStartLabel}</strong><span style={styles.mutedText}>Next start</span></div>
      </div>

      {(error || info) && (
        <div style={{ ...styles.notice, ...(error ? styles.errorNotice : styles.infoNotice) }}>
          {error || info}
        </div>
      )}

      <div className="glass" style={{ ...styles.panel, order: 90 }}>
        <div style={styles.subHeaderRow}>
          <h2 style={styles.sectionTitle}>Runtime & Storage Profile</h2>
          <button type="button" onClick={() => void loadRuntimeInfo()} style={styles.quickBtn}>
            Reload Runtime
          </button>
        </div>

        {loadingRuntimeInfo && <div style={{ ...styles.mutedText, marginTop: 10 }}>Loading runtime diagnostics...</div>}

        {!loadingRuntimeInfo && runtimeInfo && (
          <div style={styles.userInfoGrid}>
            <div style={styles.syncStatCard}>
              <div style={styles.label}>Runtime Target</div>
              <strong>{runtimeInfo.runtimeTarget}</strong>
              <span style={styles.mutedText}>NODE_ENV={runtimeInfo.nodeEnv}</span>
            </div>
            <div style={styles.syncStatCard}>
              <div style={styles.label}>Storage Mode</div>
              <strong>{runtimeInfo.storageMode}</strong>
              <span style={styles.mutedText}>
                Host: {runtimeInfo.databaseHost ?? '--'} • source: {runtimeInfo.databaseSource}
              </span>
            </div>
            <div style={styles.syncStatCard}>
              <div style={styles.label}>Database Status</div>
              <strong>{runtimeInfo.hasDatabase ? 'Configured' : 'Not configured'}</strong>
              <span style={styles.mutedText}>
                sslmode={runtimeInfo.databaseSslMode ?? '--'} • adapted={runtimeInfo.databaseUrlAdapted ? 'yes' : 'no'}
              </span>
            </div>
            <div style={styles.syncStatCard}>
              <div style={styles.label}>Session Cookie Security</div>
              <strong>{runtimeInfo.secureCookies ? 'Secure cookie enabled' : 'Secure cookie disabled'}</strong>
              <span style={styles.mutedText}>
                {runtimeInfo.isRender ? 'Render profile' : runtimeInfo.isLocal ? 'Local profile' : 'Generic profile'}
              </span>
            </div>
          </div>
        )}

        {!loadingRuntimeInfo && runtimeInfo?.notes?.length ? (
          <div style={styles.userInfoFooter}>
            <div style={{ ...styles.mutedText, marginBottom: 4 }}>Runtime Notes</div>
            {runtimeInfo.notes.map((note) => (
              <div key={note} style={styles.mutedText}>{note}</div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="glass" style={{ ...styles.panel, order: 91 }}>
        <div style={styles.subHeaderRow}>
          <h2 style={styles.sectionTitle}>User Access Snapshot</h2>
          <button type="button" onClick={() => void loadUserAccess()} style={styles.quickBtn}>
            Reload Snapshot
          </button>
        </div>

        {loadingUserAccess && <div style={{ ...styles.mutedText, marginTop: 10 }}>Loading user access details...</div>}

        {!loadingUserAccess && !userAccess && <div style={{ ...styles.mutedText, marginTop: 10 }}>No user login data captured yet.</div>}

        {!loadingUserAccess && userAccess && (
          <>
            <div style={styles.userInfoGrid}>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Last User Login</div>
                <strong>{formatDateTime(userAccess.lastLoginAt)}</strong>
                <span style={styles.mutedText}>{userAccess.sessionInsights.freshnessLabel}</span>
              </div>

              <div style={styles.syncStatCard}>
                <div style={styles.label}>User City / Region</div>
                <strong>{userAccess.city ?? '--'}</strong>
                <span style={styles.mutedText}>{userLocationLabel}</span>
              </div>

              <div style={styles.syncStatCard}>
                <div style={styles.label}>IP Address</div>
                <strong style={styles.monoText}>{userAccess.ip ?? '--'}</strong>
                <span style={styles.mutedText}>Hash: {userAccess.ipHash ?? '--'}</span>
              </div>

              <div style={styles.syncStatCard}>
                <div style={styles.label}>Device Name</div>
                <strong>{userAccess.deviceName || '--'}</strong>
                <span style={styles.mutedText}>
                  {[userAccess.device, userAccess.browser, userAccess.os].filter(Boolean).join(' • ') || 'No browser fingerprint'}
                </span>
              </div>

              <div style={styles.syncStatCard}>
                <div style={styles.label}>Acquisition Channel</div>
                <strong>{userAccess.marketing.trafficChannel ?? '--'}</strong>
                <span style={styles.mutedText}>{userAccess.marketing.audienceSegment ?? 'General audience profile'}</span>
              </div>

              <div style={styles.syncStatCard}>
                <div style={styles.label}>Campaign / Source</div>
                <strong>{userAccess.marketing.campaignLabel ?? 'No tagged campaign'}</strong>
                <span style={styles.mutedText}>
                  {[
                    userAccess.marketing.utmSource ? `utm_source=${userAccess.marketing.utmSource}` : null,
                    userAccess.marketing.utmMedium ? `utm_medium=${userAccess.marketing.utmMedium}` : null,
                    userAccess.marketing.utmCampaign ? `utm_campaign=${userAccess.marketing.utmCampaign}` : null,
                  ].filter(Boolean).join(' • ') || 'No UTM tags detected'}
                </span>
              </div>
            </div>

            <div style={styles.userInfoFooter}>
              <div style={{ ...styles.mutedText, marginBottom: 4 }}>Marketing Summary</div>
              <div style={styles.mutedText}>{userAccess.aggregates.plainSummary}</div>
            </div>

            <div style={styles.userInfoGrid}>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Traffic Snapshot</div>
                <strong>{userAccess.aggregates.trafficVolumeLabel}</strong>
                <span style={styles.mutedText}>
                  24h logins: {userAccess.aggregates.loginsLast24h} • 7d logins: {userAccess.aggregates.loginsLast7d}
                </span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Top Channels (7d)</div>
                {topChannelList.length ? (
                  topChannelList.map((item) => (
                    <span key={item} style={styles.mutedText}>{item}</span>
                  ))
                ) : (
                  <span style={styles.mutedText}>No data yet</span>
                )}
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Top Devices (7d)</div>
                {topDeviceList.length ? (
                  topDeviceList.map((item) => (
                    <span key={item} style={styles.mutedText}>{item}</span>
                  ))
                ) : (
                  <span style={styles.mutedText}>No data yet</span>
                )}
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Top Countries (7d)</div>
                {topCountryList.length ? (
                  topCountryList.map((item) => (
                    <span key={item} style={styles.mutedText}>{item}</span>
                  ))
                ) : (
                  <span style={styles.mutedText}>No data yet</span>
                )}
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Top Campaigns (7d)</div>
                {topCampaignList.length ? (
                  topCampaignList.map((item) => (
                    <span key={item} style={styles.mutedText}>{item}</span>
                  ))
                ) : (
                  <span style={styles.mutedText}>No campaign data yet</span>
                )}
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Connection / Delivery Hint</div>
                <strong>{userAccess.marketing.connectionType ?? 'Unknown network type'}</strong>
                <span style={styles.mutedText}>
                  {[
                    typeof userAccess.marketing.downlinkMbps === 'number' ? `${userAccess.marketing.downlinkMbps.toFixed(1)} Mbps` : null,
                    typeof userAccess.marketing.rttMs === 'number' ? `${Math.round(userAccess.marketing.rttMs)} ms RTT` : null,
                    userAccess.marketing.saveData === true ? 'User enabled data saver' : null,
                  ].filter(Boolean).join(' • ') || 'No network telemetry'}
                </span>
              </div>
            </div>

            <div style={styles.userInfoGrid}>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Timezone / Local Window</div>
                <strong>{userAccess.marketing.clientTimezone ?? userAccess.timezone ?? '--'}</strong>
                <span style={styles.mutedText}>
                  {userAccess.marketing.partOfDay ?? '--'}
                  {typeof userAccess.marketing.localHour === 'number' ? ` • local hour ${userAccess.marketing.localHour}:00` : ''}
                </span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Language / Locale</div>
                <strong>{[userAccess.marketing.language, userAccess.marketing.locale].filter(Boolean).join(' • ') || '--'}</strong>
                <span style={styles.mutedText}>
                  {userAccess.marketing.languages.length ? userAccess.marketing.languages.join(' • ') : 'No language list'}
                </span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Referrer + Landing</div>
                <strong>{userAccess.marketing.referrerHost ?? 'Direct / no referrer'}</strong>
                <span style={styles.mutedText}>{userAccess.marketing.landingPath ?? '--'}</span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Ad Platform IDs</div>
                <strong>{clickIdSummary || 'No ad click IDs captured'}</strong>
                <span style={styles.mutedText}>
                  Geo source: {userAccess.locationSource ?? 'none'} • Private IP: {userAccess.privateIp === null ? '--' : userAccess.privateIp ? 'yes' : 'no'}
                </span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Session Health</div>
                <strong>{userSessionState}</strong>
                <span style={styles.mutedText}>{userAccess.sessionInsights.lastSeenLabel}</span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Session Expiry</div>
                <strong>{userAccess.sessionInsights.expiresInLabel}</strong>
                <span style={styles.mutedText}>Expires at {formatDateTime(userAccess.session?.expiresAt)}</span>
              </div>
            </div>

            <div style={styles.userInfoGrid}>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Session ID</div>
                <strong style={styles.monoText}>{userAccess.session?.id ?? '--'}</strong>
                <span style={styles.mutedText}>Created {formatDateTime(userAccess.session?.createdAt)}</span>
              </div>
              <div style={styles.syncStatCard}>
                <div style={styles.label}>Last Seen / Expires</div>
                <strong>{formatDateTime(userAccess.session?.lastSeenAt)}</strong>
                <span style={styles.mutedText}>Expires {formatDateTime(userAccess.session?.expiresAt)}</span>
              </div>
            </div>

            <div style={styles.userInfoFooter}>
              <div style={{ ...styles.mutedText, marginBottom: 4 }}>Technical Details (support/debug)</div>
              <div style={styles.mutedText}>
                {[
                  userAccess.marketing.platform,
                  userAccess.marketing.deviceModel ? `model ${userAccess.marketing.deviceModel}` : null,
                  userAccess.marketing.devicePlatformVersion ? `platform ${userAccess.marketing.devicePlatformVersion}` : null,
                  userAccess.marketing.deviceArchitecture ? `arch ${userAccess.marketing.deviceArchitecture}` : null,
                  userAccess.marketing.deviceBitness ? `${userAccess.marketing.deviceBitness}-bit` : null,
                  typeof userAccess.marketing.deviceMemoryGb === 'number' ? `${userAccess.marketing.deviceMemoryGb} GB memory hint` : null,
                  typeof userAccess.marketing.hardwareConcurrency === 'number' ? `${userAccess.marketing.hardwareConcurrency} CPU threads` : null,
                  userAccess.marketing.browserFullVersion ? `browser ${userAccess.marketing.browserFullVersion}` : null,
                  userAccess.marketing.browserBrands.length ? userAccess.marketing.browserBrands.join(' | ') : null,
                  typeof userAccess.marketing.viewportWidth === 'number' && typeof userAccess.marketing.viewportHeight === 'number'
                    ? `viewport ${userAccess.marketing.viewportWidth}x${userAccess.marketing.viewportHeight}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' • ') || 'No extra device dimensions'}
              </div>
              <div style={styles.monoText}>{userAccess.userAgent ?? '--'}</div>
            </div>
          </>
        )}
      </div>

      <div className="glass" style={styles.panel}>
        <div style={styles.subHeaderRow}>
          <h2 style={styles.sectionTitle}>Live Sync Control</h2>
          <div style={styles.inlineControls}>
            <button type="button" onClick={() => void loadControlState()} style={styles.quickBtn}>
              Pull Live
            </button>
            <button type="button" onClick={() => void syncControlState()} disabled={syncingControl} style={styles.button}>
              {syncingControl ? 'Syncing...' : 'Sync Admin -> Graph & AI'}
            </button>
          </div>
        </div>

        <div style={styles.syncGrid}>
          <div>
            <div style={styles.label}>Graph Mode</div>
            <select style={styles.input} value={controlSymbol} onChange={(e) => setControlSymbol(normalizeGraphMode(e.target.value))}>
              {GRAPH_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={styles.label}>Timeframe</div>
            <select style={styles.input} value={controlTimeframe} onChange={(e) => setControlTimeframe(normalizeGraphTimeframe(e.target.value))}>
              {GRAPH_TIMEFRAMES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={styles.label}>Active Market</div>
            <select style={styles.input} value={activeMarketId} onChange={(e) => setActiveMarketId(e.target.value)}>
              {(markets.length ? markets : [{ id: 'BTC', label: 'Bitcoin' }]).map((m) => (
                <option key={m.id} value={m.id}>{m.id} • {m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={styles.label}>Regime Override</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(['AUTO', 'BULL', 'BEAR', 'CHOPPY', 'HIGH_VOL', 'LOW_VOL'] as const).map((item) => (
                <button key={item} type="button" onClick={() => setRegimeOverride(item)} style={{ ...styles.quickBtn, borderColor: regimeOverride === item ? '#5df3a6' : '#223' }}>{item}</button>
              ))}
            </div>
          </div>

          <div>
            <div style={styles.label}>Intensity x{intensity.toFixed(2)}</div>
            <input style={styles.input} type="range" min={0.25} max={2.5} step={0.05} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} />
          </div>

          <div style={styles.syncStatCard}>
            <div style={styles.label}>Live Symbol</div>
            <strong>{controlState?.symbol ?? '--'}</strong>
            <span style={styles.mutedText}>Market: {controlState?.market?.id ?? '--'} • {controlState?.market?.regimeOverride ?? 'AUTO'} • x{(controlState?.market?.intensity ?? 1).toFixed(2)}</span>
          </div>

          <div style={styles.syncStatCard}>
            <div style={styles.label}>Execution</div>
            <strong style={{ color: controlState?.hasRunningDeal ? '#5df3a6' : '#9cb7ff' }}>
              {controlState?.hasRunningDeal ? 'RUNNING DEAL' : 'SYNTHETIC MARKET'}
            </strong>
            <span style={styles.mutedText}>Deal ID: {controlState?.activeDealId ?? 'None'}</span>
          </div>
        </div>

        <div style={styles.syncBadges}>
          <span style={{ ...styles.badge, color: metaActionColor(controlState?.ai.meta.action), borderColor: metaActionColor(controlState?.ai.meta.action) }}>
            Meta {controlState?.ai.meta.action ?? 'NO_TRADE'}
          </span>
          <span style={styles.syncChip}>Meta Hit {controlState?.ai.hitRates.meta ?? 0}%</span>
          <span style={styles.syncChip}>Signals {controlState?.ai.signals.length ?? 0}</span>
          <span style={styles.syncChip}>AI Update {formatClock(controlState?.ai.lastSignalAt)}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => void triggerEvent('NEWS_SPIKE')} style={styles.quickBtn}>NEWS_SPIKE</button>
          <button type="button" onClick={() => void triggerEvent('DUMP')} style={styles.quickBtn}>DUMP</button>
          <button type="button" onClick={() => void triggerEvent('SQUEEZE')} style={styles.quickBtn}>SQUEEZE</button>
        </div>
        <div style={{ ...styles.mutedText, marginTop: 6 }}>
          Status: {controlState?.metaStatus.text ?? 'Waiting for state...'}
        </div>
        <div style={{ ...styles.mutedText, marginTop: 4 }}>
          Meta Reason: {controlState?.ai.meta.reason ?? 'No decision yet.'}
        </div>
      </div>

      <div style={styles.gridTwoCol}>
        <div className="glass" style={styles.panel}>
          <h2 style={styles.sectionTitle}>Schedule Deal</h2>
          <form onSubmit={createDeal} style={styles.formGrid}>
            <div>
              <div style={styles.label}>Symbol</div>
              <select style={styles.input} value={form.symbol} onChange={(e) => applySymbolPreset(e.target.value)}>
                {NON_AUTO_GRAPH_MODES.map((symbol) => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
            </div>

            <div>
              <div style={styles.label}>Chain</div>
              <input style={styles.input} value={form.chainName} onChange={(e) => setForm((prev) => ({ ...prev, chainName: e.target.value }))} />
            </div>

            <div>
              <div style={styles.label}>Base Price</div>
              <input style={styles.input} type="number" step="any" min={0} value={form.basePrice} onChange={(e) => setForm((prev) => ({ ...prev, basePrice: Number(e.target.value) }))} />
            </div>

            <div>
              <div style={styles.label}>Start Time</div>
              <input
                style={styles.input}
                type="datetime-local"
                value={form.startTimeLocal}
                onChange={(e) => setForm((prev) => ({ ...prev, startTimeLocal: e.target.value }))}
              />
              <div style={styles.quickRow}>
                {[2, 5, 15].map((mins) => (
                  <button key={mins} type="button" style={styles.quickBtn} onClick={() => setStartOffset(mins)}>+{mins}m</button>
                ))}
              </div>
            </div>

            <div>
              <div style={styles.label}>Duration (sec)</div>
              <input style={styles.input} type="number" min={1} value={form.totalDurationSec} onChange={(e) => setForm((prev) => ({ ...prev, totalDurationSec: Number(e.target.value) }))} />
            </div>

            <div>
              <div style={styles.label}>Drop Delay (sec)</div>
              <input style={styles.input} type="number" min={0} value={form.dropDelaySec} onChange={(e) => setForm((prev) => ({ ...prev, dropDelaySec: Number(e.target.value) }))} />
            </div>

            <div>
              <div style={styles.label}>Drop Magnitude (%)</div>
              <input style={styles.input} type="number" step="any" value={form.dropMagnitudePct} onChange={(e) => setForm((prev) => ({ ...prev, dropMagnitudePct: Number(e.target.value) }))} />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <div style={styles.subHeaderRow}>
                <div style={styles.label}>Rise Jumps</div>
                <button
                  type="button"
                  style={styles.quickBtn}
                  onClick={() => setJumps((prev) => [...prev, { riseDelaySec: 30, riseMagnitudePct: 10, holdSec: 8 }])}
                >
                  Add Jump
                </button>
              </div>

              <div style={{ display: 'grid', gap: 8 }}>
                {jumps.map((jump, index) => (
                  <div key={index} className="glass" style={styles.jumpCard}>
                    <div style={styles.subHeaderRow}>
                      <div style={styles.mutedText}>Jump #{index + 1}</div>
                      <button
                        type="button"
                        style={{ ...styles.quickBtn, opacity: jumps.length === 1 ? 0.5 : 1 }}
                        disabled={jumps.length === 1}
                        onClick={() => setJumps((prev) => prev.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </div>
                    <div style={styles.jumpGrid}>
                      <input
                        style={styles.input}
                        type="number"
                        min={0}
                        value={jump.riseDelaySec}
                        onChange={(e) =>
                          setJumps((prev) => prev.map((item, i) => (i === index ? { ...item, riseDelaySec: Number(e.target.value) } : item)))
                        }
                        placeholder="Rise delay sec"
                      />
                      <input
                        style={styles.input}
                        type="number"
                        step="any"
                        value={jump.riseMagnitudePct}
                        onChange={(e) =>
                          setJumps((prev) => prev.map((item, i) => (i === index ? { ...item, riseMagnitudePct: Number(e.target.value) } : item)))
                        }
                        placeholder="Rise %"
                      />
                      <input
                        style={styles.input}
                        type="number"
                        min={0}
                        value={jump.holdSec}
                        onChange={(e) =>
                          setJumps((prev) => prev.map((item, i) => (i === index ? { ...item, holdSec: Number(e.target.value) } : item)))
                        }
                        placeholder="Hold sec"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button type="submit" disabled={savingDeal} style={styles.button}>
              {savingDeal ? 'Creating...' : 'Create Deal'}
            </button>
          </form>
        </div>

        <div style={{ display: 'grid', gap: '1rem' }}>
          <div className="glass" style={styles.panel}>
            <div style={styles.subHeaderRow}>
              <h2 style={styles.sectionTitle}>Deals</h2>
              <div style={styles.inlineControls}>
                <select style={styles.inputSmall} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'ALL' | DealStatus)}>
                  <option value="ALL">All statuses</option>
                  <option value="SCHEDULED">Scheduled</option>
                  <option value="RUNNING">Running</option>
                  <option value="FINISHED">Finished</option>
                </select>
                <input
                  style={styles.inputSmall}
                  placeholder="Search symbol/chain"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              {loadingDeals && <div style={styles.mutedText}>Loading deals...</div>}
              {!loadingDeals && filteredDeals.length === 0 && <div style={styles.mutedText}>No deals found.</div>}

              {!loadingDeals && filteredDeals.map((deal) => (
                <div key={deal.id} className="glass" style={styles.dealCard}>
                  <div style={styles.subHeaderRow}>
                    <strong>{deal.symbol}</strong>
                    <span style={{ ...styles.badge, color: statusColor[deal.status], borderColor: statusColor[deal.status] }}>{deal.status}</span>
                  </div>

                  <div style={styles.mutedText}>
                    {deal.chainName} · Base ${formatMoney(deal.basePrice)} · Start {dayjs(deal.startTimeUtc).format('MMM D, HH:mm:ss')}
                  </div>
                  <div style={styles.mutedText}>
                    Duration {deal.totalDurationSec}s · Drop {deal.dropMagnitudePct}% at {deal.dropDelaySec}s
                  </div>

                  <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {deal.jumps.map((jump, idx) => (
                      <span key={idx} style={styles.jumpBadge}>
                        Rise {jump.riseMagnitudePct}% @ {jump.riseDelaySec}s hold {jump.holdSec}s
                      </span>
                    ))}
                  </div>

                  <div style={styles.actionRow}>
                    <button
                      onClick={() => void activateDeal(deal.id)}
                      disabled={busyDealId === deal.id || deal.status === 'RUNNING'}
                      style={{ ...styles.quickBtn, ...(deal.status === 'RUNNING' ? styles.disabledBtn : {}) }}
                    >
                      {busyDealId === deal.id ? 'Working...' : 'Activate now'}
                    </button>
                    <button onClick={() => void deleteDeal(deal.id)} disabled={busyDealId === deal.id} style={styles.dangerBtn}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass" style={styles.panel}>
            <div style={styles.subHeaderRow}>
              <h2 style={styles.sectionTitle}>Withdrawals & History</h2>
              <div style={styles.inlineControls}>
                <input
                  style={styles.inputSmall}
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={withdrawTaxPercent}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setWithdrawTaxPercent(Number.isFinite(next) ? next : 0);
                  }}
                  placeholder="Tax %"
                />
                <button type="button" onClick={() => void saveWithdrawTax()} style={styles.quickBtn} disabled={savingWithdrawTax}>
                  {savingWithdrawTax ? 'Saving...' : 'Save tax %'}
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => void triggerEvent('NEWS_SPIKE')} style={styles.quickBtn}>NEWS_SPIKE</button>
          <button type="button" onClick={() => void triggerEvent('DUMP')} style={styles.quickBtn}>DUMP</button>
          <button type="button" onClick={() => void triggerEvent('SQUEEZE')} style={styles.quickBtn}>SQUEEZE</button>
        </div>
        <div style={{ ...styles.mutedText, marginTop: 6 }}>
              Current withdrawal tax: {formatPercent(withdrawTaxPercent)}%
            </div>
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              {loadingWithdrawals && <div style={styles.mutedText}>Loading withdrawals...</div>}
              {!loadingWithdrawals && withdrawals.length === 0 && <div style={styles.mutedText}>No withdrawal requests yet.</div>}

              {!loadingWithdrawals && withdrawals.map((request) => (
                <div key={request.id} className="glass" style={styles.dealCard}>
                  <div style={styles.subHeaderRow}>
                    <strong>Gross ${formatMoney(request.amount)} · Net ${formatMoney(request.netAmount)}</strong>
                    <span style={{ ...styles.badge, color: withdrawalStatusColor[request.status], borderColor: withdrawalStatusColor[request.status] }}>
                      {request.status}
                    </span>
                  </div>
                  <div style={styles.mutedText}>Tax {formatPercent(request.taxPercent)}% · Tax amount ${formatMoney(request.taxAmount)}</div>
                  <div style={styles.mutedText}>Requested {dayjs(request.time).format('MMM D, YYYY HH:mm:ss')}</div>
                  <div style={styles.mutedText}>
                    Processed {request.processedAt ? dayjs(request.processedAt).format('MMM D, YYYY HH:mm:ss') : '--'}
                  </div>
                  {request.status === 'PENDING' ? (
                    <div style={styles.actionRow}>
                      <button
                        onClick={() => void handleWithdrawal(request.id, 'APPROVE')}
                        disabled={busyWithdrawalId === request.id}
                        style={{ ...styles.quickBtn, color: '#5df3a6', borderColor: '#5df3a6' }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void handleWithdrawal(request.id, 'REJECT')}
                        disabled={busyWithdrawalId === request.id}
                        style={styles.dangerBtn}
                      >
                        Reject
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  pageCenter: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  loginCard: {
    width: 420,
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  page: {
    maxWidth: 1280,
    margin: '0 auto',
    padding: '1.5rem',
    display: 'grid',
    gap: '1rem',
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
  },
  headerActions: { display: 'flex', gap: 10, alignItems: 'center' },
  toggleLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)' },
  summaryGrid: {
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
  },
  summaryCard: {
    padding: '0.9rem 1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    alignItems: 'flex-start',
  },
  syncGrid: {
    marginTop: 10,
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
  },
  syncStatCard: {
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'rgba(15,23,43,0.55)',
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  syncBadges: {
    marginTop: 10,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  syncChip: {
    border: '1px solid var(--border)',
    borderRadius: 999,
    padding: '3px 9px',
    fontSize: 12,
    color: '#c7d6f6',
    background: '#13203a',
  },
  userInfoGrid: {
    marginTop: 10,
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
  },
  userInfoFooter: {
    marginTop: 10,
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '0.75rem',
    background: 'rgba(15,23,43,0.35)',
  },
  notice: {
    borderRadius: 10,
    padding: '0.7rem 0.9rem',
    border: '1px solid',
    fontSize: 14,
  },
  errorNotice: { borderColor: '#ff5c8d', color: '#ff9fbb', background: 'rgba(255,92,141,0.08)' },
  infoNotice: { borderColor: '#5df3a6', color: '#86f8c0', background: 'rgba(93,243,166,0.08)' },
  gridTwoCol: {
    display: 'grid',
    gap: '1rem',
    gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))',
  },
  panel: {
    padding: '1rem',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '1.05rem',
  },
  formGrid: {
    marginTop: 10,
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))',
  },
  label: {
    marginBottom: 6,
    fontSize: 12,
    color: 'var(--muted)',
    fontWeight: 600,
    letterSpacing: 0.25,
  },
  input: {
    width: '100%',
    padding: '0.72rem 0.85rem',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: '#0f172b',
    color: 'var(--text)',
  },
  inputSmall: {
    minWidth: 140,
    padding: '0.55rem 0.75rem',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: '#0f172b',
    color: 'var(--text)',
  },
  button: {
    background: 'linear-gradient(135deg,#ff5c8d,#5df3a6)',
    color: '#05070f',
    border: 'none',
    borderRadius: 10,
    padding: '0.7rem 1rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  quickRow: {
    marginTop: 8,
    display: 'flex',
    gap: 6,
  },
  quickBtn: {
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '6px 10px',
    background: 'transparent',
    color: 'var(--text)',
    cursor: 'pointer',
  },
  dangerBtn: {
    border: '1px solid #ff5c8d',
    borderRadius: 8,
    padding: '6px 10px',
    background: 'rgba(255,92,141,0.12)',
    color: '#ff89aa',
    cursor: 'pointer',
  },
  jumpCard: {
    padding: '0.7rem',
    border: '1px dashed var(--border)',
  },
  jumpGrid: {
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))',
    marginTop: 6,
  },
  subHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  inlineControls: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  dealCard: {
    padding: '0.75rem',
    border: '1px solid var(--border)',
    display: 'grid',
    gap: 6,
  },
  badge: {
    border: '1px solid',
    borderRadius: 999,
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  jumpBadge: {
    fontSize: 12,
    padding: '4px 8px',
    background: '#13203a',
    borderRadius: 8,
    color: '#c7d6f6',
  },
  actionRow: {
    marginTop: 6,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  disabledBtn: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  monoText: {
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
    fontSize: 12,
    color: '#c7d6f6',
    wordBreak: 'break-all',
  },
  mutedText: { color: 'var(--muted)', fontSize: 13 },
  error: { color: '#ff5c8d', marginTop: 8, fontSize: 13 },
};
