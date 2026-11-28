import { describe, expect, it, vi } from 'vitest';
import type { ConsoleStore } from '../../src/application/console/ports';
import {
  getAuthState,
  hasConsolePassword,
  removeConsolePassword,
  setConsolePassword,
  verifyConsolePassword
} from '../../src/infrastructure/security/console-auth';
import { toBase64Url } from '../../src/infrastructure/security/session-crypto';

function fakeEnv() {
  const values = new Map<string, string>();
  const store = {
    async get(key: string) { return values.get(key) ?? null; },
    async put(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); }
  } as ConsoleStore;
  const env = { CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: toBase64Url(new Uint8Array(32).fill(9)) };
  return { env, values };
}

describe('console access password', () => {
  it('starts unconfigured and reports needs_setup', async () => {
    const { env } = fakeEnv();
    expect(await hasConsolePassword(env)).toBe(false);
    expect((await getAuthState(env, {})).state).toBe('needs_setup');
  });

  it('sets a password and verifies correct / rejects incorrect values', async () => {
    const { env, values } = fakeEnv();
    const record = await setConsolePassword(env, 'correct-horse');
    expect(await hasConsolePassword(env)).toBe(true);
    expect(values.get('console:auth')).toBeTruthy();
    expect(values.get('console:auth')).not.toContain('correct-horse');
    expect(await verifyConsolePassword(env, 'correct-horse')).toBe(true);
    expect(await verifyConsolePassword(env, 'wrong-horse')).toBe(false);
    expect(record.iterations).toBeGreaterThan(100_000);
  });

  it('only unlocks sessions validated after the last password change', async () => {
    vi.useFakeTimers();
    try {
      const { env } = fakeEnv();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = await setConsolePassword(env, 'password-one');
      expect((await getAuthState(env, { authValidAt: first.changedAt + 1 })).state).toBe('unlocked');
      expect((await getAuthState(env, { authValidAt: first.changedAt - 1 })).state).toBe('locked');
      expect((await getAuthState(env, {})).state).toBe('locked');
      // Rotating the password invalidates a session unlocked against the old one.
      vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
      const second = await setConsolePassword(env, 'password-two');
      expect((await getAuthState(env, { authValidAt: first.changedAt + 1 })).state).toBe('locked');
      expect((await getAuthState(env, { authValidAt: second.changedAt + 1 })).state).toBe('unlocked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects passwords shorter than 6 characters', async () => {
    const { env } = fakeEnv();
    await expect(setConsolePassword(env, '12345')).rejects.toThrow();
  });

  it('removing the password returns to needs_setup', async () => {
    const { env } = fakeEnv();
    await setConsolePassword(env, 'some-password');
    await removeConsolePassword(env);
    expect(await hasConsolePassword(env)).toBe(false);
    expect((await getAuthState(env, {})).state).toBe('needs_setup');
  });
});
