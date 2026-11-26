import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleGatewayRequest, type GatewayDependencies } from '../../../application/gateway/handle-request';
import type { TrafficStats } from '../../../infrastructure/monitoring/traffic-stats';
import type { NodeGatewayConfig } from './node-config';

const REQUEST_TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 30_000;

function externalRequestUrl(incoming: IncomingMessage): string {
  const headers = incoming.headers;
  let host = headers.host ?? '';
  let proto = 'https';

  const forwardedHost = headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && forwardedHost) {
    host = forwardedHost.split(',')[0]?.trim() ?? host;
  }
  const forwardedProto = headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto) {
    proto = forwardedProto.split(',')[0]?.trim() ?? proto;
  }
  if (!host) host = 'localhost';
  return `${proto}://${host}${incoming.url ?? '/'}`;
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  const cookieParts: string[] = [];
  const raw = incoming.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name === undefined) break;
    if (name.toLowerCase() === 'cookie') {
      cookieParts.push(value ?? '');
      continue;
    }
    headers.append(name, value ?? '');
  }
  if (cookieParts.length > 0) headers.set('cookie', cookieParts.join('; '));
  return headers;
}

function requestBody(incoming: IncomingMessage, onBytes: (length: number) => void): ReadableStream | undefined {
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return undefined;
  if (!incoming.headers['content-length'] && !incoming.headers['transfer-encoding']) return undefined;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
      onBytes(chunk.length);
      callback(null, chunk);
    }
  });
  incoming.pipe(tap);
  return Readable.toWeb(tap) as ReadableStream;
}

async function sendResponse(
  response: Response,
  outgoing: ServerResponse,
  headOnly: boolean,
  onBytes: (length: number) => void
): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies);
  if (!response.body || headOnly) {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
      onBytes(chunk.length);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, outgoing);
}

function createListener(
  service: string,
  serviceMapJson: string,
  config: NodeGatewayConfig,
  dependencies: GatewayDependencies,
  stats: TrafficStats
): Server {
  return createServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: BODY_TIMEOUT_MS }, (incoming, outgoing) => {
    void (async () => {
      const clientGone = new AbortController();
      const abortUpstream = () => clientGone.abort();
      incoming.once('aborted', abortUpstream);
      outgoing.once('close', abortUpstream);
      stats.recordRequestHeaders(service);
      try {
        const request = new Request(externalRequestUrl(incoming), {
          method: incoming.method,
          headers: requestHeaders(incoming),
          body: requestBody(incoming, (length) => stats.record(service, length, 0)),
          duplex: 'half',
          signal: clientGone.signal
        } as RequestInit);
        const response = await handleGatewayRequest(request, {
          serviceMap: serviceMapJson,
          setupMode: config.setupMode
        }, dependencies);
        stats.recordResponseHeaders(service);
        await sendResponse(response, outgoing, incoming.method === 'HEAD', (length) => {
          stats.record(service, 0, length);
        });
      } catch (error) {
        if (outgoing.destroyed) return;
        dependencies.logger.error({
          event: 'gateway_request_error',
          service,
          url: incoming.url,
          error: error instanceof Error ? error.message : String(error)
        });
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        outgoing.statusCode = 502;
        outgoing.setHeader('Connection', 'close');
        outgoing.end('Gateway request failed');
      } finally {
        incoming.removeListener('aborted', abortUpstream);
        outgoing.removeListener('close', abortUpstream);
      }
    })();
  });
}

export interface GatewayListener {
  /** Public port this listener accepts traffic on. */
  port: number;
  /** Service identity for logging and traffic accounting. */
  service: string;
  server: Server;
}

/**
 * Port mode (used by the admin panel): every entry with a `listen` port gets
 * its own listener forwarding ALL traffic on that port to its NAS port —
 * no Host-header routing, so server IP + port or any domain pointed at the
 * server both work.
 *
 * Host mode (headless env bootstrap without `listen` fields): a single
 * listener routes by Host header, like the original Cloudflare Worker.
 */
export function createGatewayListeners(
  config: NodeGatewayConfig,
  dependencies: GatewayDependencies,
  stats: TrafficStats
): GatewayListener[] {
  const entries = Object.entries(config.serviceMap);
  const portMode = entries.some(([, entry]) => entry.listen !== undefined);

  if (portMode) {
    return entries.map(([name, entry]) => {
      const listenPort = entry.listen;
      if (listenPort === undefined || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
        throw new Error(`service '${name}' has an invalid listen port`);
      }
      const serviceMapJson = JSON.stringify({
        '*': { port: entry.port, accessMode: entry.accessMode }
      });
      return {
        port: listenPort,
        service: name,
        server: createListener(name, serviceMapJson, config, dependencies, stats)
      };
    });
  }

  const serviceMapJson = JSON.stringify(
    Object.fromEntries(entries.map(([hostname, entry]) => [
      hostname,
      { port: entry.port, accessMode: entry.accessMode }
    ]))
  );
  return [{
    port: 8080,
    service: '(host routing)',
    server: createListener('(host routing)', serviceMapJson, config, dependencies, stats)
  }];
}
