export interface GatewayWorkerEnv {
  UGLINK_ID: string;
  USERNAME: string;
  PASSWORD: string;
  SERVICE_MAP: string;
  SETUP_MODE: string;
  SESSION_NAMESPACE: string;
  UGLINK_CACHE: KVNamespace;
  /** Optional ticket issuance throttle window in seconds (default 300). */
  UGLINK_TICKET_THROTTLE_SECONDS?: string;
}
