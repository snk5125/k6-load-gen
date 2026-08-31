import { describe, it, expect } from 'vitest';
import { buildHecParams } from '../../src/transports/hec-params.ts';

describe('buildHecParams', () => {
  it('omits the compression key entirely when gzip is false', () => {
    // A REGRESSION TEST FOR A REAL, PREVIOUSLY-SHIPPED BUG: `{ compression:
    // undefined }` is not the same thing as an absent `compression` key —
    // k6's HTTP client treated the key's mere PRESENCE as "compression
    // requested" and rejected every request with `unknown compression
    // algorithm undefined`, a 100% send failure for the shipped hec profile
    // (gzip: false by default). `toBeUndefined()` would pass on both the
    // broken and fixed builder, since the broken version's key IS undefined
    // — it would not have caught this. `in` checks presence, not value, so
    // it actually distinguishes them.
    const params = buildHecParams({ Authorization: 'Splunk t' }, false);
    expect('compression' in params).toBe(false);
  });

  it('sets compression to "gzip" when gzip is true', () => {
    const params = buildHecParams({ Authorization: 'Splunk t' }, true);
    expect('compression' in params).toBe(true);
    expect(params.compression).toBe('gzip');
  });

  it('passes the headers object through unchanged', () => {
    const headers = { Authorization: 'Splunk t', 'Content-Type': 'application/json' };
    const params = buildHecParams(headers, false);
    expect(params.headers).toBe(headers);
  });
});
