import type { LogTypeDef, LogTypeField, ParseArtifact } from '../logtypes/types.ts';
import { FAMILIES } from '../logtypes/families/index.ts';
import type { RenderedConfig } from './types.ts';

/**
 * Renders a Vector `remap` transform (VRL) that parses the wire format
 * `def`'s family serializes — driven entirely by that family's
 * `parseArtifact()`, never a hand-derived pattern (see FamilyModule's doc
 * comment in src/logtypes/types.ts for why serialize/parseArtifact living
 * in one module matters here).
 *
 * Emitted as JSON, not spec §6.1's `transform.yaml`: the repo has zero
 * runtime dependencies (no YAML library available), and hand-rolling a
 * YAML emitter for VRL dense with regex backslashes (`\S`, `\d`, `[^"]`)
 * is exactly where such an emitter breaks silently. Verified live before
 * writing this renderer: a hand-written JSON source/transform/sink Vector
 * config (`docker run --rm -v <dir>:/cfg:ro timberio/vector:latest-alpine
 * validate --no-environment /cfg/minimal.json`) printed "Validated" with
 * no YAML involved — see task-2-3-report.md for the full transcript.
 */
export function renderVectorTransform(def: LogTypeDef): RenderedConfig {
  const artifact = FAMILIES[def.family].parseArtifact(def);
  const source = buildVrl(def, artifact).join('\n');

  const config = {
    transforms: {
      [def.name]: {
        type: 'remap',
        // "in" is the conventional source id this fragment is meant to be
        // wired to; the CLI/deployment step that stitches this transform
        // into a full Vector pipeline owns the actual source and sink.
        inputs: ['in'],
        source,
      },
    },
  };

  return { filename: 'transform.json', content: JSON.stringify(config, null, 2) + '\n' };
}

/** One VRL line per artifact kind, plus the field coercions every kind needs. */
function buildVrl(def: LogTypeDef, artifact: ParseArtifact): string[] {
  switch (artifact.kind) {
    case 'regex':
      return [
        `. |= parse_regex!(.message, r'${artifact.pattern}')`,
        ...coercionLines(def.fields),
      ];

    case 'kv':
      return [
        // The fixed prefix (type=... msg=audit(epoch:serial): ) merges its
        // named captures onto the event, including `rest` — the key=value
        // body the pair grammar below scans.
        `. |= parse_regex!(.message, r'${artifact.prefixPattern}')`,
        `pairs = parse_regex_all!(.rest, r'${artifact.pairPattern}')`,
        `for_each(array!(pairs)) -> |_index, pair| {`,
        `  . = set!(., [pair."1"], pair."2")`,
        `}`,
        `del(.rest)`,
        `del(.message)`,
        ...coercionLines(def.fields),
      ];

    case 'json': {
      const lines = [`. = parse_json!(.message)`];
      if (artifact.envelope) {
        // parse_json preserves structure, so a nested field needs no extra
        // work beyond this — only the envelope has to be unwrapped, per
        // spec §3.5's one-record-per-envelope contract.
        lines.push(`. = .${artifact.envelope.wrap}[0]`);
      }
      lines.push(...coercionLines(def.fields));
      return lines;
    }

    default: {
      // Exhaustive today (json/kv/regex), but a family adding a new
      // ParseArtifact kind without a renderer case must fail loudly here
      // rather than silently drop every one of its fields (spec §6.3).
      const kind = (artifact as ParseArtifact).kind;
      throw new Error(
        `renderVectorTransform: no case for family "${def.family}" (artifact kind "${kind}")`,
      );
    }
  }
}

/**
 * Emits a `to_int!`/`to_timestamp!` coercion per field whose `parse.type`
 * calls for one, in `def.fields` declaration order (never a Set or
 * Object.keys of a dynamically-built object — that would make the output
 * non-deterministic and fail the CI drift gate on unrelated commits).
 *
 * `ip` fields are left alone: VRL has no distinct IP type, so an address
 * already parsed out as a string needs no further coercion. `string`
 * fields (and fields with no `parse` at all) are likewise left alone.
 */
function coercionLines(fields: LogTypeField[]): string[] {
  const lines: string[] = [];
  for (const f of fields) {
    const path = f.path ?? f.name;
    switch (f.parse?.type) {
      case 'int':
        lines.push(`.${path} = to_int!(.${path})`);
        break;
      case 'timestamp':
        lines.push(`.${path} = to_timestamp!(.${path})`);
        break;
      default:
        break;
    }
  }
  return lines;
}
