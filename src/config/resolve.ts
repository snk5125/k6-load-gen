import type { Profile } from './schema.ts';
import { SHAPE_NAMES, type ShapeName } from '../scenarios/shapes.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Overrides {
  run_id?: string;
  target?: string;
  scenario?: string;
  knee_eps?: number;
  rate?: number;
  gen_index?: number;
  gen_count?: number;
  duration_scale?: number;
}

export interface ResolvedRun {
  run_id: string;
  profile: Profile;
  gen_index: number;
  gen_count: number;
  duration_scale: number;
}

export function resolveRun(profile: Profile, o: Overrides): ResolvedRun {
  if (!o.run_id) {
    throw new ConfigError('run_id is required and must be unique per run (set RUN_ID)');
  }

  // Copy so callers keep an unmodified profile; results must be reproducible.
  const merged: Profile = {
    ...profile,
    target: { ...profile.target },
    payload: { ...profile.payload },
    anchor: { ...profile.anchor },
  };

  if (o.target !== undefined) {
    merged.target.endpoint = o.target;
  }

  if (o.scenario !== undefined) {
    if (!SHAPE_NAMES.includes(o.scenario as ShapeName)) {
      throw new ConfigError(
        `scenario "${o.scenario}" is not known; must be one of ${SHAPE_NAMES.join(', ')}`,
      );
    }
    merged.scenario = o.scenario as ShapeName;
  }

  // RATE pins an absolute base and wins over KNEE_EPS — it is the more
  // specific instruction, and regression runs must not drift with an estimate.
  if (o.rate !== undefined) {
    if (o.rate <= 0) throw new ConfigError('rate must be a positive number');
    merged.anchor = { mode: 'absolute', base_eps: o.rate };
  } else if (o.knee_eps !== undefined) {
    if (o.knee_eps <= 0) throw new ConfigError('knee_eps must be a positive number');
    merged.anchor = { mode: 'knee', knee_eps: o.knee_eps };
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

  return { run_id: o.run_id, profile: merged, gen_index, gen_count, duration_scale };
}
