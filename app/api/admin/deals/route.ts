import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }
  const deals = await prisma.deal.findMany({
    orderBy: { startTimeUtc: 'desc' },
    include: { jumps: { orderBy: { orderIndex: 'asc' } } },
  });
  return NextResponse.json({ deals });
}
