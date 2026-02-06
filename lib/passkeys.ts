import { createHash, timingSafeEqual } from 'crypto';
import { runtimeEnv } from './runtimeEnv';

export type PasskeyRole = 'USER' | 'ADMIN';

type PasskeySpec = {
  primaryEnv: string;
  aliases: string[];
  localFallback: string;
};

type PasskeySource = string | 'local_fallback' | null;

export type ResolvedPasskey = {
  role: PasskeyRole;
  value: string | null;
  source: PasskeySource;
  usedFallback: boolean;
};

export type PasskeyVerificationResult = {
  ok: boolean;
  reason: 'ok' | 'invalid_input' | 'not_configured' | 'mismatch';
  role: PasskeyRole;
  source: PasskeySource;
  usedFallback: boolean;
};

const INVISIBLE_CHARS = /[\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g;
const ASSIGNMENT_PREFIX =
  /^(?:export\s+)?(?:USER_PASSKEY|USER_PASS_KEY|PASSKEY_USER|ADMIN_PASSKEY|ADMIN_PASS_KEY|PASSKEY_ADMIN)\s*=\s*/i;
const WRAP_QUOTES = new Set(["'", '"', '`']);

const PASSKEY_SPECS: Record<PasskeyRole, PasskeySpec> = {
  USER: {
    primaryEnv: 'USER_PASSKEY',
    aliases: ['USER_PASS_KEY', 'PASSKEY_USER'],
    localFallback: 'user-pass-123',
  },
  ADMIN: {
    primaryEnv: 'ADMIN_PASSKEY',
    aliases: ['ADMIN_PASS_KEY', 'PASSKEY_ADMIN'],
    localFallback: 'admin-pass-456',
  },
};

export function normalizePasskey(raw: string | null | undefined) {
  if (typeof raw !== 'string') return '';

  let normalized = raw.normalize('NFKC').replace(INVISIBLE_CHARS, '').trim();
  normalized = normalized.replace(ASSIGNMENT_PREFIX, '').trim();

  for (let i = 0; i < 3; i += 1) {
    if (normalized.length < 2) break;
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (!WRAP_QUOTES.has(first) || first !== last) break;
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

function firstConfiguredValue(keys: string[], env: NodeJS.ProcessEnv) {
  for (const key of keys) {
    const value = normalizePasskey(env[key]);
    if (value.length > 0) return { value, source: key as PasskeySource };
  }
  return null;
}

function passkeyDigest(value: string) {
  return createHash('sha256').update(value).digest();
}

function safePasskeyEquals(left: string, right: string) {
  return timingSafeEqual(passkeyDigest(left), passkeyDigest(right));
}

export function resolveConfiguredPasskey(role: PasskeyRole, env: NodeJS.ProcessEnv = process.env): ResolvedPasskey {
  const spec = PASSKEY_SPECS[role];
  const configured = firstConfiguredValue([spec.primaryEnv, ...spec.aliases], env);
  if (configured) {
    return {
      role,
      value: configured.value,
      source: configured.source,
      usedFallback: false,
    };
  }

  if (runtimeEnv.isLocal) {
    return {
      role,
      value: spec.localFallback,
      source: 'local_fallback',
      usedFallback: true,
    };
  }

  return {
    role,
    value: null,
    source: null,
    usedFallback: false,
  };
}

export function verifyRolePasskey(
  role: PasskeyRole,
  suppliedPasskey: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PasskeyVerificationResult {
  const normalizedInput = normalizePasskey(suppliedPasskey);
  if (normalizedInput.length === 0) {
    return {
      ok: false,
      reason: 'invalid_input',
      role,
      source: null,
      usedFallback: false,
    };
  }

  const configured = resolveConfiguredPasskey(role, env);
  if (!configured.value) {
    return {
      ok: false,
      reason: 'not_configured',
      role,
      source: configured.source,
      usedFallback: configured.usedFallback,
    };
  }

  if (!safePasskeyEquals(normalizedInput, configured.value)) {
    return {
      ok: false,
      reason: 'mismatch',
      role,
      source: configured.source,
      usedFallback: configured.usedFallback,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    role,
    source: configured.source,
    usedFallback: configured.usedFallback,
  };
}
