/** Structural Bun interfaces avoid a mandatory @types/bun dependency for consumers. */
export interface CommonUpgradeServer {
  /** Socket data is owned privately by the adapter; host data types do not escape. */
  upgrade(request: Request, options: any): boolean;
  requestIP?(request: Request): { address: string; port?: number; family?: string } | null;
}
export interface CommonSocket<TData = unknown> {
  data: TData;
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(data?: string | ArrayBuffer | Uint8Array): number;
  pong?(data?: string | ArrayBuffer | Uint8Array): number;
  getBufferedAmount?(): number;
  readonly bufferedAmount?: number;
  subscribe?(topic: string): void;
  unsubscribe?(topic: string): void;
  isSubscribed?(topic: string): boolean;
  publish?(topic: string, data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
}
export interface CommonHostWebSocketHandlers<TData = unknown> {
  open?(socket: CommonSocket<TData>): void;
  message?(socket: CommonSocket<TData>, message: string | Uint8Array): void;
  close?(socket: CommonSocket<TData>, code: number, reason: string): void;
  drain?(socket: CommonSocket<TData>): void;
  ping?(socket: CommonSocket<TData>, data: Uint8Array): void;
  pong?(socket: CommonSocket<TData>, data: Uint8Array): void;
  maxPayloadLength?: number;
  idleTimeout?: number;
  backpressureLimit?: number;
  closeOnBackpressureLimit?: boolean;
  sendPings?: boolean;
  /** Additional Bun WebSocket options pass through unchanged. */
  [option: string]: unknown;
}
export interface CommonWebSocketHandlers<TData = unknown> extends CommonHostWebSocketHandlers<TData> {
  message(socket: CommonSocket<TData>, message: string | Uint8Array): void;
}
export type CommonFetchHandler<TServer extends CommonUpgradeServer = CommonUpgradeServer> = (
  request: Request, server: TServer,
) => Response | undefined | Promise<Response | undefined>;
export interface CommonAuthorizationContext { kind: 'http' | 'websocket'; }
export interface CreateCommonOptions {
  /** Absolute same-origin namespace, normalized with a trailing slash. Default: /__common/. */
  basePath?: string;
  /** null (the default) keeps rooms in memory. An explicit path enables local persistence. */
  dataFile?: string | null;
  /** Runtime configuration for this instance; no process-global mutation. Defaults to private networking. */
  env?: Record<string, string | undefined> | ((key: string) => string | undefined);
  /** Return true to allow. false denies; a Response supplies the host's own denial/redirect. */
  authorize?: (request: Request, context: CommonAuthorizationContext) => boolean | Response | Promise<boolean | Response>;
  /** Advanced: replace the bundled Common app assets. */
  assetsDir?: string | URL;
}
export interface CommonBun {
  readonly basePath: string;
  matches(request: Request): boolean;
  /** null means unmatched; undefined means a successful WebSocket upgrade. */
  fetch(request: Request, server?: CommonUpgradeServer): Promise<Response | null | undefined>;
  readonly websocket: CommonWebSocketHandlers;
  /** Delegates all unmatched routes to the host, preserving its this receiver and Bun server. */
  wrapFetch<TServer extends CommonUpgradeServer>(existingFetch: CommonFetchHandler<TServer>): CommonFetchHandler<TServer>;
  /** Preserves host options and forwards non-owned sockets; wrappers can be composed. */
  wrapWebSocket<TData = unknown>(existingHandlers: CommonHostWebSocketHandlers<TData>): CommonWebSocketHandlers<TData>;
  wrapWebSocket<THandlers extends object>(existingHandlers: THandlers): THandlers & CommonWebSocketHandlers;
  wrapWebSocket(): CommonWebSocketHandlers;
  /** Closes this instance's sessions/timers; does not stop the host's Bun server. Idempotent. */
  close(): Promise<void>;
}
/** Creates handlers only. The embedding application owns Bun.serve and its listener. */
export function createCommon(options?: CreateCommonOptions): Promise<CommonBun>;
