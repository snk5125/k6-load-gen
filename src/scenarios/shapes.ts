export interface RelStage {
  mult: number;
  duration_sec: number;
}

export type ShapeDef =
  | {
      executor: 'ramping-arrival-rate';
      start_mult: number;
      stages: RelStage[];
      abort_on_fail?: boolean;
    }
  | { executor: 'shared-iterations'; iterations: number; vus: number };

export type ShapeName =
  | 'smoke'
  | 'calibrate'
  | 'sweep'
  | 'staircase'
  | 'breakpoint'
  | 'spike'
  | 'sawtooth'
  | 'burst-idle'
  | 'plateau'
  | 'soak'
  | 'backpressure-hold'
  | 'recovery';

/** A ramp to `mult` followed by a hold at `mult`. */
const step = (mult: number, ramp: number, hold: number): RelStage[] => [
  { mult, duration_sec: ramp },
  { mult, duration_sec: hold },
];

const cycle = (n: number, stages: RelStage[]): RelStage[] =>
  Array.from({ length: n }, () => stages).flat();

export const SHAPES: Record<ShapeName, ShapeDef> = {
  // Does the target, config, and payload work at all?
  smoke: { executor: 'shared-iterations', iterations: 20, vus: 1 },

  // What can ONE generator push on this transport? Push well past the target's
  // capacity on purpose — this measures the generator, not the aggregator.
  calibrate: {
    executor: 'ramping-arrival-rate',
    start_mult: 0.5,
    stages: [0.5, 1, 2, 4, 8].flatMap((m) => step(m, 30, 60)),
  },

  // Where is the knee?
  sweep: {
    executor: 'ramping-arrival-rate',
    start_mult: 0.1,
    stages: [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5].flatMap((m) => step(m, 15, 165)),
  },

  // What happens past the knee?
  staircase: {
    executor: 'ramping-arrival-rate',
    start_mult: 0.5,
    stages: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0].flatMap((m) => step(m, 15, 285)),
  },

  // Ceiling discovery. abort_on_fail stops the run when thresholds break.
  breakpoint: {
    executor: 'ramping-arrival-rate',
    start_mult: 0.1,
    stages: [{ mult: 5.0, duration_sec: 1800 }],
    abort_on_fail: true,
  },

  // Does scale-out land before the SLO breaks?
  spike: {
    executor: 'ramping-arrival-rate',
    start_mult: 1.0,
    stages: [
      { mult: 1.0, duration_sec: 300 },
      { mult: 4.0, duration_sec: 30 },
      { mult: 4.0, duration_sec: 600 },
      { mult: 1.0, duration_sec: 120 },
    ],
  },

  // Does autoscaling flap?
  sawtooth: {
    executor: 'ramping-arrival-rate',
    start_mult: 1.0,
    stages: cycle(4, [
      { mult: 2.5, duration_sec: 300 },
      { mult: 1.0, duration_sec: 300 },
    ]),
  },

  // Cold buffers: batch jobs and incident storms.
  'burst-idle': {
    executor: 'ramping-arrival-rate',
    start_mult: 0.05,
    stages: cycle(6, [
      { mult: 0.05, duration_sec: 300 },
      { mult: 3.0, duration_sec: 30 },
    ]),
  },

  // Steady state; the platform for kill tests.
  plateau: {
    executor: 'ramping-arrival-rate',
    start_mult: 2.0,
    stages: [{ mult: 2.0, duration_sec: 900 }],
  },

  // Leaks, buffer growth, EFS credit drain.
  soak: {
    executor: 'ramping-arrival-rate',
    start_mult: 0.7,
    stages: [{ mult: 0.7, duration_sec: 14400 }],
  },

  // What does blocking/buffering actually do past capacity?
  'backpressure-hold': {
    executor: 'ramping-arrival-rate',
    start_mult: 1.0,
    stages: [
      { mult: 2.5, duration_sec: 60 },
      { mult: 2.5, duration_sec: 1200 },
    ],
  },

  // Drain time after overload. The trailing idle stage is where drain is observed.
  recovery: {
    executor: 'ramping-arrival-rate',
    start_mult: 1.0,
    stages: [
      { mult: 1.0, duration_sec: 300 },
      { mult: 3.0, duration_sec: 600 },
      { mult: 0.05, duration_sec: 900 },
    ],
  },
};

export const SHAPE_NAMES = Object.keys(SHAPES) as ShapeName[];
