import type { ParseArtifact } from '../../src/logtypes/types.ts';

/**
 * The one place any family's round-trip test parses a serialized body.
 * Switches on `artifact.kind` so a family's `parseArtifact()` is forced to
 * actually describe how to read what its `serialize()` wrote — a family
 * whose two halves drift fails a round-trip test by construction, rather
 * than by someone remembering to assert it by hand.
 *
 * `kv` and `regex` are left unimplemented on purpose: writing a parser for
 * a grammar that doesn't exist yet (auditd, nginx CLF land in later tasks)
 * would be guessing.
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
    default:
      throw new Error(`parseWithArtifact: not implemented for kind "${artifact.kind}"`);
  }
}
