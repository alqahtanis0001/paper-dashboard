import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const deals = await prisma.deal.findMany({
    orderBy: { startTimeUtc: 'desc' },
    include: { jumps: { orderBy: { orderIndex: 'asc' } } },
  });
  return NextResponse.json({ deals });
}
