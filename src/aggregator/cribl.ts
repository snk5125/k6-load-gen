import type { LogTypeDef, LogTypeField, ParseArtifact } from '../logtypes/types.ts';
import { FAMILIES } from '../logtypes/families/index.ts';
import type { RenderedConfig } from './types.ts';

interface CriblFunction {
  id: string;
  filter: string;
  conf: Record<string, unknown>;
}

/**
 * Renders a Cribl Stream pipeline that parses the wire format `def`'s
 * family serializes — driven entirely by that family's `parseArtifact()`,
 * never a hand-derived pattern (same rule as the Vector renderer; see
 * src/aggregator/vector.ts and the FamilyModule doc comment in
 * src/logtypes/types.ts).
 *
 * A Cribl pipeline is JSON natively (`{ id, conf: { functions: [...] } }`),
 * so there is no YAML-vs-JSON decision to make here the way there was for
 * Vector. The three function types that matter, per spec: `regex_extract`
 * (a named-capture regex), `serde` (`type: 'kvp'` for key=value, `type:
 * 'json'` for JSON), and `eval` for type coercion and field removal.
 *
 * Written from Cribl's documented pipeline/function shapes. `regex_extract`
 * and `serde`'s conf keys are now verified against stock functions read off
 * a live Cribl instance (whole-branch review, IMPORTANT 1 — see the
 * per-function comments below for exactly what was checked against what;
 * the two functions genuinely use different source-field key names, which
 * is why this could not be settled from memory alone). `eval`'s `add`/
 * `remove` shape and the full manual field-by-field check remain
 * unverified against a running instance — see
 * aggregator-configs/README.md's "Manual Cribl check" for that procedure.
 */
export function renderCriblPipeline(def: LogTypeDef): RenderedConfig {
  const artifact = FAMILIES[def.family].parseArtifact(def);
  const functions = buildFunctions(def, artifact);

  const config = {
    id: def.name,
    conf: { functions },
  };

  return { filename: 'pipeline.json', content: JSON.stringify(config, null, 2) + '\n' };
}

