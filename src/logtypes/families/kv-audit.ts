import type { FamilyModule, LogTypeDef, ParseArtifact } from '../types.ts';

/**
 * Linux auditd's SYSCALL record shape: a fixed `type=... msg=audit(epoch:serial): `
 * prefix, then every field as `key=value`, quoting only where the grammar
 * requires it. The prefix's epoch/serial and the quoting rule are exactly
 * what PREFIX_PATTERN below promises a reader can extract — they must stay
 * in lockstep, which is why both live in this one module.
 */
const PREFIX_PATTERN =
  '^type=(?<type>\\S+) msg=audit\\((?<epoch>\\d+\\.\\d{3}):(?<serial>\\d+)\\): (?<rest>.*)$';

/**
 * Matches exactly what formatKvValue (below) emits for one `key=value`
 * pair: a value is either a `"`-quoted string (itself possibly containing
 * `\"`, `\\`, or any other backslash escape) or a bare non-whitespace
 * token. Defined as a RegExp so `.source` is always in lockstep with the
 * pattern actually used at match time — no separate string to drift.
 */
const PAIR_REGEX = /(\S+?)=("(?:[^"\\]|\\.)*"|\S*)/;

/** Never emit a newline — before deciding whether a value needs quoting. */
function stripNewlines(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

/** Quote when the value contains a space, a `"`, or an `=`; escape `"` as `\"`. */
function formatKvValue(value: string): string {
  const clean = stripNewlines(value);
  if (clean.includes(' ') || clean.includes('"') || clean.includes('=')) {
    return `"${clean.replace(/"/g, '\\"')}"`;
  }
  return clean;
}

export const kvAudit: FamilyModule = {
  serialize(def: LogTypeDef, values: Record<string, string>, ts_ms: number, seq: number): string {
    const type = def.constants?.type ?? '';
    // Build with string padding, not toFixed — toFixed is subject to
    // floating point (e.g. 943.4999999... rounding the wrong way).
    const epochSec = Math.floor(ts_ms / 1000);
    const millis = ts_ms - epochSec * 1000;
    const prefix = `type=${type} msg=audit(${epochSec}.${String(millis).padStart(3, '0')}:${seq}): `;

    const body = def.fields
      .map((f) => `${f.name}=${formatKvValue(values[f.name] ?? '')}`)
      .join(' ');

    return prefix + body;
  },

  parseArtifact(_def: LogTypeDef): ParseArtifact {
    return { kind: 'kv', separator: ' ', prefixPattern: PREFIX_PATTERN, pairPattern: PAIR_REGEX.source };
  },
};
