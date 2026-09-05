import type { Overrides } from './resolve.ts';

/**
 * Parses a numeric environment variable.
 *
 * Rejects NaN *and* the infinities: `RATE=Infinity` and `RATE=1e400` both
 * survive `Number()`, then survive a `<= 0` check downstream, and would
 * reach `resolveScenario` — which documents finite positive rates as an
 * upstream-enforced precondition and produces Infinity stage targets and a NaN
 * delta_pct when it is violated. This is where that precondition is enforced.
 *
 * `name` is included in the message so two variables with the same bad value
 * do not produce identical errors.
 */
function num(name: string, v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name}: expected a finite number, got "${v}"`);
  }
  return parsed;
}

export function profileName(): string {
  const p = __ENV.PROFILE;
  if (!p) {
    throw new Error('PROFILE is required (e.g. PROFILE=local-null)');
  }
  return p;
}

/**
 * Global env vars that named a single scenario/anchor override before a
 * profile could declare more than one log type. Now that `anchor` and
 * `scenario` live per type (see TypeConfig in schema.ts), a bare `RATE` or
 * `SCENARIO` no longer has an unambiguous target — silently ignoring them
 * would be exactly the "mistyped variable does nothing" failure class the
 * `<TYPE>_*` surface below exists to avoid. Fail loudly instead, naming the
 * replacement, the same way the legacy `payload` shape is rejected in
 * schema.ts.
 */
const LEGACY_GLOBAL_OVERRIDES: Record<string, string> = {
  SCENARIO: '<TYPE>_SCENARIO',
  RATE: '<TYPE>_RATE',
  KNEE_EPS: '<TYPE>_KNEE_EPS',
};

export function readOverrides(): Overrides {
  for (const [legacyVar, replacement] of Object.entries(LEGACY_GLOBAL_OVERRIDES)) {
    const v = __ENV[legacyVar];
    if (v !== undefined && v !== '') {
      throw new Error(
        `${legacyVar} is no longer supported as a global override now that a profile can declare ` +
          `more than one log type; set ${replacement} for the specific type instead (e.g. AUDITD_RATE)`,
      );
    }
  }

  return {
    run_id: __ENV.RUN_ID,
    target: __ENV.TARGET,
    gen_index: num('GEN_INDEX', __ENV.GEN_INDEX),
    gen_count: num('GEN_COUNT', __ENV.GEN_COUNT),
    duration_scale: num('DURATION_SCALE', __ENV.DURATION_SCALE),
  };
}

/**
 * The scheduled start instant, as `START_AT` carries it — an ISO-8601 UTC
 * timestamp or a bare Unix epoch in seconds (see bin/run.sh's `to_epoch`),
 * or null when nothing scheduled this run.
 *
 * NOT used to configure the run: bin/run.sh has already slept until this
 * instant by the time k6 starts. It is recorded in the summary so a
 * correlation tool can align a fleet's stage boundaries on the instant every
 * generator was TOLD to start, instead of on each generator's own observed
 * start — which differ by exactly the placement skew START_AT exists to
 * remove. Deliberately unvalidated here: an unparseable value is already
 * logged and ignored by the wrapper, and publishing what was actually set
 * tells a reader more than dropping it would.
 */
export function startAt(): string | null {
  const v = __ENV.START_AT;
  return v === undefined || v === '' ? null : v;
}

/** Uppercases and replaces hyphens: `nginx-access` -> `NGINX_ACCESS`. */
export function envPrefixFor(typeName: string): string {
  return typeName.toUpperCase().replace(/-/g, '_');
}

export interface TypeOverride {
  rate?: number;
  knee_eps?: number;
  scenario?: string;
  batch_size?: number;
}

export interface TypeOverridesResult {
  active: string[];
  overrides: Record<string, TypeOverride>;
  warnings: string[];
}

/**
 * Reads the `<TYPE>_*` environment surface for every type a profile
 * declares, plus the `TYPES` variable that subsets which of them actually
 * run this invocation.
 */
export function readTypeOverrides(profileTypes: string[]): TypeOverridesResult {
  // Two profile type names must never resolve to the same env prefix — that
  // would make an override ambiguous (which type does AUDITD_RATE mean?)
  // and silently wrong if allowed, rather than caught here.
  const byPrefix = new Map<string, string[]>();
  for (const t of profileTypes) {
    const prefix = envPrefixFor(t);
    const list = byPrefix.get(prefix) ?? [];
    list.push(t);
    byPrefix.set(prefix, list);
  }
  for (const [prefix, types] of byPrefix) {
    if (types.length > 1) {
      throw new Error(
        `${prefix}: ambiguous env prefix — profile types ${types.join(', ')} all map to it`,
      );
    }
  }

  let active = profileTypes;
  const typesVar = __ENV.TYPES;
  if (typesVar !== undefined && typesVar !== '') {
    const requested = typesVar
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // A profile that runs nothing is a configuration error, not an empty
    // run — same rule schema.ts already enforces on an empty `types` map.
    // TYPES="," (or ",,") passes the initial non-empty-string check above
    // but filters down to nothing, so it needs its own guard.
    if (requested.length === 0) {
      throw new Error(`TYPES="${typesVar}" names no log types; unset TYPES to run every declared type`);
    }
    const duplicates = requested.filter((t, i) => requested.indexOf(t) !== i);
    if (duplicates.length > 0) {
      // A duplicate would resolve into one k6 scenario (the map key can
      // only appear once) while every EPS/sample aggregate in main.ts
      // double-counts it — a silent, wrong number rather than a loud error.
      throw new Error(
        `TYPES names "${[...new Set(duplicates)].join(', ')}" more than once; each type may appear at most once`,
      );
    }
    const unknown = requested.filter((t) => !profileTypes.includes(t));
    if (unknown.length > 0) {
      throw new Error(
        `TYPES names unknown type(s) ${unknown.join(', ')}; profile declares ${profileTypes.join(', ')}`,
      );
    }
    active = requested;
  }
  const activeSet = new Set(active);

  const overrides: Record<string, TypeOverride> = {};
  const warnings: string[] = [];

  for (const t of profileTypes) {
    const prefix = envPrefixFor(t);
    const varNames = {
      rate: `${prefix}_RATE`,
      knee_eps: `${prefix}_KNEE_EPS`,
      scenario: `${prefix}_SCENARIO`,
      batch_size: `${prefix}_BATCH_SIZE`,
    } as const;

    const raw = {
      rate: __ENV[varNames.rate],
      knee_eps: __ENV[varNames.knee_eps],
      scenario: __ENV[varNames.scenario],
      batch_size: __ENV[varNames.batch_size],
    };
    const setKeys = (Object.keys(raw) as Array<keyof typeof raw>).filter(
      (k) => raw[k] !== undefined && raw[k] !== '',
    );

    if (setKeys.length === 0) continue;

    if (!activeSet.has(t)) {
      // A mistyped variable that silently does nothing is a known failure
      // class here — warn instead of staying quiet.
      for (const k of setKeys) {
        warnings.push(
          `${varNames[k]} is set but type "${t}" is not active (TYPES=${active.join(',')}); it will have no effect`,
        );
      }
      continue;
    }

    const o: TypeOverride = {};
    if (raw.rate !== undefined && raw.rate !== '') o.rate = num(varNames.rate, raw.rate);
    if (raw.knee_eps !== undefined && raw.knee_eps !== '') {
      o.knee_eps = num(varNames.knee_eps, raw.knee_eps);
    }
    if (raw.scenario !== undefined && raw.scenario !== '') o.scenario = raw.scenario;
    if (raw.batch_size !== undefined && raw.batch_size !== '') {
      o.batch_size = num(varNames.batch_size, raw.batch_size);
    }
    overrides[t] = o;
  }

  // The loop above only catches a KNOWN type's prefix set while inactive
  // (e.g. CLOUDTRAIL_RATE when TYPES=auditd) — it can't catch a prefix that
  // matches no declared type at all, e.g. CLOUDTRAILL_RATE (typo). That is
  // the more likely mistake, and it is the half the loop above doesn't
  // cover, so scan every set env var for the `_RATE`/`_KNEE_EPS`/
  // `_SCENARIO`/`_BATCH_SIZE` shape and warn on any whose prefix isn't one
  // of this profile's own type prefixes.
  const validPrefixes = new Set(profileTypes.map(envPrefixFor));
  const OVERRIDE_SUFFIXES = ['BATCH_SIZE', 'KNEE_EPS', 'SCENARIO', 'RATE'] as const;
  for (const key of Object.keys(__ENV)) {
    for (const suffix of OVERRIDE_SUFFIXES) {
      if (!key.endsWith(`_${suffix}`)) continue;
      const prefix = key.slice(0, key.length - suffix.length - 1);
      if (prefix.length > 0 && !validPrefixes.has(prefix)) {
        warnings.push(
          `${key} looks like a per-type override, but "${prefix}" does not match any of this ` +
            `profile's log types (valid prefixes: ${[...validPrefixes].join(', ')}); it will have no effect`,
        );
      }
      break; // the four suffixes are mutually exclusive — at most one matches
    }
  }

  return { active, overrides, warnings };
}
