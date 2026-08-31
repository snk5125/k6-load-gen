import type { Distribution, FieldSpec } from './types.ts';

const TABLE_SIZE = 4096;

/**
 * Limitation: For very large N (cardinality > TABLE_SIZE), the 4096-slot Zipf
 * lookup table cannot represent every rank; the tail becomes unreachable under
 * 'zipf' distribution. This is acceptable because Zipf is for realism, not
 * complete coverage. Distinct-count tests use uniform distribution by design.
 */

/** MurmurHash3 finalizer. Deterministic, fast, no allocation. */
export function hash32(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over the field name, so different fields decorrelate. */
export function seedFromName(name: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface FieldGenerator {
  valueAt(ordinal: number): string;
  readonly distinct_count: number | null;
}

/** Expand a weight vector into a fixed lookup table for O(1) sampling. */
function weightTable(weights: number[]): Int32Array {
  const total = weights.reduce((a, b) => a + b, 0);
  const table = new Int32Array(TABLE_SIZE);
  let rank = 0;
  let acc = weights[0] / total;
  for (let slot = 0; slot < TABLE_SIZE; slot++) {
    const p = (slot + 0.5) / TABLE_SIZE;
    while (p > acc && rank < weights.length - 1) {
      rank++;
      acc += weights[rank] / total;
    }
    table[slot] = rank;
  }
  return table;
}

function zipfWeights(n: number, exponent = 1.0): number[] {
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) w[i] = 1 / Math.pow(i + 1, exponent);
  return w;
}

function pad(value: string, to?: number): string {
  if (!to || value.length >= to) return value;
  return value + 'x'.repeat(to - value.length);
}

export function buildField(name: string, spec: FieldSpec): FieldGenerator {
  const seed = seedFromName(name);

  if ('values' in spec) {
    const pool = spec.values;
    const table = weightTable(spec.weights ?? pool.map(() => 1));
    return {
      distinct_count: pool.length,
      valueAt: (ordinal) => pool[table[hash32(ordinal, seed) % TABLE_SIZE]],
    };
  }

  if (spec.cardinality === 'unbounded') {
    const prefix = spec.prefix ?? `${name}-`;
    return {
      distinct_count: null,
      valueAt: (ordinal) => prefix + ordinal.toString(36),
    };
  }

  const n = spec.cardinality;
  const prefix = spec.prefix ?? `${name}-`;
  const pool = new Array<string>(n);
  for (let i = 0; i < n; i++) pool[i] = pad(`${prefix}${i}`, spec.pad_to);

  const dist: Distribution = spec.distribution ?? 'uniform';
  if (dist === 'zipf') {
    const table = weightTable(zipfWeights(n));
    return {
      distinct_count: n,
      valueAt: (ordinal) => pool[table[hash32(ordinal, seed) % TABLE_SIZE]],
    };
  }

  return {
    distinct_count: n,
    valueAt: (ordinal) => pool[hash32(ordinal, seed) % n],
  };
}
