import type { ProxySession, ProxyTicket } from '../../domain/proxy/model';

export interface ProxySessionService {
  get(port: string): Promise<ProxySession>;
  refresh(port: string): Promise<ProxySession>;
  invalidate(port: string): Promise<void>;
}

export interface ProxyTicketService {
  issue(port: string): Promise<ProxyTicket>;
}

/**
 * Per-visitor cache of the last issued ticket redirect URL so repeat visits
 * from the same device can jump straight to the relay without a fresh
 * UGREENlink login handshake (and without hitting the issuance throttle).
 */
export interface ProxyTicketReuseService {
  get(visitorId: string, port: string): Promise<string | null>;
  put(visitorId: string, port: string, url: string): Promise<void>;
  clear(visitorId: string, port: string): Promise<void>;
}

export interface ProxyTransport {
  send(request: Request, session: ProxySession): Promise<Response>;
  isSessionExpired(response: Response, session: ProxySession): boolean;
}

export interface GatewayLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}
