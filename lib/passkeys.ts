const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g;

export function normalizePasskey(raw: string) {
  let normalized = raw.normalize('NFKC').replace(ZERO_WIDTH_CHARS, '').trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function getConfiguredPasskey(envValue: string | undefined, fallback: string) {
  const normalized = normalizePasskey(envValue ?? '');
  return normalized.length > 0 ? normalized : fallback;
}
