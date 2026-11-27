#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { MemoryTtlCache } from '../../../infrastructure/persistence/memory-ttl-cache';
import { TrafficStats } from '../../../infrastructure/monitoring/traffic-stats';
import {
  createUgreenSessionService,
  createUgreenTicketService,
  type UgreenSessionRuntime
} from '../../../infrastructure/ugreen/session-service';
import { ugreenProxyTransport } from '../../../infrastructure/ugreen/proxy-transport';
import type { GatewayDependencies } from '../../../application/gateway/handle-request';
import { createGatewayListeners, type GatewayListener } from './node-server';
import { createAdminServer, type AdminStatusService } from './admin-panel';
import {
  configFromEnv,
  configFromStored,
  emptyStoredConfig,
  loadStoredConfig,
  saveStoredConfig,
  type NodeGatewayStoredConfig
} from './node-config';

const DEFAULT_ADMIN_PORT = 9090;

function createLogger() {
  return {
    info(event: Record<string, unknown>): void {
      console.log(JSON.stringify(event));
    },
    warn(event: Record<string, unknown>): void {
      console.warn(JSON.stringify(event));
    },
    error(event: Record<string, unknown>): void {
      console.error(JSON.stringify(event));
    }
  };
}

function main(): void {
  const logger = createLogger();
  const configPath = process.env.CONFIG_FILE
    ?? (process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : undefined);
  const trafficPath = process.env.TRAFFIC_FILE ?? null;
  const host = process.env.HOST?.trim() || '0.0.0.0';
  const adminPort = Number(process.env.ADMIN_PORT) > 0 ? Number(process.env.ADMIN_PORT) : DEFAULT_ADMIN_PORT;

  const cache = new MemoryTtlCache();
  const runtime: UgreenSessionRuntime = {
    uglinkId: '',
    username: '',
    password: '',
    sessionNamespace: 'default',
    cache
  };
  const dependencies: GatewayDependencies = {
    sessions: createUgreenSessionService(runtime),
    tickets: createUgreenTicketService(runtime),
    transport: ugreenProxyTransport,
    logger
  };

  const stats = new TrafficStats(trafficPath, {
    thresholdBytes: null,
    logger
  });
  stats.startAutoFlush();

  let listeners: GatewayListener[] = [];
  let listenerServices: NodeGatewayStoredConfig['services'] = [];
  const currentServicesStatus = (): AdminStatusService[] => listenerServices.map((service) => ({
    name: service.name,
    nasPort: Number(service.nasPort),
    serverPort: Number(service.serverPort),
    accessMode: service.accessMode ?? 'proxy',
    listening: listeners.find((listener) => listener.service === service.name)?.server.listening ?? false
  }));
  const stopAll = (): void => {
    for (const listener of listeners) {
      try {
        listener.server.close();
      } catch {
        // Listener may already be closed.
      }
    }
    listeners = [];
  };

  const applyRuntime = (config: { uglinkId: string; username: string; password: string; sessionNamespace: string }): void => {
    const credentialsChanged = runtime.uglinkId !== config.uglinkId
      || runtime.username !== config.username
      || runtime.password !== config.password;
    runtime.uglinkId = config.uglinkId;
    runtime.username = config.username;
    runtime.password = config.password;
    runtime.sessionNamespace = config.sessionNamespace || 'default';
    if (credentialsChanged) void cache.clear();
  };

  const applyStored = (next: NodeGatewayStoredConfig): void => {
    applyRuntime(next);
    stats.setThreshold(next.trafficMonthlyThresholdGb !== null
      ? Math.round(next.trafficMonthlyThresholdGb * 1_073_741_824)
      : null);
    stopAll();
    listenerServices = next.services;
    try {
      listeners = createGatewayListeners(configFromStored(next, host), dependencies, stats);
    } catch (error) {
      listeners = [];
      logger.error({
        event: 'gateway_config_rejected',
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    for (const listener of listeners) {
      listener.server.on('error', (error: NodeJS.ErrnoException) => {
        logger.error({
          event: 'gateway_listen_failed',
          service: listener.service,
          port: listener.port,
          error: error.message
        });
      });
      listener.server.listen(listener.port, host, () => {
        logger.info({
          event: 'gateway_started',
          service: listener.service,
          port: listener.port,
          nasPort: next.services.find((service) => service.name === listener.service)?.nasPort
        });
      });
    }
    logger.info({ event: 'config_applied', services: next.services.length });
  };

  if (!configPath) {
    logger.info({ event: 'panel_disabled', reason: 'CONFIG_FILE is not set; running headless from environment' });
    const config = configFromEnv(process.env, host);
    applyRuntime(config);
    listeners = createGatewayListeners(config, dependencies, stats);
    for (const listener of listeners) {
      listener.server.on('error', (error: NodeJS.ErrnoException) => {
        logger.error({ event: 'gateway_listen_failed', service: listener.service, port: listener.port, error: error.message });
      });
      listener.server.listen(listener.port, host, () => {
        logger.info({ event: 'gateway_started', service: listener.service, port: listener.port });
      });
    }
    return;
  }

  let stored: NodeGatewayStoredConfig;
  try {
    stored = loadStoredConfig(configPath);
  } catch {
    stored = emptyStoredConfig();
    saveStoredConfig(configPath, stored);
    logger.info({ event: 'config_file_created', path: configPath });
  }

  const adminToken = process.env.ADMIN_TOKEN?.trim() || randomBytes(16).toString('hex');
  if (!process.env.ADMIN_TOKEN?.trim()) {
    logger.info({
      event: 'admin_token_generated',
      token: adminToken,
      hint: 'Open the admin panel and enter this token, or set ADMIN_TOKEN to fix it'
    });
  }
  // Remote editing is opt-in: without UNLOCK_TOKEN the panel stays a read-only
  // status screen and configuration changes must come from the NAS console.
  const unlockToken = process.env.UNLOCK_TOKEN?.trim() || null;
  logger.info({ event: 'admin_edit_mode', remoteEditEnabled: unlockToken !== null });

  const adminServer = createAdminServer({
    port: adminPort,
    token: adminToken,
    unlockToken,
    getStored: () => stored,
    applyConfig: (next) => {
      stored = next;
      saveStoredConfig(configPath, next);
      applyStored(next);
      return { ok: true };
    },
    getTraffic: () => stats.snapshot(),
    getServices: currentServicesStatus,
    logger
  });
  adminServer.on('error', (error: NodeJS.ErrnoException) => {
    logger.error({ event: 'admin_listen_failed', port: adminPort, error: error.message });
  });
  adminServer.listen(adminPort, host, () => {
    logger.info({ event: 'admin_panel_started', port: adminPort, path: configPath });
  });

  applyStored(stored);

  const shutdown = (): void => {
    stats.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
