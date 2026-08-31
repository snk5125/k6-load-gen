import { describe, it, expect } from 'vitest';
import { resolveSeverity } from '../../src/logtypes/severity.ts';
import type { LogTypeDef } from '../../src/logtypes/types.ts';

const defWith = (severity?: LogTypeDef['severity']): LogTypeDef => ({
  name: 'test-type',
  family: 'json-flat',
  fields: [],
  severity,
});

describe('resolveSeverity', () => {
  it('{const}: always returns the fixed value, regardless of fields', () => {
    const def = defWith({ const: 'ERROR' });
    expect(resolveSeverity(def, {})).toBe('ERROR');
    expect(resolveSeverity(def, { level: 'DEBUG' })).toBe('ERROR');
  });

  it('{from}: reads the named field when present', () => {
    const def = defWith({ from: 'level' });
    expect(resolveSeverity(def, { level: 'WARN' })).toBe('WARN');
  });

  it('{from}: falls back to INFO when the named field is absent from this event', () => {
    const def = defWith({ from: 'level' });
    expect(resolveSeverity(def, { other: 'x' })).toBe('INFO');
  });

  it('falls back to INFO when the def declares no severity at all', () => {
    const def = defWith(undefined);
    expect(resolveSeverity(def, { level: 'ERROR' })).toBe('INFO');
  });
});
