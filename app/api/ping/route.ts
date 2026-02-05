import { NextResponse } from 'next/server';
import { logServerAction } from '@/lib/serverLogger';

export async function GET() {
  logServerAction('ping.get', 'start');
  const payload = { ok: true, ts: Date.now() };
  logServerAction('ping.get', 'success', payload);
  return NextResponse.json(payload, { status: 200 });
}

