import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const events = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return NextResponse.json({ events });
}
