import type { LogTypeDef } from './types.ts';

/**
 * Resolves the severity of one event from its `LogTypeDef`.
 *
 * `severity` lives on `LogTypeDef`, not on any particular family, because
 * every family needs it: a `FamilyModule.serialize` only writes the body
 * string, so this is the one place that reads `def.severity` and turns it
 * into the `severity` string every `Template` must also return.
 *
 * No `severity` on the def, or a `{ from }` field the event doesn't carry,
 * both fall back to 'INFO'.
 */
export function resolveSeverity(def: LogTypeDef, fields: Record<string, string>): string {
  if (!def.severity) return 'INFO';
  if ('const' in def.severity) return def.severity.const;
  return fields[def.severity.from] ?? 'INFO';
}
