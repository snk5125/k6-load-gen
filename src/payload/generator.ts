import { buildField, type FieldGenerator } from './fields.ts';
import type { LogEvent, PayloadSpec } from './types.ts';
import { FAMILIES } from '../logtypes/families/index.ts';
import { LOG_TYPES } from '../logtypes/registry.ts';
import type { LogTypeDef } from '../logtypes/types.ts';

export type Template = (
  fields: Record<string, string>,
  ts_ms: number,
  seq: number,
) => { severity: string; body: string };

/** A def with no `severity` (or a `from` field the event lacks) falls back to 'INFO'. */
function severityOf(def: LogTypeDef, fields: Record<string, string>): string {
  if (!def.severity) return 'INFO';
  if ('const' in def.severity) return def.severity.const;
  return fields[def.severity.from] ?? 'INFO';
}

export const TEMPLATES: Record<string, Template> = Object.fromEntries(
  Object.values(LOG_TYPES).map((def) => [
    def.name,
    (fields: Record<string, string>, ts_ms: number, seq: number) => ({
      severity: severityOf(def, fields),
      body: FAMILIES[def.family].serialize(def, fields, ts_ms, seq),
    }),
  ]),
);

export interface GeneratorContext {
  run_id: string;
  gen_index: number;
}

export interface BatchGenerator {
  batchAt(iteration: number, now_ms: number): LogEvent[];
  expectedAt(iteration: number): Omit<LogEvent, 'ts_ms'>[];
}

export function buildGenerator(
  spec: PayloadSpec,
  ctx: GeneratorContext,
): BatchGenerator {
  const template = TEMPLATES[spec.template];
  if (!template) {
    throw new Error(
      `unknown template "${spec.template}"; available: ${Object.keys(TEMPLATES).join(', ')}`,
    );
  }

  // Built once — per-event work must stay index arithmetic and string assembly.
  const names = Object.keys(spec.fields);
  const gens: FieldGenerator[] = names.map((n) => buildField(n, spec.fields[n]));
  const batch = spec.batch_size;

  function build(iteration: number, now_ms: number): LogEvent[] {
    const out = new Array<LogEvent>(batch);
    const base = iteration * batch;
    for (let i = 0; i < batch; i++) {
      const seq = base + i;
      const fields: Record<string, string> = {};
      for (let f = 0; f < names.length; f++) {
        fields[names[f]] = gens[f].valueAt(seq);
      }
      const { severity, body } = template(fields, now_ms, seq);
      out[i] = {
        ts_ms: now_ms,
        severity,
        body,
        fields,
        run_id: ctx.run_id,
        gen_index: ctx.gen_index,
        seq,
      };
    }
    return out;
  }

  return {
    batchAt: build,
    expectedAt(iteration) {
      return build(iteration, 0).map(({ ts_ms, ...rest }) => rest);
    },
  };
}
