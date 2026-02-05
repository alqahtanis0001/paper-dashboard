import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireUserSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logServerAction } from '@/lib/serverLogger';

const bodySchema = z.object({
  selectedSymbol: z.string().optional(),
  timeframe: z.string().optional(),
  zoomLogical: z.number().optional(),
  collapsed: z.record(z.string(), z.boolean()).optional(),
});

export async function GET(req: NextRequest) {
  logServerAction('chartState.get', 'start');
  try {
    const session = await requireUserSession(req);
    const pref = await prisma.chartPreference.findUnique({ where: { sessionId: session.id } });
    logServerAction('chartState.get', 'success', { found: !!pref });
    return NextResponse.json({ preference: pref });
  } catch (error) {
    logServerAction('chartState.get', 'error', error);
    return authErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  logServerAction('chartState.post', 'start');
  try {
    const session = await requireUserSession(req);
    const data = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(data);
    if (!parsed.success) {
      logServerAction('chartState.post', 'warn', { reason: 'invalid_payload' });
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const pref = await prisma.chartPreference.upsert({
      where: { sessionId: session.id },
      create: {
        sessionId: session.id,
        selectedSymbol: parsed.data.selectedSymbol,
        timeframe: parsed.data.timeframe,
        zoomLogical: parsed.data.zoomLogical,
        collapsedJson: parsed.data.collapsed,
      },
      update: {
        selectedSymbol: parsed.data.selectedSymbol,
        timeframe: parsed.data.timeframe,
        zoomLogical: parsed.data.zoomLogical,
        collapsedJson: parsed.data.collapsed,
      },
    });

    logServerAction('chartState.post', 'success', { sessionId: session.id });
    return NextResponse.json({ preference: pref });
  } catch (error) {
    logServerAction('chartState.post', 'error', error);
    return authErrorResponse(error);
  }
}
