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
  /** Lazy, per-VU. A no-op for connectionless transports. MUST NOT reject. */
  connect(): Promise<void>;
  /**
   * MUST NOT throw AND MUST NOT REJECT. Failures are returned as data.
   *
   * The never-reject half is new and is easy to get wrong: a rejected Promise
   * is not caught by a `try/catch` placed around a call that is not awaited,
   * so every async implementation must handle its own rejection path
   * explicitly rather than relying on a caller's guard.
   */
  send(events: LogEvent[], ctx: SendContext): Promise<SendResult>;
  close(): Promise<void>;
}

export interface TransportConfig {
  endpoint?: string;
  options?: Record<string, unknown>;
}

export type TransportFactory = (cfg: TransportConfig) => Transport;
