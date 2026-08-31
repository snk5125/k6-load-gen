import type { Profile, TypeConfig } from './schema.ts';
import type { TypeOverride } from './env.ts';
import { SHAPE_NAMES, SHAPES, type ShapeName } from '../scenarios/shapes.ts';
import { resolveScenario, type Anchor } from '../scenarios/resolve.ts';
import { getLogType } from '../logtypes/registry.ts';
import type { FieldSpec, PayloadSpec } from '../payload/types.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Run-level overrides. `anchor`/`scenario`/`batch_size` moved to per-type
 * overrides (see `TypeOverride`) now that a run can carry more than one
 * type — see src/config/env.ts. */
export interface Overrides {
  run_id?: string;
  target?: string;
  gen_index?: number;
  gen_count?: number;
  duration_scale?: number;
}

/** The active-type/override input produced by `readTypeOverrides`, threaded
 * in explicitly rather than read here — `resolveRun` stays a pure
 * composition function, __ENV access stays in env.ts. */
export interface TypeOverridesInput {
  active: string[];
  overrides: Record<string, TypeOverride>;
}

export interface TypeRun {
  /** The k6 scenario object for this type — see resolveScenario's `k6`. */
  k6: Record<string, unknown>;
  /** Merges the LogTypeDef's declared fields with this type's cardinality
   * overrides — see buildPayloadSpec below. Every field the LogTypeDef
   * declares is present; a merge that dropped one would silently vanish
   * from every emitted event of that type. */
  payload: PayloadSpec;
  requested_peak_eps: number;
  achieved_peak_eps: number;
  delta_pct: number;
  abort_on_fail: boolean;
  warnings: string[];
}

export interface ResolvedRun {
  run_id: string;
  profile: Profile;
  gen_index: number;
  gen_count: number;
  duration_scale: number;
  /** Which of `profile.types`' keys actually run this invocation — a
   * subset when `TYPES` was set, otherwise all of them. */
  active_types: string[];
  /** One resolved entry per active type, keyed by type name. */
  types: Record<string, TypeRun>;
}

/**
 * Applies a cardinality override onto one field's declared spec.
 *
 * `validateProfile` already rejects a cardinality override naming a field
 * with no numeric cardinality (a `values`-list field) and a field the type
 * does not declare at all, so the `'values' in spec` branch below is
 * unreachable for a validated profile — it is defensive, not load-bearing.
 */
function applyCardinalityOverride(spec: FieldSpec, override: number | undefined): FieldSpec {
  if (override === undefined || 'values' in spec) return spec;
  if (spec.cardinality === 'unbounded') {
    // Overriding an unbounded field bounds it, keeping its prefix.
    return { cardinality: override, prefix: spec.prefix };
  }
  return { ...spec, cardinality: override };
}

/**
 * Constructs the PayloadSpec `buildGenerator` consumes for one type, merging:
 *  - the LogTypeDef's declared fields (from `getLogType`) — iterated in
 *    full, so every declared field is present in the result;
 *  - the profile's `cardinality` overrides, applied to matching fields;
 *  - this type's resolved `batch_size`;
 *  - `template: <the type name>`.
 */
function buildPayloadSpec(
  typeName: string,
  cardinality: Record<string, number> | undefined,
  batchSize: number,
): PayloadSpec {
  const def = getLogType(typeName);
  const fields: Record<string, FieldSpec> = {};
  for (const f of def.fields) {
    fields[f.name] = applyCardinalityOverride(f.spec, cardinality?.[f.name]);
  }
  return { template: typeName, batch_size: batchSize, fields };
}

