import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logServerAction } from '@/lib/serverLogger';

export async function GET(req: NextRequest) {
  logServerAction('activity.get', 'start');
  try {
    await requireUserSession(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const events = await prisma.auditLog.findMany({
    where: {
      eventType: {
        notIn: ['withdrawal_requested', 'withdrawal_approved', 'withdrawal_rejected', 'withdraw_tax_updated'],
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  logServerAction('activity.get', 'success', { count: events.length });
  return NextResponse.json({ events });
}
