import type { ParseArtifact } from '../../src/logtypes/types.ts';

/**
 * The one place any family's round-trip test parses a serialized body.
 * Switches on `artifact.kind` so a family's `parseArtifact()` is forced to
 * actually describe how to read what its `serialize()` wrote — a family
 * whose two halves drift fails a round-trip test by construction, rather
 * than by someone remembering to assert it by hand.
 */
export function parseWithArtifact(
  artifact: ParseArtifact,
  body: string,
): Record<string, unknown> {
  switch (artifact.kind) {
    case 'json': {
      const parsed = JSON.parse(body);
      // The artifact — not the test — decides whether to unwrap an envelope.
      return artifact.envelope ? parsed[artifact.envelope.wrap][0] : parsed;
    }
    case 'kv': {
      // The prefix pattern captures the fixed grammar (type, epoch, serial)
      // plus a `rest` group holding the key=value body. `rest` is scanned
      // with artifact.pairPattern — the family's OWN description of its
      // key=value grammar, quoting included — not a private copy of it, so
      // this can never drift from what serialize() actually wrote. A quoted
      // "k=v with spaces" value is honored as one pair; \" is unescaped back
      // to " — the inverse of what kv-audit's formatKvValue does.
      const m = new RegExp(artifact.prefixPattern).exec(body);
      if (!m || !m.groups) {
        throw new Error('parseWithArtifact: body does not match the kv prefix pattern');
      }
      const { rest, ...prefixGroups } = m.groups;
      const result: Record<string, unknown> = { ...prefixGroups };
      const pairPattern = new RegExp(artifact.pairPattern, 'g');
      let pair: RegExpExecArray | null;
      while ((pair = pairPattern.exec(rest ?? ''))) {
        const [, key, rawValue] = pair;
        result[key] =
          rawValue.startsWith('"') && rawValue.endsWith('"')
            ? rawValue.slice(1, -1).replace(/\\"/g, '"')
            : rawValue;
      }
      return result;
    }
    case 'regex': {
      const m = new RegExp(artifact.pattern).exec(body);
      if (!m || !m.groups) {
        throw new Error('parseWithArtifact: body does not match the pattern');
      }
      return { ...m.groups };
    }
    default:
      throw new Error(`parseWithArtifact: not implemented for kind "${(artifact as ParseArtifact).kind}"`);
  }
}
