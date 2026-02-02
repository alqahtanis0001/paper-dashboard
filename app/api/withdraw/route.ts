import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getWallet } from '@/lib/wallet';
import { z } from 'zod';

const bodySchema = z.object({ amount: z.number().positive() });

export async function POST(req: NextRequest) {
  try {
    await requireUserSession(req);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });

  const wallet = await getWallet();
  if (wallet.cashBalance < parsed.data.amount) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
  }

  const request = await prisma.withdrawalRequest.create({
    data: { amount: parsed.data.amount },
  });

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { cashBalance: wallet.cashBalance - parsed.data.amount },
  });

  return NextResponse.json({ request });
}
