import type { Profile } from './schema.ts';

/**
 * Option keys safe to embed in a run artifact.
 *
 * The summary's `resolved_config` is written to disk and uploaded to S3, so
 * anything left in it is published. The schema encourages naming a variable
 * (`token_env`) rather than holding a value, but nothing enforces that, and
 * `target.options` accepts arbitrary keys — so a literal credential written
 * into a profile would otherwise travel all the way to the bucket in
 * cleartext.
 *
 * This is an ALLOWLIST rather than a denylist of scary-looking names, so it
 * fails safe: an option added in a later transport without updating this list
 * is redacted — visible and recoverable — instead of leaked, which is silent
 * and permanent. `headers` is deliberately absent; it routinely carries
 * Authorization.
 *
 * ALLOWLISTED CONTAINER VALUES PASS THROUGH BY REFERENCE. Every entry here
 * is copied whole, so a container's nested contents are published
 * unredacted — this allowlist is one level deep, and any key added to it
 * must be safe all the way down, not just at the top. That is why `tls` was
 * REMOVED (see below), and why `resource_attributes` is the only container
 * that remains.
 */
export const SAFE_OPTION_KEYS: readonly string[] = [
  // otlp-grpc
  'plaintext',
  'timeout',
  // The one allowlisted container. Kept deliberately: it is operator-authored
  // descriptive metadata (service.name, deployment.environment and the like)
  // that already travels inside the events themselves, so redacting it would
  // cost reproducibility — you could no longer tell from the summary what the
  // run actually stamped on its events — for no security gain, since the same
  // values are on the wire and in the aggregator regardless.
  'resource_attributes',
  // otlp-http
  'path',
  'encoding',
  // hec
  'token_env',
  'index',
  'sourcetype',
  'gzip',
  // syslog
  'rfc',
  'framing',
  // `tls` is deliberately ABSENT. It was allowlisted, and it is a container:
  // Plan 2's syslog `tls` block is exactly where a client key, a certificate,
  // or a passphrase would be written, and a shallow allowlist would have
  // published all of it to S3 in cleartext. Nothing reads it today, so
  // dropping it fails safe at zero cost. If Plan 2 needs specific TLS
  // settings in the artifact, allowlist the scalar leaves it actually needs
  // (e.g. `tls_verify`) — never the block.
  'app_name',
  // null
  'count_bytes',
];

export const REDACTED = '[redacted]';

/** Returns a copy with unsafe `target.options` values replaced. Never mutates its input. */
export function redactProfile(profile: Profile): Profile {
  const options = profile.target.options;
  if (!options) return { ...profile, target: { ...profile.target } };

  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(options)) {
    safe[key] = SAFE_OPTION_KEYS.includes(key) ? options[key] : REDACTED;
  }

  return { ...profile, target: { ...profile.target, options: safe } };
}
