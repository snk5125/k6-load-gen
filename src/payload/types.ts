export type Distribution = 'uniform' | 'zipf';

export type FieldSpec =
  | { cardinality: number; distribution?: Distribution; pad_to?: number; prefix?: string }
  | { cardinality: 'unbounded'; prefix?: string }
  | { values: string[]; weights?: number[] };

export interface PayloadSpec {
  template: string;
  batch_size: number;
  fields: Record<string, FieldSpec>;
}

export interface LogEvent {
  ts_ms: number;
  severity: string;
  body: string;
  fields: Record<string, string>;
  run_id: string;
  gen_index: number;
  /** Which log type generated this event, e.g. "auditd". Required so an
   * event's full identity is (run_id, gen_index, type, seq) — `seq` alone
   * restarts at 0 per k6 scenario (see main.ts: iteration is
   * exec.scenario.iterationInTest, which is PER SCENARIO), so in a
   * multi-type run distinct events from different types can otherwise share
   * (run_id, gen_index, seq). Transports are not required to put this on
   * the wire (see buildGenerator/otlp-payload.ts for the current call); it
   * must, however, always be present on the in-process LogEvent so a
   * consumer that needs full collision-safe identity has it to work with. */
  type: string;
  seq: number;
}
