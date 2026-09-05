import { describe, it, expect } from 'vitest';
import {
  classifyOtlpPartialSuccess,
  classifyOtlpHttpResponse,
} from '../../src/transports/otlp-partial.ts';

const BATCH = 10;

describe('classifyOtlpPartialSuccess — the decoded ExportLogsServiceResponse', () => {
  it('treats an empty response as full acceptance', () => {
    // The overwhelmingly common shape: a collector that accepted everything
    // returns `{}` (OTLP/HTTP) or an empty message (gRPC).
    const c = classifyOtlpPartialSuccess({}, BATCH);
    expect(c).toEqual({ ok: true, accepted: BATCH, rejected: 0 });
  });

  it('treats a missing/null response as full acceptance', () => {
    expect(classifyOtlpPartialSuccess(undefined, BATCH)).toEqual({ ok: true, accepted: BATCH, rejected: 0 });
    expect(classifyOtlpPartialSuccess(null, BATCH)).toEqual({ ok: true, accepted: BATCH, rejected: 0 });
  });

  it('treats an absent or null partialSuccess as full acceptance', () => {
    expect(classifyOtlpPartialSuccess({ partialSuccess: null }, BATCH)).toEqual({
      ok: true, accepted: BATCH, rejected: 0,
    });
  });

  it('treats an EMPTY partialSuccess object as full acceptance', () => {
    // Some collectors always serialise the field. An empty one carries no
    // rejection and no message: it must not read as a failure.
    expect(classifyOtlpPartialSuccess({ partialSuccess: {} }, BATCH)).toEqual({
      ok: true, accepted: BATCH, rejected: 0,
    });
  });

  it('accepts rejectedLogRecords as a STRING (the int64-as-string protobuf JSON mapping)', () => {
    const c = classifyOtlpPartialSuccess(
      { partialSuccess: { rejectedLogRecords: '3', errorMessage: 'index full' } },
      BATCH,
    );
    expect(c.ok).toBe(false);
    expect(c.accepted).toBe(7);
    expect(c.rejected).toBe(3);
    expect(c.error).toContain('3');
    expect(c.error).toContain('index full');
  });

  it('accepts rejectedLogRecords as a NUMBER (k6 may decode it either way)', () => {
    const c = classifyOtlpPartialSuccess(
      { partialSuccess: { rejectedLogRecords: 3, errorMessage: 'index full' } },
      BATCH,
    );
    expect(c.ok).toBe(false);
    expect(c.accepted).toBe(7);
    expect(c.rejected).toBe(3);
  });

  it('accepts the snake_case protobuf field names too', () => {
    // The OTLP/JSON spec allows both the original proto field names and
    // their lowerCamelCase form; a receiver must accept either. Reading only
    // camelCase would silently report "nothing rejected" against a
    // snake_case emitter — the exact silent-wrongness this task exists to
    // remove.
    const c = classifyOtlpPartialSuccess(
      { partial_success: { rejected_log_records: '4', error_message: 'too big' } },
      BATCH,
    );
    expect(c.ok).toBe(false);
    expect(c.accepted).toBe(6);
    expect(c.rejected).toBe(4);
    expect(c.error).toContain('too big');
  });

  it('reports a whole batch rejected as accepted=0, not as a negative or a full failure', () => {
    const c = classifyOtlpPartialSuccess(
      { partialSuccess: { rejectedLogRecords: String(BATCH) } },
      BATCH,
    );
    expect(c.ok).toBe(false);
    expect(c.accepted).toBe(0);
    expect(c.rejected).toBe(BATCH);
  });

  it('is an ADVISORY when zero records were rejected but the receiver still said something', () => {
    // Spec: "rejected_log_records == 0 and error_message non-empty" is a
    // warning about the request, not a rejection. Everything was accepted.
    const c = classifyOtlpPartialSuccess(
      { partialSuccess: { rejectedLogRecords: '0', errorMessage: 'deprecated field "foo"' } },
      BATCH,
    );
    expect(c.ok).toBe(true);
    expect(c.accepted).toBe(BATCH);
    expect(c.rejected).toBe(0);
    expect(c.error).toBeUndefined();
    expect(c.advisory).toContain('deprecated field');
  });

  it('carries no advisory when zero were rejected and there is no message', () => {
    const c = classifyOtlpPartialSuccess({ partialSuccess: { rejectedLogRecords: 0 } }, BATCH);
    expect(c).toEqual({ ok: true, accepted: BATCH, rejected: 0 });
  });

  it('treats MORE rejected than the batch held as a full failure, naming the response', () => {
    // A receiver claiming it rejected 11 of the 10 records we sent is not
    // describing this batch. Believing it would publish accepted=-1 (or a
    // clamped 0 that looks measured). Refuse to attribute either number.
    const c = classifyOtlpPartialSuccess(
      { partialSuccess: { rejectedLogRecords: '11' } },
      BATCH,
    );
    expect(c.ok).toBe(false);
    expect(c.accepted).toBeNull();
    expect(c.rejected).toBeNull();
    expect(c.error).toMatch(/11/);
    expect(c.error).toMatch(/10/);
  });

  it.each([
    ['a non-numeric string', 'abc'],
    ['a fractional string', '3.5'],
    ['a negative string', '-1'],
    ['a negative number', -1],
    ['a fractional number', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['an object', { n: 1 }],
    ['an empty string', ''],
  ])('treats %s as an unparseable count — a full failure, not a silent zero', (_label, value) => {
    const c = classifyOtlpPartialSuccess({ partialSuccess: { rejectedLogRecords: value } }, BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBeNull();
    expect(c.rejected).toBeNull();
    expect(c.error).toBeTruthy();
    expect(c.error).toMatch(/malformed/i);
  });

  it('treats a non-object partialSuccess as a malformed response', () => {
    const c = classifyOtlpPartialSuccess({ partialSuccess: 'yes' }, BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBeNull();
    expect(c.rejected).toBeNull();
    expect(c.error).toMatch(/malformed/i);
  });

  it('truncates a hostile error message rather than logging it whole', () => {
    const c = classifyOtlpPartialSuccess(
      { partialSuccess: { rejectedLogRecords: 1, errorMessage: 'e'.repeat(5000) } },
      BATCH,
    );
    expect(c.error!.length).toBeLessThanOrEqual(500);
  });

  it('reports a partial rejection even with no errorMessage at all', () => {
    const c = classifyOtlpPartialSuccess({ partialSuccess: { rejectedLogRecords: 2 } }, BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBe(8);
    expect(c.rejected).toBe(2);
    expect(c.error).toBeTruthy();
  });

  it('accepts a batch of zero without inventing a rejection', () => {
    expect(classifyOtlpPartialSuccess({}, 0)).toEqual({ ok: true, accepted: 0, rejected: 0 });
  });
});

describe('classifyOtlpHttpResponse — the k6 http.Response wrapper', () => {
  it('is a full success on a 2xx with an empty body', () => {
    expect(classifyOtlpHttpResponse(200, '', '', BATCH)).toEqual({
      ok: true, accepted: BATCH, rejected: 0,
    });
  });

  it('is a full success on a 2xx with a null body (k6 reports null, not "")', () => {
    expect(classifyOtlpHttpResponse(200, null, '', BATCH)).toEqual({
      ok: true, accepted: BATCH, rejected: 0,
    });
  });

  it('is a full success on a 2xx with the usual empty JSON object', () => {
    expect(classifyOtlpHttpResponse(200, '{}', '', BATCH)).toEqual({
      ok: true, accepted: BATCH, rejected: 0,
    });
  });

  it('reads a partial success out of a 2xx JSON body', () => {
    const body = JSON.stringify({
      partialSuccess: { rejectedLogRecords: '2', errorMessage: 'log records dropped' },
    });
    const c = classifyOtlpHttpResponse(200, body, '', BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBe(8);
    expect(c.rejected).toBe(2);
    expect(c.error).toContain('log records dropped');
  });

  it('attributes NEITHER count on a non-2xx — the batch failed as a whole', () => {
    const c = classifyOtlpHttpResponse(503, 'service unavailable', '', BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBeNull();
    expect(c.rejected).toBeNull();
    expect(c.error).toBe('service unavailable');
  });

  it('keeps the k6 connection-failure diagnostic (status 0, body null, error set)', () => {
    const c = classifyOtlpHttpResponse(0, null, 'dial tcp: connection refused', BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBeNull();
    expect(c.rejected).toBeNull();
    expect(c.error).toContain('connection refused');
  });

  it('treats an unparseable 2xx body as accepted, with an advisory naming it', () => {
    // ASSERTED DECISION: a 200 means the receiver took the batch. A body we
    // cannot parse carries no rejection we are entitled to report, so the
    // events stay counted as sent — but the body is surfaced as an advisory
    // rather than discarded, because a receiver answering OTLP with
    // non-JSON is usually a proxy in the path, not the collector.
    const c = classifyOtlpHttpResponse(200, 'OK', '', BATCH);
    expect(c.ok).toBe(true);
    expect(c.accepted).toBe(BATCH);
    expect(c.rejected).toBe(0);
    expect(c.advisory).toMatch(/OK/);
  });

  it('treats a malformed partialSuccess inside a 2xx body as a full failure', () => {
    const c = classifyOtlpHttpResponse(200, '{"partialSuccess":{"rejectedLogRecords":"nope"}}', '', BATCH);
    expect(c.ok).toBe(false);
    expect(c.accepted).toBeNull();
    expect(c.rejected).toBeNull();
    expect(c.error).toMatch(/malformed/i);
  });
});
