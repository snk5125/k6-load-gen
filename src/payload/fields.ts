import type { Distribution, FieldSpec } from './types.ts';

const TABLE_SIZE = 4096;

/**
 * Limitation: both table-backed paths — 'zipf' over a numeric cardinality and
 * a weighted `values` list — sample through a 4096-slot lookup table, so at
 * most TABLE_SIZE distinct ranks are ever reachable, and a rank whose share of
 * the total weight is well under 1/TABLE_SIZE may get no slot at all (the
 * Zipf tail, or a `values` entry with weight 0). This is acceptable because
 * those distributions exist for realism, not complete coverage; the uniform
 * cardinality path indexes the pool directly and reaches every value.
 * `distinct_count` on a table-backed generator reports what the table can
 * actually produce, not the declared pool size. Distinct-count tests use
 * uniform distribution by design.
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
  // Weights are authored in code (src/logtypes/definitions), so a bad vector
  // is a definition bug: fail at build time rather than divide by zero and
  // silently collapse every draw onto values[0].
  if (!(total > 0)) {
    throw new Error(`weights must sum to a positive number (got [${weights.join(', ')}])`);
  }
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

/** How many distinct ranks a lookup table can produce — see the limitation note above. */
function reachableRanks(table: Int32Array): number {
  return new Set(table).size;
}

function zipfWeights(n: number, exponent = 1.0): number[] {
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) w[i] = 1 / Math.pow(i + 1, exponent);
  return w;
}

/** Right-pads to a MINIMUM width; a value already longer than `to` is returned unchanged. */
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
      distinct_count: reachableRanks(table),
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
      distinct_count: reachableRanks(table),
      valueAt: (ordinal) => pool[table[hash32(ordinal, seed) % TABLE_SIZE]],
    };
  }

  return {
    distinct_count: n,
    valueAt: (ordinal) => pool[hash32(ordinal, seed) % n],
  };
}
