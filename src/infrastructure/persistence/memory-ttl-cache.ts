import type { SessionCache } from '../ugreen/session-service';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * In-memory TTL cache replacing Cloudflare KV for the self-hosted Node gateway.
 *
 * Proxy sessions live for one hour and are transparently re-created after a
 * restart, so persistence is unnecessary. A single process is assumed.
 */
export class MemoryTtlCache implements SessionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(sweepIntervalMs = 60_000) {
    const timer = setInterval(() => this.sweep(), sweepIntervalMs);
    timer.unref?.();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttlSeconds = options?.expirationTtl ?? 3600;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
