import type { FamilyModule, LogTypeDef, ParseArtifact } from '../types.ts';

/**
 * Flat JSON: one JSON object per event, no nesting, no envelope.
 * `JSON.stringify` naturally satisfies the no-embedded-newline constraint —
 * it escapes control characters (a real `\n` becomes the two characters `\` `n`).
 */
export const jsonFlat: FamilyModule = {
  serialize(_def: LogTypeDef, values: Record<string, string>, _ts_ms: number, seq: number): string {
    return JSON.stringify({ ...values, seq });
  },

  parseArtifact(def: LogTypeDef): ParseArtifact {
    if (def.envelope) {
      return { kind: 'json', nested: false, envelope: { wrap: def.envelope.wrap } };
    }
    return { kind: 'json', nested: false };
  },
};
