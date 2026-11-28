// Console access password: a single global passphrase stored as a salted
// PBKDF2 hash in the console store (not in any browser session). Sessions
// only carry a timestamp proving they were unlocked after the hash was last
// changed, so rotating the password invalidates every existing session.
import type { ConsoleStore } from '../../application/console/ports';
import { constantTimeEqual, sealJson, openJson } from './session-crypto';

const AUTH_KEY = 'console:auth';
const encoder = new TextEncoder();
const ITERATIONS = 210_000;

export interface ConsoleAuthRecord {
  format: 'uglink-console-auth';
  version: 1;
  salt: string;
  hash: string;
  iterations: number;
  /** Epoch ms of the last password change; sessions unlocked before it are stale. */
  changedAt: number;
}

export interface ConsoleAuthEnvironment {
  CONSOLE_SESSIONS: ConsoleStore;
  SESSION_ENCRYPTION_KEY: string;
}

async function deriveHash(passphrase: string, salt: Uint8Array<ArrayBuffer>, encodedKey: string): Promise<string> {
  // Bind the hash to the install's encryption key so a copied store file is
  // not usable against a different deployment without the matching key.
  const keyMaterial = `${passphrase}\u0000${encodedKey}`;
  const material = await crypto.subtle.importKey('raw', encoder.encode(keyMaterial), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: ITERATIONS
  }, material, 256);
  const bytes = new Uint8Array(bits);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function readAuthRecord(env: ConsoleAuthEnvironment): Promise<ConsoleAuthRecord | undefined> {
  const sealed = await env.CONSOLE_SESSIONS.get(AUTH_KEY);
  if (!sealed) return undefined;
  try {
    const record = await openJson<ConsoleAuthRecord>(sealed, env.SESSION_ENCRYPTION_KEY, AUTH_KEY);
    if (record?.format !== 'uglink-console-auth' || record.version !== 1) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export async function hasConsolePassword(env: ConsoleAuthEnvironment): Promise<boolean> {
  return Boolean(await readAuthRecord(env));
}

export type AuthState = 'needs_setup' | 'locked' | 'unlocked';

export async function getAuthState(
  env: ConsoleAuthEnvironment,
  session: { authValidAt?: number }
): Promise<{ state: AuthState; record?: ConsoleAuthRecord }> {
  const record = await readAuthRecord(env);
  if (!record) return { state: 'needs_setup' };
  if (session.authValidAt && session.authValidAt >= record.changedAt) {
    return { state: 'unlocked', record };
  }
  return { state: 'locked', record };
}

export async function setConsolePassword(env: ConsoleAuthEnvironment, passphrase: string): Promise<ConsoleAuthRecord> {
  if (typeof passphrase !== 'string' || passphrase.length < 6) {
    throw new Error('密码至少需要 6 个字符。');
  }
  const salt = crypto.getRandomValues(new Uint8Array(24));
  const hash = await deriveHash(passphrase, salt, env.SESSION_ENCRYPTION_KEY);
  const record: ConsoleAuthRecord = {
    format: 'uglink-console-auth',
    version: 1,
    salt: btoa(String.fromCharCode(...salt)),
    hash,
    iterations: ITERATIONS,
    changedAt: Date.now()
  };
  const sealed = await sealJson(record, env.SESSION_ENCRYPTION_KEY, AUTH_KEY);
  await env.CONSOLE_SESSIONS.put(AUTH_KEY, sealed);
  return record;
}

export async function verifyConsolePassword(env: ConsoleAuthEnvironment, passphrase: string): Promise<boolean> {
  const record = await readAuthRecord(env);
  if (!record || record.iterations !== ITERATIONS) return false;
  let candidate: string;
  try {
    candidate = await deriveHash(passphrase, decodeBase64(record.salt), env.SESSION_ENCRYPTION_KEY);
  } catch {
    return false;
  }
  return constantTimeEqual(candidate, record.hash);
}

export async function removeConsolePassword(env: ConsoleAuthEnvironment): Promise<void> {
  await env.CONSOLE_SESSIONS.delete(AUTH_KEY);
}
