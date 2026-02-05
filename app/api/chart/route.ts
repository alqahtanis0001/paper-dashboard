import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { dealEngine } from '@/lib/engine/dealEngine';

export async function GET(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const selectedSymbol = req.nextUrl.searchParams.get('selectedSymbol');
  const timeframe = req.nextUrl.searchParams.get('timeframe');
  if (selectedSymbol || timeframe) {
    dealEngine.setChartPreferences(selectedSymbol, timeframe);
  }

  return NextResponse.json({
    candles: dealEngine.getRecentCandles(250),
    symbol: dealEngine.getSelectedSymbol(),
    timeframe: dealEngine.getSelectedTimeframe(),
  });
}
