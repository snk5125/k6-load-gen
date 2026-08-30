import type { PayloadSpec } from '../payload/types.ts';
import type { Anchor } from '../scenarios/resolve.ts';
import { SHAPE_NAMES, type ShapeName } from '../scenarios/shapes.ts';
import { TRANSPORT_NAMES, type TransportName } from '../transports/names.ts';

// Re-exported (not just imported) because other modules and tests still
// import TransportName/TRANSPORT_NAMES from schema.ts — src/transports/names.ts
// is the single source, schema.ts just forwards it for backward compatibility.
export { TRANSPORT_NAMES, type TransportName };

export interface TargetSpec {
  transport: TransportName;
  endpoint?: string;
  options?: Record<string, unknown>;
}

export interface Profile {
  name: string;
  target: TargetSpec;
  payload: PayloadSpec;
  anchor: Anchor;
  scenario: ShapeName;
  emit_timeline?: boolean;
  thresholds?: Record<string, string>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

function validateFieldSpec(name: string, v: unknown, errors: string[]): void {
  if (!isObject(v)) {
    errors.push(`payload.fields.${name}: must be an object`);
    return;
  }

  if ('values' in v) {
    if (!Array.isArray(v.values) || v.values.length === 0) {
      errors.push(`payload.fields.${name}.values: must be a non-empty array`);
      return;
    }
    if (!v.values.every((x) => typeof x === 'string')) {
      errors.push(`payload.fields.${name}.values: every entry must be a string`);
    }
    if ('weights' in v && v.weights !== undefined) {
      if (!Array.isArray(v.weights) || v.weights.length !== v.values.length) {
        errors.push(
          `payload.fields.${name}.weights: length must match values (${v.values.length})`,
        );
      } else if (!v.weights.every((w) => typeof w === 'number' && w >= 0)) {
        errors.push(`payload.fields.${name}.weights: every weight must be a non-negative number`);
      }
    }
    if ('distribution' in v && v.distribution !== undefined) {
      errors.push(`payload.fields.${name}: "distribution" is only valid with "cardinality"`);
    }
    if ('pad_to' in v && v.pad_to !== undefined) {
      errors.push(`payload.fields.${name}: "pad_to" is only valid with "cardinality"`);
    }
    return;
  }

  if (!('cardinality' in v)) {
    errors.push(`payload.fields.${name}: must declare either "cardinality" or "values"`);
    return;
  }

  if ('weights' in v && v.weights !== undefined) {
    errors.push(`payload.fields.${name}: "weights" is only valid with "values"`);
  }

  if (v.cardinality === 'unbounded') {
    if ('prefix' in v && v.prefix !== undefined && typeof v.prefix !== 'string') {
      errors.push(`payload.fields.${name}.prefix: must be a string`);
    }
    return;
  }

  if (!isPositiveInt(v.cardinality)) {
    errors.push(
      `payload.fields.${name}.cardinality: must be a positive integer or "unbounded"`,
    );
  }
  if ('distribution' in v && v.distribution !== undefined &&
      v.distribution !== 'uniform' && v.distribution !== 'zipf') {
    errors.push(`payload.fields.${name}.distribution: must be "uniform" or "zipf"`);
  }
  if ('pad_to' in v && v.pad_to !== undefined && !isPositiveInt(v.pad_to)) {
    errors.push(`payload.fields.${name}.pad_to: must be a positive integer`);
  }
}

function validateAnchor(v: unknown, errors: string[]): void {
  if (!isObject(v)) {
    errors.push('anchor: must be an object');
    return;
  }
  if (v.mode === 'knee') {
    if (typeof v.knee_eps !== 'number' || v.knee_eps <= 0) {
      errors.push('anchor.knee_eps: must be a positive number when mode is "knee"');
    }
  } else if (v.mode === 'absolute') {
    if (typeof v.base_eps !== 'number' || v.base_eps <= 0) {
      errors.push('anchor.base_eps: must be a positive number when mode is "absolute"');
    }
  } else {
    errors.push('anchor.mode: must be "knee" or "absolute"');
  }
}

export function validateProfile(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: ['profile: must be a JSON object'] };
  }

  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    errors.push('name: must be a non-empty string');
  }

  // target
  if (!isObject(raw.target)) {
    errors.push('target: must be an object');
  } else {
    const t = raw.target;
    if (!TRANSPORT_NAMES.includes(t.transport as TransportName)) {
      errors.push(`target.transport: must be one of ${TRANSPORT_NAMES.join(', ')}`);
    } else if (t.transport !== 'null') {
      if (typeof t.endpoint !== 'string' || t.endpoint.length === 0) {
        errors.push(`target.endpoint: required for transport "${String(t.transport)}"`);
      }
    }
    if ('options' in t && t.options !== undefined && !isObject(t.options)) {
      errors.push('target.options: must be an object');
    }
  }

  // payload
  if (!isObject(raw.payload)) {
    errors.push('payload: must be an object');
  } else {
    const p = raw.payload;
    if (typeof p.template !== 'string' || p.template.length === 0) {
      errors.push('payload.template: must be a non-empty string');
    }
    if (!isPositiveInt(p.batch_size)) {
      errors.push('payload.batch_size: must be a positive integer');
    }
    if (!isObject(p.fields) || Object.keys(p.fields).length === 0) {
      errors.push('payload.fields: must be a non-empty object');
    } else {
      for (const [name, spec] of Object.entries(p.fields)) {
        validateFieldSpec(name, spec, errors);
      }
    }
  }

  validateAnchor(raw.anchor, errors);

  if (!SHAPE_NAMES.includes(raw.scenario as ShapeName)) {
    errors.push(`scenario: must be one of ${SHAPE_NAMES.join(', ')}`);
  }

  if ('emit_timeline' in raw && raw.emit_timeline !== undefined &&
      typeof raw.emit_timeline !== 'boolean') {
    errors.push('emit_timeline: must be a boolean');
  }

  if ('thresholds' in raw && raw.thresholds !== undefined) {
    if (!isObject(raw.thresholds)) {
      errors.push('thresholds: must be an object');
    } else {
      for (const [k, v] of Object.entries(raw.thresholds)) {
        if (typeof v !== 'string') {
          errors.push(`thresholds.${k}: must be a string expression`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
