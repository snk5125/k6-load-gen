import type { LogEvent } from '../payload/types.ts';

export interface SendResult {
  ok: boolean;
  status?: number | string;
  /** null when the transport genuinely cannot observe its wire size. */
  wire_bytes: number | null;
  error?: string;
}

export interface SendContext {
  run_id: string;
  gen_index: number;
  iteration: number;
}

export interface Transport {
  readonly name: string;
  /** Lazy, per-VU. A no-op for connectionless transports. */
  connect(): void;
  /** MUST NOT throw. Failures are returned as data. */
  send(events: LogEvent[], ctx: SendContext): SendResult;
  close(): void;
}

export interface TransportConfig {
  endpoint?: string;
  options?: Record<string, unknown>;
}

export type TransportFactory = (cfg: TransportConfig) => Transport;
