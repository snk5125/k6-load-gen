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
 * Written from Cribl's documented pipeline/function shapes, not verified
 * against a running Cribl instance — no instance is available here (see
 * task-6-brief.md, which owns the manual verification procedure). Treat
 * the exact function conf keys as the part most likely to need correction
 * against a real Cribl Stream deployment.
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
        conf: { regex: artifact.pattern, srcField: '_raw' },
      });
      break;

    case 'kv':
      // The fixed prefix (type=... msg=audit(epoch:serial): ) is pulled out
      // first, named captures included (type, epoch, serial, rest) — `rest`
      // is the key=value body the kvp serde below actually parses.
      fns.push({
        id: 'regex_extract',
        filter: 'true',
        conf: { regex: artifact.prefixPattern, srcField: '_raw' },
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
        conf: { type: 'kvp', srcField: 'rest', mode: 'extract' },
      });
      // Field removal: `rest` was only ever a carrier for the kvp body.
      fns.push({ id: 'eval', filter: 'true', conf: { remove: ['rest'] } });
      break;

    case 'json': {
      fns.push({
        id: 'serde',
        filter: 'true',
        conf: { type: 'json', srcField: '_raw', mode: 'extract' },
      });
      if (artifact.envelope) {
        const wrap = artifact.envelope.wrap;
        // Project every declared field out of the one-record array
        // envelope and onto the root event, in declaration order — driven
        // by def.fields, not a hand-picked list. parse_json-equivalent
        // extraction above preserves nested structure, so a dotted path
        // (e.g. userIdentity.arn) is just a chained property read here.
        fns.push({
          id: 'eval',
          filter: 'true',
          conf: {
            add: def.fields.map((f) => {
              const path = f.path ?? f.name;
              return { name: path, value: `${wrap}[0].${path}` };
            }),
          },
        });
        // Field removal: the envelope array is now redundant.
        fns.push({ id: 'eval', filter: 'true', conf: { remove: [wrap] } });
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
