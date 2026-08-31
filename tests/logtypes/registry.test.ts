import { describe, it, expect } from 'vitest';
import { getLogType, LOG_TYPES } from '../../src/logtypes/registry.ts';
import { FAMILIES } from '../../src/logtypes/families/index.ts';

describe('log type registry', () => {
  it('resolves a known type', () => {
    expect(getLogType('json-app').family).toBe('json-flat');
  });

  it('names the available types when one is unknown', () => {
    // The error is the whole user experience of a typo'd type name.
    expect(() => getLogType('json-ap')).toThrow(/json-ap.*available.*json-app/s);
  });

  it('every definition names a family that exists', () => {
    // Catches a definition added without its family being registered.
    for (const def of Object.values(LOG_TYPES)) {
      expect(Object.keys(FAMILIES)).toContain(def.family);
    }
  });
});
