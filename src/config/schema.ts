import type { Anchor } from '../scenarios/resolve.ts';
import { SHAPE_NAMES, type ShapeName } from '../scenarios/shapes.ts';
import { TRANSPORT_NAMES, type TransportName } from '../transports/names.ts';
import { LOG_TYPES } from '../logtypes/registry.ts';

// Re-exported (not just imported) because other modules and tests still
// import TransportName/TRANSPORT_NAMES from schema.ts — src/transports/names.ts
// is the single source, schema.ts just forwards it for backward compatibility.
export { TRANSPORT_NAMES, type TransportName };

export interface TargetSpec {
  transport: TransportName;
  endpoint?: string;
  options?: Record<string, unknown>;
}

/**
 * One selected log type's run configuration. `cardinality` names overrides
 * onto the `LogTypeDef`'s declared fields (see src/logtypes/registry.ts) —
 * the profile no longer declares fields itself, the type does.
 */
export interface TypeConfig {
  batch_size: number;
  anchor: Anchor;
  scenario: ShapeName;
  cardinality?: Record<string, number>;
}

export interface Profile {
  name: string;
  target: TargetSpec;
  types: Record<string, TypeConfig>;
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

// Per-transport option specs — spec §6.1's option tables are the source of
// truth. Each key names the shape its value must take so a typo'd key or a
// wrong-typed value is caught at validation time instead of at runtime.
type OptionSpec =
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'string-enum'; values: string[] }
  | { kind: 'number-enum'; values: number[] }
  | { kind: 'object' };

const TRANSPORT_OPTION_SPECS: Record<TransportName, Record<string, OptionSpec>> = {
  'otlp-grpc': {
    plaintext: { kind: 'boolean' },
    timeout: { kind: 'string' },
    resource_attributes: { kind: 'object' },
  },
  'otlp-http': {
    path: { kind: 'string' },
    encoding: { kind: 'string-enum', values: ['protobuf', 'json'] },
    headers: { kind: 'object' },
  },
  hec: {
    path: { kind: 'string' },
    token_env: { kind: 'string' },
    index: { kind: 'string' },
    sourcetype: { kind: 'string' },
    gzip: { kind: 'boolean' },
  },
  syslog: {
    rfc: { kind: 'number-enum', values: [5424, 3164] },
    framing: { kind: 'string-enum', values: ['octet-counted', 'lf'] },
    tls: { kind: 'boolean' },
    app_name: { kind: 'string' },
  },
  null: {
    count_bytes: { kind: 'boolean' },
  },
};

function optionMatchesSpec(v: unknown, spec: OptionSpec): boolean {
  switch (spec.kind) {
    case 'boolean':
      return typeof v === 'boolean';
    case 'string':
      return typeof v === 'string';
    case 'string-enum':
      return typeof v === 'string' && spec.values.includes(v);
    case 'number-enum':
      return typeof v === 'number' && spec.values.includes(v);
    case 'object':
      return isObject(v);
  }
}

function describeOptionSpec(spec: OptionSpec): string {
  switch (spec.kind) {
    case 'boolean':
      return 'a boolean';
    case 'string':
      return 'a string';
    case 'string-enum':
      return `one of ${spec.values.join(', ')}`;
    case 'number-enum':
      return `one of ${spec.values.join(', ')}`;
    case 'object':
      return 'an object';
  }
}

function validateTransportOptions(
  transport: TransportName,
  options: Record<string, unknown>,
  errors: string[],
): void {
  const spec = TRANSPORT_OPTION_SPECS[transport];
  const validKeys = Object.keys(spec);
  for (const [key, value] of Object.entries(options)) {
    // hasOwnProperty guard, same as the LOG_TYPES lookup below: an unguarded
    // `spec[key]` walks the prototype chain, so `{"constructor": true}` (or
    // any other Object.prototype member name) resolves to a function
    // instead of undefined. The profile is still rejected either way — but
    // without this guard it fails with the misleading `must be undefined`
    // message instead of the intended unknown-option message.
    const keySpec = Object.prototype.hasOwnProperty.call(spec, key) ? spec[key] : undefined;
    if (!keySpec) {
      errors.push(
        `target.options.${key}: unknown option for transport "${transport}"; valid options: ${validKeys.join(', ')}`,
      );
      continue;
    }
    if (!optionMatchesSpec(value, keySpec)) {
      errors.push(`target.options.${key}: must be ${describeOptionSpec(keySpec)}`);
    }
  }
}

function validateAnchor(v: unknown, errors: string[], prefix: string): void {
  if (!isObject(v)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }
  if (v.mode === 'knee') {
    if (typeof v.knee_eps !== 'number' || v.knee_eps <= 0) {
      errors.push(`${prefix}.knee_eps: must be a positive number when mode is "knee"`);
    }
  } else if (v.mode === 'absolute') {
    if (typeof v.base_eps !== 'number' || v.base_eps <= 0) {
      errors.push(`${prefix}.base_eps: must be a positive number when mode is "absolute"`);
    }
  } else {
    errors.push(`${prefix}.mode: must be "knee" or "absolute"`);
  }
}

