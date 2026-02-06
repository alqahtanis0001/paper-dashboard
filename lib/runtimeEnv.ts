type RuntimeTarget = 'render' | 'local' | 'other';

type StorageMode =
  | 'render-internal-postgres'
  | 'render-external-postgres'
  | 'local-postgres'
  | 'external-postgres'
  | 'unconfigured';

type DatabaseSource =
  | 'database_url'
  | 'render_internal_database_url'
  | 'internal_database_url'
  | 'local_database_url'
  | 'none';

function hasText(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boolFromEnv(value: string | undefined | null, fallback: boolean) {
  if (!hasText(value)) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function normalizePostgresUrl(raw: string) {
  const value = raw.trim();
  if (value.startsWith('postgres://')) {
    return `postgresql://${value.slice('postgres://'.length)}`;
  }
  return value;
}

function parseUrl(raw: string) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isRenderInternalHost(host: string) {
  return /^dpg-[a-z0-9-]+$/i.test(host);
}

function getRenderInternalHostFromExternal(host: string) {
  const matched = host.match(/^([a-z0-9-]+)\.[a-z0-9-]+-postgres\.render\.com$/i);
  return matched?.[1] ?? null;
}

function isRenderExternalHost(host: string) {
  return getRenderInternalHostFromExternal(host) !== null;
}

function buildRuntimeTarget(env: NodeJS.ProcessEnv): RuntimeTarget {
  const renderHints = ['RENDER_SERVICE_ID', 'RENDER_INSTANCE_ID', 'RENDER_EXTERNAL_URL', 'RENDER_EXTERNAL_HOSTNAME'] as const;
  const isRender = env.RENDER === 'true' || renderHints.some((key) => hasText(env[key]));
  if (isRender) return 'render';
  if ((env.NODE_ENV ?? 'development') !== 'production') return 'local';
  return 'other';
}

function classifyStorageMode(runtimeTarget: RuntimeTarget, host: string | null, hasDb: boolean): StorageMode {
  if (!hasDb || !host) return 'unconfigured';
  if (runtimeTarget === 'render' && isRenderInternalHost(host)) return 'render-internal-postgres';
  if (runtimeTarget === 'render' && isRenderExternalHost(host)) return 'render-external-postgres';
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host === 'host.docker.internal'
  ) {
    return 'local-postgres';
  }
  return 'external-postgres';
}

function resolveDatabase(env: NodeJS.ProcessEnv, runtimeTarget: RuntimeTarget) {
  const notes: string[] = [];
  const useExternalOnRender =
    boolFromEnv(env.RENDER_USE_EXTERNAL_DATABASE, false) ||
    (env.RENDER_DATABASE_SOURCE ?? '').trim().toLowerCase() === 'external';

  const dbUrl = hasText(env.DATABASE_URL) ? env.DATABASE_URL.trim() : null;
  const renderInternalDbUrl = hasText(env.RENDER_INTERNAL_DATABASE_URL) ? env.RENDER_INTERNAL_DATABASE_URL.trim() : null;
  const internalDbUrl = hasText(env.INTERNAL_DATABASE_URL) ? env.INTERNAL_DATABASE_URL.trim() : null;
  const localDbUrl = hasText(env.LOCAL_DATABASE_URL) ? env.LOCAL_DATABASE_URL.trim() : null;

  let selectedRaw: string | null = null;
  let source: DatabaseSource = 'none';
  if (runtimeTarget === 'render') {
    if (!useExternalOnRender && renderInternalDbUrl) {
      selectedRaw = renderInternalDbUrl;
      source = 'render_internal_database_url';
    } else if (!useExternalOnRender && internalDbUrl) {
      selectedRaw = internalDbUrl;
      source = 'internal_database_url';
    } else if (dbUrl) {
      selectedRaw = dbUrl;
      source = 'database_url';
    } else if (localDbUrl) {
      selectedRaw = localDbUrl;
      source = 'local_database_url';
      notes.push('Using LOCAL_DATABASE_URL on Render runtime.');
    }
  } else {
    if (dbUrl) {
      selectedRaw = dbUrl;
      source = 'database_url';
    } else if (localDbUrl) {
      selectedRaw = localDbUrl;
      source = 'local_database_url';
    }
  }

  if (!selectedRaw) {
    return {
      url: null,
      host: null,
      sslMode: null,
      source,
      adapted: false,
      notes,
    };
  }

  let finalUrl = normalizePostgresUrl(selectedRaw);
  let adapted = false;

  const parsedInitial = parseUrl(finalUrl);
  if (!parsedInitial) {
    notes.push('DATABASE_URL is set but invalid.');
    return {
      url: finalUrl,
      host: null,
      sslMode: null,
      source,
      adapted: false,
      notes,
    };
  }

  if (runtimeTarget === 'render' && !useExternalOnRender) {
    const currentHost = parsedInitial.hostname.toLowerCase();
    const internalHost = getRenderInternalHostFromExternal(currentHost);
    if (internalHost) {
      parsedInitial.hostname = internalHost;
      parsedInitial.searchParams.delete('ssl');
      parsedInitial.searchParams.set('sslmode', 'disable');
      finalUrl = parsedInitial.toString();
      adapted = true;
      notes.push('Rewrote Render external DB host to internal host for runtime traffic.');
    }
  }

  const parsedFinal = parseUrl(finalUrl);
  if (!parsedFinal) {
    return {
      url: finalUrl,
      host: null,
      sslMode: null,
      source,
      adapted,
      notes,
    };
  }

  const finalHost = parsedFinal.hostname.toLowerCase();
  if (!parsedFinal.searchParams.has('sslmode')) {
    if (runtimeTarget === 'render' && isRenderInternalHost(finalHost)) {
      parsedFinal.searchParams.set('sslmode', 'disable');
      adapted = true;
    } else if (runtimeTarget === 'render' && isRenderExternalHost(finalHost)) {
      parsedFinal.searchParams.set('sslmode', 'require');
      adapted = true;
    }
  }

  finalUrl = parsedFinal.toString();

  return {
    url: finalUrl,
    host: finalHost,
    sslMode: parsedFinal.searchParams.get('sslmode'),
    source,
    adapted,
    notes,
  };
}

function buildRuntimeEnv(env: NodeJS.ProcessEnv) {
  const runtimeTarget = buildRuntimeTarget(env);
  const database = resolveDatabase(env, runtimeTarget);
  const hasDatabase = hasText(database.url) && hasText(database.host);
  const storageMode = classifyStorageMode(runtimeTarget, database.host, hasDatabase);
  const secureCookiesDefault =
    runtimeTarget === 'render'
      ? true
      : runtimeTarget === 'local'
        ? false
        : (env.NODE_ENV ?? 'development') === 'production';
  const secureCookies = boolFromEnv(env.SESSION_COOKIE_SECURE, secureCookiesDefault);

  return {
    runtimeTarget,
    isRender: runtimeTarget === 'render',
    isLocal: runtimeTarget === 'local',
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: database.url,
    hasDatabase,
    databaseHost: database.host,
    databaseSslMode: database.sslMode,
    databaseSource: database.source,
    databaseUrlAdapted: database.adapted,
    storageMode,
    secureCookies,
    notes: database.notes,
  };
}

export const runtimeEnv = buildRuntimeEnv(process.env);

export type RuntimeEnv = typeof runtimeEnv;

export function getRuntimeSummary() {
  return {
    runtimeTarget: runtimeEnv.runtimeTarget,
    nodeEnv: runtimeEnv.nodeEnv,
    isRender: runtimeEnv.isRender,
    isLocal: runtimeEnv.isLocal,
    storageMode: runtimeEnv.storageMode,
    hasDatabase: runtimeEnv.hasDatabase,
    databaseHost: runtimeEnv.databaseHost,
    databaseSslMode: runtimeEnv.databaseSslMode,
    databaseSource: runtimeEnv.databaseSource,
    databaseUrlAdapted: runtimeEnv.databaseUrlAdapted,
    secureCookies: runtimeEnv.secureCookies,
    notes: runtimeEnv.notes,
  };
}
