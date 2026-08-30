import { buildField, type FieldGenerator } from './fields.ts';
import type { LogEvent, PayloadSpec } from './types.ts';
import { jsonApp, type Template } from './templates/json-app.ts';

export type { Template };

export const TEMPLATES: Record<string, Template> = {
  'json-app': jsonApp,
};

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
      const { severity, body } = template(fields, seq);
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
