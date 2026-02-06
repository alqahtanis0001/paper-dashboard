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
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
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

const fromLocalInput = (localDateTime: string) => dayjs(localDateTime).toISOString();
const nextStartLocal = (mins: number) => dayjs().add(mins, 'minute').format('YYYY-MM-DDTHH:mm');
const formatMoney = (amount: number) =>
  amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const KEEP_ALIVE_PING_INTERVAL_MS = 6 * 60 * 1000;
const formatClock = (value: number | null | undefined) => (typeof value === 'number' ? dayjs(value).format('HH:mm:ss') : '--');
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

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'ALL' | DealStatus>('ALL');
  const [search, setSearch] = useState('');
  const [controlState, setControlState] = useState<ControlState | null>(null);
  const [controlSymbol, setControlSymbol] = useState<GraphMode>('AUTO');
  const [controlTimeframe, setControlTimeframe] = useState<GraphTimeframe>('1s');
  const [syncingControl, setSyncingControl] = useState(false);

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
      setError('Failed to load pending withdrawals.');
      return;
    }
    const body = await res.json();
    setWithdrawals(body.requests ?? []);
  }, []);

  const applyControlState = useCallback((next: ControlState) => {
    setControlState(next);
    setControlSymbol(normalizeGraphMode(next.selectedGraphMode));
    setControlTimeframe(normalizeGraphTimeframe(next.timeframe));
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

  const refreshAll = useCallback(async () => {
    setError('');
    await Promise.all([loadDeals(), loadWithdrawals(), loadControlState()]);
  }, [loadDeals, loadWithdrawals, loadControlState]);

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
    setInfo('Control state synchronized.');
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

    setInfo(`Withdrawal ${action.toLowerCase()}d.`);
    await refreshAll();
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
          <div style={styles.mutedText}>Manage scenarios, monitor execution, and process pending withdrawals.</div>
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

          <div style={styles.syncStatCard}>
            <div style={styles.label}>Live Symbol</div>
            <strong>{controlState?.symbol ?? '--'}</strong>
            <span style={styles.mutedText}>Selected Mode: {controlState?.selectedGraphMode ?? '--'}</span>
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
            <h2 style={styles.sectionTitle}>Pending Withdrawals</h2>
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              {loadingWithdrawals && <div style={styles.mutedText}>Loading withdrawals...</div>}
              {!loadingWithdrawals && withdrawals.length === 0 && <div style={styles.mutedText}>No pending requests.</div>}

              {!loadingWithdrawals && withdrawals.map((request) => (
                <div key={request.id} className="glass" style={styles.dealCard}>
                  <div style={styles.subHeaderRow}>
                    <strong>${formatMoney(request.amount)}</strong>
                    <span style={{ ...styles.badge, color: '#ffd166', borderColor: '#ffd166' }}>{request.status}</span>
                  </div>
                  <div style={styles.mutedText}>Requested {dayjs(request.time).format('MMM D, YYYY HH:mm:ss')}</div>
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
  mutedText: { color: 'var(--muted)', fontSize: 13 },
  error: { color: '#ff5c8d', marginTop: 8, fontSize: 13 },
};