/**
 * Validates one entry of the profile's `types` map. `typeName` is the map
 * key AND (per Task 6's resolveRun) becomes the PayloadSpec.template for
 * this type, so an unknown type name is rejected here rather than later at
 * generator-build time.
 */
function validateTypeConfig(typeName: string, v: unknown, errors: string[]): void {
  const prefix = `types.${typeName}`;
  // hasOwnProperty guard for the same prototype-pollution reason as the
  // transport-option lookup above: LOG_TYPES is a plain object literal.
  const known = Object.prototype.hasOwnProperty.call(LOG_TYPES, typeName);
  if (!known) {
    errors.push(
      `${prefix}: unknown log type "${typeName}"; available: ${Object.keys(LOG_TYPES).join(', ')}`,
    );
  }

  if (!isObject(v)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  if (!isPositiveInt(v.batch_size)) {
    errors.push(`${prefix}.batch_size: must be a positive integer`);
  }

  validateAnchor(v.anchor, errors, `${prefix}.anchor`);

  if (!SHAPE_NAMES.includes(v.scenario as ShapeName)) {
    errors.push(`${prefix}.scenario: must be one of ${SHAPE_NAMES.join(', ')}`);
  }

  if ('cardinality' in v && v.cardinality !== undefined) {
    if (!isObject(v.cardinality)) {
      errors.push(`${prefix}.cardinality: must be an object`);
      return;
    }
    // Only checkable against the type's declared fields when the type name
    // itself resolved — an unknown type already reported its own error above.
    const def = known ? LOG_TYPES[typeName] : undefined;
    const declared = def ? new Map(def.fields.map((f) => [f.name, f])) : null;
    for (const [fieldName, fieldValue] of Object.entries(v.cardinality)) {
      const field = declared?.get(fieldName);
      if (declared && !field) {
        errors.push(
          `${prefix}.cardinality.${fieldName}: not a field of log type "${typeName}"; ` +
            `available: ${[...declared.keys()].join(', ')}`,
        );
        continue;
      }
      if (!isPositiveInt(fieldValue)) {
        errors.push(`${prefix}.cardinality.${fieldName}: must be a positive integer`);
        continue;
      }
      // A field declared with a fixed `values` list has no numeric
      // cardinality to override — silently accepting the override here
      // would mean it never actually changes the generated field, the same
      // silent-drop failure mode the merge in resolveRun is built to avoid.
      if (field && !('cardinality' in field.spec)) {
        errors.push(
          `${prefix}.cardinality.${fieldName}: field "${fieldName}" has a fixed set of values ` +
            `and does not support a cardinality override`,
        );
      }
    }
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
    const transportValid = TRANSPORT_NAMES.includes(t.transport as TransportName);
    if (!transportValid) {
      errors.push(`target.transport: must be one of ${TRANSPORT_NAMES.join(', ')}`);
    } else if (t.transport !== 'null') {
      if (typeof t.endpoint !== 'string' || t.endpoint.length === 0) {
        errors.push(`target.endpoint: required for transport "${String(t.transport)}"`);
      }
    }
    if ('options' in t && t.options !== undefined) {
      if (!isObject(t.options)) {
        errors.push('target.options: must be an object');
      } else if (transportValid) {
        validateTransportOptions(t.transport as TransportName, t.options, errors);
      }
    }
  }

  // The legacy single-{payload,anchor,scenario} shape is dropped, not
  // supported alongside — these messages are the only migration
  // documentation a user gets. All three are checked (not just `payload`):
  // a user who adds `types` but leaves the old top-level `anchor` or
  // `scenario` in place must not validate silently — those two keys are
  // simply ignored by everything downstream once `types` is present, which
  // would otherwise look like a working profile that quietly runs
  // different rates/shapes than the ones still sitting at the top level.
  const LEGACY_TOP_LEVEL_KEYS: Record<string, string> = {
    payload: 'declare one or more log types under "types" instead',
    anchor: 'move it into the "anchor" of each entry under "types" instead',
    scenario: 'move it into the "scenario" of each entry under "types" instead',
  };
  for (const [key, guidance] of Object.entries(LEGACY_TOP_LEVEL_KEYS)) {
    if (key in raw && raw[key] !== undefined) {
      errors.push(`${key}: profile-level "${key}" is no longer supported; ${guidance}`);
    }
  }

  // types
  if (!isObject(raw.types)) {
    errors.push('types: must be an object');
  } else if (Object.keys(raw.types).length === 0) {
    // A profile that runs nothing is a configuration error, not an empty run.
    errors.push('types: must declare at least one log type');
  } else {
    for (const [typeName, typeConfig] of Object.entries(raw.types)) {
      validateTypeConfig(typeName, typeConfig, errors);
    }
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
