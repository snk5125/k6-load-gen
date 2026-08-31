import { describe, it, expect } from 'vitest';
import { classifyHttpResponse } from '../../src/transports/http-response.ts';

describe('classifyHttpResponse', () => {
  it('treats any 2xx status as ok, with no error text', () => {
    const result = classifyHttpResponse(200, null, '');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('reports a non-2xx status with a body as not ok, using the body as the error text', () => {
    const result = classifyHttpResponse(500, 'internal server error: index full', '');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('internal server error: index full');
  });

  it('truncates a long body to 500 characters', () => {
    const longBody = 'x'.repeat(1000);
    const result = classifyHttpResponse(400, longBody, '');
    expect(result.ok).toBe(false);
    expect(result.error).toHaveLength(500);
    expect(result.error).toBe('x'.repeat(500));
  });

  it('reads the diagnostic from `error` when status is 0 and body is null — the k6 connection-failure shape', () => {
    // A REGRESSION TEST FOR A REAL, PREVIOUSLY-SHIPPED BUG: on connection
    // refusal, DNS failure, TLS failure or timeout, k6 returns status: 0
    // with body: null and puts the diagnostic in Response.error instead.
    // `String(res.body ?? '')` alone discarded it entirely, logging
    // `status=0 error=` for the single most common failure mode.
    const result = classifyHttpResponse(0, null, 'dial tcp 10.0.0.1:4318: connect: connection refused');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('connection refused');
  });

  it('truncates a long error message to 500 characters too', () => {
    const longError = 'e'.repeat(1000);
    const result = classifyHttpResponse(0, null, longError);
    expect(result.error).toHaveLength(500);
  });

  it('prefers the body over the error when both are present (documented, asserted choice)', () => {
    const result = classifyHttpResponse(502, 'bad gateway from upstream', 'some non-HTTP error');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad gateway from upstream');
  });

  it('falls back to an empty string when neither body nor error carries anything', () => {
    const result = classifyHttpResponse(0, null, '');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('');
  });
});