export function resolveRun(
  profile: Profile,
  o: Overrides,
  typeOverrides: TypeOverridesInput,
): ResolvedRun {
  if (!o.run_id) {
    throw new ConfigError('run_id is required and must be unique per run (set RUN_ID)');
  }

  // Copy so callers keep an unmodified profile; results must be reproducible.
  const target = { ...profile.target };
  if (o.target !== undefined) {
    target.endpoint = o.target;
  }

  const gen_count = o.gen_count ?? 1;
  if (!Number.isInteger(gen_count) || gen_count < 1) {
    throw new ConfigError(`gen_count must be an integer >= 1 (got ${gen_count})`);
  }

  const gen_index = o.gen_index ?? 0;
  if (!Number.isInteger(gen_index) || gen_index < 0 || gen_index >= gen_count) {
    throw new ConfigError(
      `gen_index must be an integer in [0, ${gen_count - 1}] (got ${gen_index})`,
    );
  }

  const duration_scale = o.duration_scale ?? 1;
  if (!(duration_scale > 0)) {
    throw new ConfigError(`duration_scale must be greater than 0 (got ${duration_scale})`);
  }

  const types: Record<string, TypeRun> = {};
  // A copy of profile.types with each active type's TypeConfig replaced by
  // what actually ran (post-override) — this is what lands in run.profile,
  // which handleSummary publishes as resolved_config. Without this, a run
  // started with AUDITD_RATE=9000 would still show the profile's original
  // anchor in its own published summary, the same fidelity the old
  // single-type resolveRun preserved by writing overrides into merged.anchor.
  const mergedTypes: Record<string, TypeConfig> = { ...profile.types };
  for (const typeName of typeOverrides.active) {
    const tc = profile.types[typeName];
    if (!tc) {
      // Cannot happen when `typeOverrides.active` was derived from this same
      // profile's `types` keys (readTypeOverrides' contract) — defensive.
      throw new ConfigError(`active type "${typeName}" is not declared in the profile's types`);
    }
    const ov = typeOverrides.overrides[typeName] ?? {};

    let scenarioName: ShapeName = tc.scenario;
    if (ov.scenario !== undefined) {
      if (!SHAPE_NAMES.includes(ov.scenario as ShapeName)) {
        throw new ConfigError(
          `scenario "${ov.scenario}" for type "${typeName}" is not known; must be one of ${SHAPE_NAMES.join(', ')}`,
        );
      }
      scenarioName = ov.scenario as ShapeName;
    }

    // RATE pins an absolute anchor and wins over KNEE_EPS — matching the
    // existing global precedence documented in the README, now applied
    // per type.
    let anchor: Anchor = tc.anchor;
    if (ov.rate !== undefined) {
      if (ov.rate <= 0) throw new ConfigError(`rate for type "${typeName}" must be a positive number`);
      anchor = { mode: 'absolute', base_eps: ov.rate };
    } else if (ov.knee_eps !== undefined) {
      if (ov.knee_eps <= 0) {
        throw new ConfigError(`knee_eps for type "${typeName}" must be a positive number`);
      }
      anchor = { mode: 'knee', knee_eps: ov.knee_eps };
    }

    let batchSize = tc.batch_size;
    if (ov.batch_size !== undefined) {
      if (!Number.isInteger(ov.batch_size) || ov.batch_size < 1) {
        throw new ConfigError(`batch_size for type "${typeName}" must be a positive integer`);
      }
      batchSize = ov.batch_size;
    }

    const payload = buildPayloadSpec(typeName, tc.cardinality, batchSize);
    const shape = SHAPES[scenarioName];
    const resolved = resolveScenario({ shape, anchor, batch_size: batchSize, gen_count, duration_scale });

    types[typeName] = {
      k6: resolved.k6,
      payload,
      requested_peak_eps: resolved.requested_peak_eps,
      achieved_peak_eps: resolved.achieved_peak_eps,
      delta_pct: resolved.delta_pct,
      abort_on_fail: resolved.abort_on_fail,
      warnings: resolved.warnings,
    };
    mergedTypes[typeName] = { batch_size: batchSize, anchor, scenario: scenarioName, cardinality: tc.cardinality };
  }

  const merged: Profile = { ...profile, target, types: mergedTypes };

  return {
    run_id: o.run_id,
    profile: merged,
    gen_index,
    gen_count,
    duration_scale,
    active_types: typeOverrides.active,
    types,
  };
}
