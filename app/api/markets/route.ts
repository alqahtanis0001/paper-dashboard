import { NextResponse } from 'next/server';
import { listMarkets } from '@/lib/markets';

export async function GET() {
  return NextResponse.json({ markets: listMarkets() });
}
