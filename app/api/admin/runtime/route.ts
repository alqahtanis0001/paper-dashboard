import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireAdminSession } from '@/lib/auth';
import { getRuntimeSummary } from '@/lib/runtimeEnv';
import { logServerAction } from '@/lib/serverLogger';

export async function GET(req: NextRequest) {
  logServerAction('admin.runtime.get', 'start');
  try {
    await requireAdminSession(req);
  } catch (error) {
    logServerAction('admin.runtime.get', 'error', error);
    return authErrorResponse(error);
  }

  const runtime = getRuntimeSummary();
  logServerAction('admin.runtime.get', 'success', {
    runtimeTarget: runtime.runtimeTarget,
    storageMode: runtime.storageMode,
    hasDatabase: runtime.hasDatabase,
    databaseHost: runtime.databaseHost,
  });
  return NextResponse.json({ runtime });
}
