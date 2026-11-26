import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TrafficTotals {
  rx: number;
  tx: number;
}

export interface TrafficSnapshot {
  /** YYYY-MM period the monthly counters belong to (UTC). */
  period: string;
  monthlyTotals: TrafficTotals;
  monthlyServices: Array<{ service: string; rx: number; tx: number }>;
  allTime: TrafficTotals;
  thresholdBytes: number | null;
  thresholdExceeded: boolean;
}

interface StoredTraffic {
  period: string;
  services: Record<string, TrafficTotals>;
  allTime: TrafficTotals;
  thresholdWarned: boolean;
}

export interface TrafficStatsLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
}

export interface TrafficStatsOptions {
  /** Monthly traffic threshold in bytes; null disables the alert. */
  thresholdBytes: number | null;
  logger?: TrafficStatsLogger;
}

const HEADER_RX_BYTES = 512;
const HEADER_TX_BYTES = 256;

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sumTotals(services: Record<string, TrafficTotals>): TrafficTotals {
  let rx = 0;
  let tx = 0;
  for (const totals of Object.values(services)) {
    rx += totals.rx;
    tx += totals.tx;
  }
  return { rx, tx };
}

/**
 * Per-service traffic accounting for the self-hosted gateway.
 *
 * Byte counts are approximations: request headers are estimated at 512 bytes
 * and response headers at 256 bytes; body bytes are counted exactly as they
 * stream through. Counters are kept in memory and periodically flushed to a
 * JSON file, surviving restarts. Monthly counters reset per UTC month while
 * the all-time totals keep accumulating.
 */
export class TrafficStats {
  private data: StoredTraffic = {
    period: currentPeriod(),
    services: {},
    allTime: { rx: 0, tx: 0 },
    thresholdWarned: false
  };

  constructor(
    private readonly filePath: string | null,
    private options: TrafficStatsOptions
  ) {
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredTraffic>;
        this.data = {
          period: typeof parsed.period === 'string' ? parsed.period : currentPeriod(),
          services: parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)
            ? parsed.services as Record<string, TrafficTotals>
            : {},
          allTime: parsed.allTime && typeof parsed.allTime === 'object' && !Array.isArray(parsed.allTime)
            ? parsed.allTime as TrafficTotals
            : { rx: 0, tx: 0 },
          thresholdWarned: parsed.thresholdWarned === true
        };
      } catch {
        this.options.logger?.warn({ event: 'traffic_state_unreadable', filePath });
      }
    }
    this.rolloverIfNeeded();
  }

  setThreshold(thresholdBytes: number | null): void {
    this.options = { ...this.options, thresholdBytes };
  }

  /** Record an approximate header cost plus exact body bytes. */
  record(service: string, rxBytes: number, txBytes: number): void {
    this.rolloverIfNeeded();
    const existing = this.data.services[service] ?? { rx: 0, tx: 0 };
    this.data.services[service] = {
      rx: existing.rx + rxBytes,
      tx: existing.tx + txBytes
    };
    this.data.allTime.rx += rxBytes;
    this.data.allTime.tx += txBytes;
    this.checkThreshold();
  }

  recordRequestHeaders(service: string): void {
    this.record(service, HEADER_RX_BYTES, 0);
  }

  recordResponseHeaders(service: string): void {
    this.record(service, 0, HEADER_TX_BYTES);
  }

  snapshot(): TrafficSnapshot {
    const monthlyTotals = sumTotals(this.data.services);
    const thresholdBytes = this.options.thresholdBytes;
    return {
      period: this.data.period,
      monthlyTotals,
      monthlyServices: Object.entries(this.data.services)
        .map(([service, totals]) => ({ service, ...totals }))
        .sort((left, right) => (right.rx + right.tx) - (left.rx + left.tx)),
      allTime: { ...this.data.allTime },
      thresholdBytes,
      thresholdExceeded: thresholdBytes !== null && (monthlyTotals.rx + monthlyTotals.tx) >= thresholdBytes
    };
  }

  flush(): void {
    if (!this.filePath) return;
    this.rolloverIfNeeded();
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.filePath);
    } catch (error) {
      this.options.logger?.warn({
        event: 'traffic_flush_failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  startAutoFlush(intervalMs = 15_000): void {
    const timer = setInterval(() => this.flush(), intervalMs);
    timer.unref?.();
  }

  private checkThreshold(): void {
    const thresholdBytes = this.options.thresholdBytes;
    if (thresholdBytes === null || this.data.thresholdWarned) return;
    const monthly = sumTotals(this.data.services);
    if (monthly.rx + monthly.tx >= thresholdBytes) {
      this.data.thresholdWarned = true;
      this.options.logger?.warn({
        event: 'traffic_threshold_exceeded',
        period: this.data.period,
        monthlyBytes: monthly.rx + monthly.tx,
        thresholdBytes
      });
    }
  }

  private rolloverIfNeeded(): void {
    const period = currentPeriod();
    if (this.data.period === period) return;
    this.data = {
      period,
      services: {},
      allTime: this.data.allTime,
      thresholdWarned: false
    };
    this.options.logger?.info({ event: 'traffic_period_reset', period });
  }
}
