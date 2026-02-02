import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession } from '@/lib/auth';
import { getWallet } from '@/lib/wallet';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const wallet = await getWallet();
  const openPosition = await prisma.position.findFirst({ where: { isOpen: true } });
  const trades = await prisma.trade.findMany({ orderBy: { time: 'desc' }, take: 20 });
  return NextResponse.json({ wallet, openPosition, trades });
}