/** One or more Cribl functions per artifact kind, plus field coercions every kind needs. */
function buildFunctions(def: LogTypeDef, artifact: ParseArtifact): CriblFunction[] {
  const fns: CriblFunction[] = [];

  switch (artifact.kind) {
    case 'regex':
      fns.push({
        id: 'regex_extract',
        filter: 'true',
        // Verified against a live Cribl instance (whole-branch review,
        // IMPORTANT 1): all four stock regex_extract functions read
        // `source` (not `srcField`), and every stored regex is a
        // delimited literal (`/…/`), never a bare pattern string.
        conf: { regex: `/${artifact.pattern}/`, source: '_raw' },
      });
      // `_raw` is preserved by regex_extract by default — unlike every
      // Vector branch, which drops `.message` right after parsing (see
      // src/aggregator/vector.ts). Removing it here keeps an ingest-byte
      // comparison between the two vendors honest instead of double-
      // counting Cribl's raw line (whole-branch review, IMPORTANT 3).
      fns.push({ id: 'eval', filter: 'true', conf: { remove: ['_raw'] } });
      break;

    case 'kv':
      // The fixed prefix (type=... msg=audit(epoch:serial): ) is pulled out
      // first, named captures included (type, epoch, serial, rest) — `rest`
      // is the key=value body the kvp serde below actually parses.
      fns.push({
        id: 'regex_extract',
        filter: 'true',
        // Same `source`/delimited-regex correction as the regex-kind case
        // above, verified the same way (whole-branch review, IMPORTANT 1).
        conf: { regex: `/${artifact.prefixPattern}/`, source: '_raw' },
      });
      // Cribl's built-in kvp serde owns its own quoting rules, the same
      // way pairPattern owns Vector's — but its defaults must agree with
      // formatKvValue (src/logtypes/families/kv-audit.ts:28-34) on three
      // characters: pair delimiter (space), quote char (`"`), and escape
      // char (`\`). That agreement is currently implicit (delegated to
      // Cribl's defaults, not asserted anywhere) — Task 6's manual check
      // is what actually verifies it against a real instance.
      fns.push({
        id: 'serde',
        filter: 'true',
        // `srcField` (unlike regex_extract's `source`) verified correct
        // as already written: the stock `cisco_estreamer` pipeline's
        // serde function uses exactly `{mode, type: 'kvp', srcField:
        // '_raw'}` (whole-branch review, IMPORTANT 1 — the two function
        // types genuinely use different key names).
        conf: { type: 'kvp', srcField: 'rest', mode: 'extract' },
      });
      // Field removal: `rest` was only ever a carrier for the kvp body;
      // `_raw` goes too, for the same reason as the regex case above
      // (whole-branch review, IMPORTANT 3).
      fns.push({ id: 'eval', filter: 'true', conf: { remove: ['rest', '_raw'] } });
      break;

    case 'json': {
      fns.push({
        id: 'serde',
        filter: 'true',
        // `srcField` verified correct as written — see the kv case's
        // serde comment above.
        conf: { type: 'json', srcField: '_raw', mode: 'extract' },
      });
      if (artifact.envelope) {
        const wrap = artifact.envelope.wrap;
        // Project every declared field, plus every non-field key the
        // family writes onto the record (`extraFields` — see
        // json-nested.ts's parseArtifact), out of the one-record array
        // envelope and onto the root event, in declaration order — driven
        // by the artifact and def.fields, never a hand-picked list.
        // Vector's `. = .Records[0]` keeps the whole record for free;
        // Cribl has no equivalent wholesale-replace, so this list has to
        // be kept in lockstep with everything serialize() actually writes
        // (whole-branch review, IMPORTANT 2 — this used to silently drop
        // cloudtrail's eventVersion/eventTime). parse_json-equivalent
        // extraction above preserves nested structure, so a dotted path
        // (e.g. userIdentity.arn) is just a chained property read here.
        const extraFields = artifact.envelope.extraFields ?? [];
        const paths = [...extraFields, ...def.fields.map((f) => f.path ?? f.name)];
        fns.push({
          id: 'eval',
          filter: 'true',
          conf: {
            add: paths.map((path) => ({ name: path, value: `${wrap}[0].${path}` })),
          },
        });
        // Field removal: the envelope array is now redundant, and `_raw`
        // goes for the same reason as the regex/kv cases above
        // (whole-branch review, IMPORTANT 3).
        fns.push({ id: 'eval', filter: 'true', conf: { remove: [wrap, '_raw'] } });
      } else {
        fns.push({ id: 'eval', filter: 'true', conf: { remove: ['_raw'] } });
      }
      break;
    }

    default: {
      // Exhaustive today (json/kv/regex), but a family adding a new
      // ParseArtifact kind without a renderer case must fail loudly here
      // rather than silently drop every one of its fields (spec §6.3).
      const kind = (artifact as ParseArtifact).kind;
      throw new Error(
        `renderCriblPipeline: no case for family "${def.family}" (artifact kind "${kind}")`,
      );
    }
  }

  const coercions = coercionEntries(def.fields);
  if (coercions.length > 0) {
    fns.push({ id: 'eval', filter: 'true', conf: { add: coercions } });
  }

  return fns;
}

/**
 * One `{ name, value }` eval entry per field whose `parse.type` calls for
 * coercion, in `def.fields` declaration order (never a Set or Object.keys
 * of a dynamically-built object — that would make output non-deterministic
 * and fail the CI drift gate on unrelated commits).
 *
 * `ip` fields are left alone: the extracted string already is the address,
 * and Cribl has no distinct IP type to coerce into. `string` fields (and
 * fields with no `parse` at all) are likewise left alone.
 *
 * `timestamp` coerces to an epoch-ms *number* (`Date.parse`), whereas the
 * Vector renderer's `to_timestamp!` yields VRL's native Timestamp *type* —
 * the two disagree on representation for the same field. Unreachable
 * today (no definition uses `timestamp`), and left this way rather than
 * forced into a false equivalence: Cribl's JS eval engine has no distinct
 * Timestamp type to target, so epoch-ms is the closest native fit, not a
 * shortcut. If a definition ever adds a `timestamp` field, whatever
 * consumes both renderers' output needs to know this asymmetry exists.
 */
function coercionEntries(fields: LogTypeField[]): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  for (const f of fields) {
    const path = f.path ?? f.name;
    switch (f.parse?.type) {
      case 'int':
        entries.push({ name: path, value: `Number(${path})` });
        break;
      case 'timestamp':
        entries.push({ name: path, value: `Date.parse(${path})` });
        break;
      default:
        break;
    }
  }
  return entries;
}
