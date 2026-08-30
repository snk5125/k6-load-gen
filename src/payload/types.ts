export type Distribution = 'uniform' | 'zipf';

export type FieldSpec =
  | { cardinality: number; distribution?: Distribution; pad_to?: number }
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
  seq: number;
}
