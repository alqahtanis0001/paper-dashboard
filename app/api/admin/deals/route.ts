import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logServerAction } from '@/lib/serverLogger';

export async function GET(req: NextRequest) {
  logServerAction('admin.deals.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.deals.get', 'error', error);
    return authErrorResponse(error);
  }
  const deals = await prisma.deal.findMany({
    orderBy: { startTimeUtc: 'desc' },
    include: { jumps: { orderBy: { orderIndex: 'asc' } } },
  });
  logServerAction('admin.deals.get', 'success', { count: deals.length });
  return NextResponse.json({ deals });
}
