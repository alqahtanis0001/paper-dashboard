import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { dealEngine } from '@/lib/engine/dealEngine';
import { logServerAction } from '@/lib/serverLogger';

const bodySchema = z.object({
  selectedSymbol: z.string().optional(),
  timeframe: z.string().optional(),
});

export async function GET(req: NextRequest) {
  logServerAction('admin.controlState.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.controlState.get', 'error', error);
    return authErrorResponse(error);
  }

  const controlState = dealEngine.getControlState();
  logServerAction('admin.controlState.get', 'success', {
    symbol: controlState.symbol,
    timeframe: controlState.timeframe,
    hasRunningDeal: controlState.hasRunningDeal,
  });
  return NextResponse.json({ controlState });
}

export async function POST(req: NextRequest) {
  logServerAction('admin.controlState.post', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.controlState.post', 'error', error);
    return authErrorResponse(error);
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) {
    logServerAction('admin.controlState.post', 'warn', { reason: 'invalid_payload' });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const { selectedSymbol, timeframe } = parsed.data;
  if (typeof selectedSymbol === 'string' || typeof timeframe === 'string') {
    dealEngine.setChartPreferences(selectedSymbol, timeframe);
  }

  const controlState = dealEngine.notifyControlState();
  logServerAction('admin.controlState.post', 'success', {
    symbol: controlState.symbol,
    timeframe: controlState.timeframe,
    hasRunningDeal: controlState.hasRunningDeal,
  });
  return NextResponse.json({ controlState });
}
