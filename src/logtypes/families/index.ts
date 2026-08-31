import type { FamilyModule, FormatFamily } from '../types.ts';
import { jsonFlat } from './json-flat.ts';
import { kvAudit } from './kv-audit.ts';

const registered: Partial<Record<FormatFamily, FamilyModule>> = {
  'json-flat': jsonFlat,
  'kv-audit': kvAudit,
};

/**
 * Maps a format family name to the module that implements its grammar.
 * Indexing with a family that has no module throws, naming the families
 * that ARE available — this is how a definition with a typo'd or
 * not-yet-registered family fails loudly instead of silently at runtime.
 */
export const FAMILIES: Record<FormatFamily, FamilyModule> = new Proxy(registered, {
  get(target, prop) {
    // Symbol lookups (util.inspect, iteration protocols, ...) pass through
    // untouched — only a real family-name miss should throw.
    if (typeof prop === 'symbol') return Reflect.get(target, prop);
    const mod = target[prop as FormatFamily];
    if (!mod) {
      throw new Error(
        `unknown format family "${prop}"; available: ${Object.keys(target).join(', ')}`,
      );
    }
    return mod;
  },
}) as Record<FormatFamily, FamilyModule>;
