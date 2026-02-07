import { prisma } from '@/lib/prisma';
import type { RegimeOverride } from '@/lib/markets';

export type EngineConfigState = {
  activeMarketId: string;
  regimeOverride: RegimeOverride;
  intensity: number;
};

export async function getEngineConfig(): Promise<EngineConfigState> {
  const row = await prisma.engineConfig.upsert({
    where: { id: 'global' },
    create: { id: 'global', activeMarketId: 'BTC', regimeOverride: 'AUTO', intensity: 1.0 },
    update: {},
  });

  return {
    activeMarketId: row.activeMarketId || 'BTC',
    regimeOverride: (row.regimeOverride as RegimeOverride) || 'AUTO',
    intensity: Number.isFinite(row.intensity) ? row.intensity : 1.0,
  };
}

export async function setEngineConfig(next: Partial<EngineConfigState>): Promise<EngineConfigState> {
  const current = await getEngineConfig();
  const merged: EngineConfigState = {
    activeMarketId: next.activeMarketId ?? current.activeMarketId,
    regimeOverride: next.regimeOverride ?? current.regimeOverride,
    intensity: typeof next.intensity === 'number' ? next.intensity : current.intensity,
  };

  const intensity = Math.min(2.5, Math.max(0.25, merged.intensity));

  const updated = await prisma.engineConfig.upsert({
    where: { id: 'global' },
    create: { id: 'global', activeMarketId: merged.activeMarketId, regimeOverride: merged.regimeOverride, intensity },
    update: { activeMarketId: merged.activeMarketId, regimeOverride: merged.regimeOverride, intensity },
  });

  return {
    activeMarketId: updated.activeMarketId || 'BTC',
    regimeOverride: (updated.regimeOverride as RegimeOverride) || 'AUTO',
    intensity: updated.intensity,
  };
}
