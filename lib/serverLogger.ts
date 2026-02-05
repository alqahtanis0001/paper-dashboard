export function logServerAction(action: string, stage: 'start' | 'success' | 'warn' | 'error', details?: unknown) {
  const prefix = `[server][${action}] ${stage.toUpperCase()}`;
  if (stage === 'error') {
    console.error(prefix, details ?? '');
    return;
  }
  if (stage === 'warn') {
    console.warn(prefix, details ?? '');
    return;
  }
  console.info(prefix, details ?? '');
}
