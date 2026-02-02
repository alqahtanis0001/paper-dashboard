import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const bodySchema = z.object({
  id: z.string().uuid(),
  startNow: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const startTimeUtc = parsed.data.startNow ? new Date() : undefined;

  const deal = await prisma.deal.update({
    where: { id: parsed.data.id },
    data: {
      startTimeUtc: startTimeUtc ?? undefined,
      status: 'SCHEDULED',
    },
    include: { jumps: { orderBy: { orderIndex: 'asc' } } },
  });

  return NextResponse.json({ deal });
}
