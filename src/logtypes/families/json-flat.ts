import type { FamilyModule, LogTypeDef, ParseArtifact } from '../types.ts';

/**
 * Flat JSON: one JSON object per event, no nesting.
 * `JSON.stringify` naturally satisfies the no-embedded-newline constraint —
 * it escapes control characters (a real `\n` becomes the two characters `\` `n`).
 *
 * A def with `envelope` set (e.g. CloudTrail's `Records[]`) gets its one
 * record wrapped in a single-element array under the envelope key — this
 * must stay in lockstep with what `parseArtifact` below promises a reader
 * can unwrap, since both describe the same wire shape.
 */
export const jsonFlat: FamilyModule = {
  serialize(def: LogTypeDef, values: Record<string, string>, _ts_ms: number, seq: number): string {
    const record = { ...values, seq };
    if (def.envelope) {
      return JSON.stringify({ [def.envelope.wrap]: [record] });
    }
    return JSON.stringify(record);
  },

  parseArtifact(def: LogTypeDef): ParseArtifact {
    if (def.envelope) {
      return { kind: 'json', nested: false, envelope: { wrap: def.envelope.wrap } };
    }
    return { kind: 'json', nested: false };
  },
};
