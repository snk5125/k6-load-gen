import type { LogEvent } from '../payload/types.ts';

export interface SendResult {
  ok: boolean;
  status?: number | string;
  /** null when the transport genuinely cannot observe its wire size. */
  wire_bytes: number | null;
  /**
   * How many events of this batch the target took, and how many it refused.
   *
   * For every transport except the two OTLP ones these are the whole batch
   * and 0 on success — a receiver that answers 200 took all of it. OTLP is
   * different: its `ExportLogsServiceResponse` may carry a
   * `partial_success` that refuses part of a batch it otherwise accepted,
   * ON A 200 (see src/transports/otlp-partial.ts). Without these fields
   * that refusal was invisible and the run published a clean 100%
   * events_sent.
   *
   * `null` on both means NOT ATTRIBUTABLE — the batch failed as a whole, or
   * the response was malformed. It never means zero: that is a real `0`.
   * Same contract as `wire_bytes` above.
   *
   * INVARIANT when both are non-null: accepted + rejected === batch length.
   */
  accepted: number | null;
  rejected: number | null;
  error?: string;
  /**
   * Set only on an OK result: the target accepted everything but still said
   * something about the request (an OTLP partial_success with a zero count
   * and a non-empty message, or a non-JSON 2xx body). src/main.ts logs it
   * under the same LOG_FIRST/LOG_EVERY bound as a failure; it never counts
   * as one.
   */
  advisory?: string;
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
