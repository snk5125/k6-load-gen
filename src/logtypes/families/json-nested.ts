import type { FamilyModule, LogTypeDef, ParseArtifact } from '../types.ts';

/**
 * Nested JSON with an array envelope — CloudTrail's shape (spec §3.5): one
 * record per envelope, fields placed at dotted paths (`userIdentity.arn`
 * lands at `record.userIdentity.arn`, not a flat `"userIdentity.arn"` key).
 *
 * `JSON.stringify` gives the no-embedded-newline guarantee for free, same
 * as json-flat — a real `\n` inside a value is escaped to the two
 * characters `\` `n`, never emitted literally.
 *
 * `eventTime` is not one of `def.fields`: it is always derived from
 * `ts_ms` via `new Date(ts_ms).toISOString()`, the same way kv-audit always
 * derives its `msg=audit(epoch.millis:serial)` prefix from `ts_ms` rather
 * than treating it as a generated field.
 */

/** Sets `obj.a.b.c = value` for path `'a.b.c'`, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (typeof next !== 'object' || next === null) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export const jsonNested: FamilyModule = {
  serialize(def: LogTypeDef, values: Record<string, string>, ts_ms: number, _seq: number): string {
    const record: Record<string, unknown> = {};

    if (def.constants) {
      for (const [key, value] of Object.entries(def.constants)) {
        setPath(record, key, value);
      }
    }

    record.eventTime = new Date(ts_ms).toISOString();

    for (const f of def.fields) {
      const path = f.path ?? f.name;
      setPath(record, path, values[f.name] ?? '');
    }

    if (def.envelope) {
      return JSON.stringify({ [def.envelope.wrap]: [record] });
    }
    return JSON.stringify(record);
  },

  parseArtifact(def: LogTypeDef): ParseArtifact {
    if (def.envelope) {
      // Mirrors what serialize() actually writes onto `record` besides
      // def.fields: constants (set first, above) and `eventTime` (always
      // derived from ts_ms — see this module's doc comment). Cribl's
      // renderer projects this list out of the envelope explicitly since
      // it has no equivalent to Vector's whole-record `. = .Records[0]`
      // unwrap; letting either drift out of sync here is exactly the bug
      // this field exists to prevent (see IMPORTANT 2, whole-branch
      // review: cloudtrail's eventVersion/eventTime were silently dropped).
      const extraFields = [...Object.keys(def.constants ?? {}), 'eventTime'];
      return { kind: 'json', nested: true, envelope: { wrap: def.envelope.wrap, extraFields } };
    }
    return { kind: 'json', nested: true };
  },
};
