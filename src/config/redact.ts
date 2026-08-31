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
 * must be safe all the way down, not just at the top. `resource_attributes`
 * is the only allowlisted key that is actually a container; `tls` looks like
 * one in principle but is not one here — see its comment below for why it is
 * allowlisted anyway.
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
  // `tls` is allowlisted ONLY because src/config/schema.ts constrains it to a
  // strict boolean for the syslog transport (a non-boolean `tls` fails
  // validation before a profile ever reaches this list) — a boolean is safe
  // all the way down, so there is no nested container to leak. If `tls` is
  // ever loosened back into an object (a key, a certificate, a passphrase),
  // this key must come back off the list; do not assume the safety carries
  // over.
  'tls',
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
