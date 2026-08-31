import type { FieldSpec } from '../payload/types.ts';

export type FormatFamily = 'json-flat' | 'kv-audit' | 'json-nested' | 'regex-clf';

export interface LogTypeField {
  name: string;
  spec: FieldSpec;
  /** Nested formats only: dotted path, e.g. 'userIdentity.arn'. Defaults to `name`. */
  path?: string;
  /**
   * Consumed by Sub-project B, split across two different places — the two
   * halves of `parse` do NOT share a consumer. `type` drives the
   * renderers' own per-field coercions: Vector's `to_int!`/`to_timestamp!`
   * (src/aggregator/vector.ts) and Cribl's `Number()`/`Date.parse()` eval
   * entries (src/aggregator/cribl.ts). `index` drives none of that — no
   * vendor's transform stage exposes per-field indexing, so a renderer has
   * nothing to do with it. `index` instead drives the *sink* wrapped
   * around the rendered transform: Vector's `splunk_hec_logs` sink's
   * `indexed_fields` (built by tests/aggregator/roundtrip's harness, from
   * `fields.filter(f => f.parse?.index)`) and, for Cribl, the Splunk
   * destination's indexed-fields list checked manually per
   * aggregator-configs/README.md. Absent means { type: 'string', index: false }.
   */
  parse?: { type: 'string' | 'int' | 'timestamp' | 'ip'; index?: boolean };
}

export interface LogTypeDef {
  name: string;
  family: FormatFamily;
  fields: LogTypeField[];
  /** Fixed values that are part of the grammar, e.g. auditd's type=SYSCALL. */
  constants?: Record<string, string>;
  severity?: { from: string } | { const: string };
  /** Array envelope, e.g. CloudTrail's Records[]. One record per envelope — see spec §3.5. */
  envelope?: { wrap: string; mode: 'array' };
}

/**
 * A family owns its grammar. `serialize` writes it; `parseArtifact` describes how to read it.
 * BOTH are consumed downstream — Sub-project B's Cribl and Vector renderers read
 * `parseArtifact` — so a divergence between writing and reading is impossible by
 * construction rather than prevented by discipline.
 */
export interface FamilyModule {
  serialize(def: LogTypeDef, values: Record<string, string>, ts_ms: number, seq: number): string;
  parseArtifact(def: LogTypeDef): ParseArtifact;
}

export type ParseArtifact =
  | {
      kind: 'json';
      nested: boolean;
      /**
       * `extraFields`: dotted paths the family writes onto the record
       * besides `def.fields` (e.g. json-nested's constants and its
       * always-derived `eventTime`) — only meaningful with `wrap` set.
       * Vector's envelope unwrap (`. = .<wrap>[0]`) keeps the whole record
       * for free; Cribl's renderer has no equivalent wholesale-replace, so
       * it must know every extra key to project out of the envelope
       * alongside `def.fields` (src/aggregator/cribl.ts) — driven by the
       * family, never a hand-picked list, same rule as everything else
       * ParseArtifact carries.
       */
      envelope?: { wrap: string; extraFields?: string[] };
    }
  // `separator` is the character serialize joins pairs with (for a reader
  // that only needs to know the field delimiter). `pairPattern` is the
  // grammar the family actually generates — key=value with quoting on
  // space/`"`/`=`, `"` escaped as `\"` — as a regex source string, ready
  // for `new RegExp(pairPattern, 'g')`. It exists because `separator` alone
  // cannot describe quoting: a splitter built only from `separator` breaks
  // on the first value containing a space (see kv-audit.ts's
  // formatKvValue). The family owns pairPattern, same as prefixPattern, so
  // it can never drift from what serialize() actually writes.
  | { kind: 'kv'; separator: string; prefixPattern: string; pairPattern: string }
  | { kind: 'regex'; pattern: string };
