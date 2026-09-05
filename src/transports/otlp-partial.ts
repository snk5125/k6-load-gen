// Pure classification of an OTLP export response. Imports NOTHING from k6 —
// same split as http-response.ts, otlp-payload.ts, syslog-format.ts and
// hec-params.ts: the k6-coupled adapters (otlp-http.ts, otlp-grpc.ts) stay
// thin, and the logic that decides how many events a receiver actually took
// lives here, where it can be exercised exhaustively without a k6 runtime.
//
// WHY THIS EXISTS. An OTLP receiver is allowed to accept a request and
// still refuse part of it: OTLP's `ExportLogsServiceResponse` carries an
// optional `partial_success { rejected_log_records, error_message }`, and it
// arrives on a 200/StatusOK, not on an error status. Both OTLP transports
// used to read only the status, so a collector dropping half of every batch
// (index full, cardinality limit, records too old) published a clean run
// with 100% events_sent and a 0% failure rate — the load test's single most
// important number, silently wrong, in exactly the conditions a load test is
// run to find. This module is what makes those records visible as
// `events_rejected` instead.
//
// The counts are int64 in protobuf, whose canonical JSON mapping is a
// STRING. k6 decodes gRPC responses to JSON and may present the field either
// way depending on the encoder in the path, so both are accepted; anything
// else is refused outright rather than coerced (a `Number("abc")` NaN
// silently becomes "nothing rejected", which is the failure mode this whole
// module exists to prevent).

import { classifyHttpResponse } from './http-response.ts';

/** Same bound as http-response.ts: an error message reaches console.warn
 * once per LOG_FIRST/LOG_EVERY and must not be able to flood the log tier.
 * Deliberately duplicated rather than imported, to keep this module and
 * http-response.ts free of a circular import. */
const MAX_ERROR_CHARS = 500;

export interface OtlpClassification {
  /** false for a batch that failed as a whole AND for a batch the receiver
   * partially rejected — any rejection is a failed send (see src/main.ts). */
  ok: boolean;
  /** Events the receiver took. `null` means NOT ATTRIBUTABLE — the batch
   * failed, or the response was malformed — never "zero were accepted";
   * that is a real `0`. Same contract as `wire_bytes` in types.ts. */
  accepted: number | null;
  /** Events the receiver refused. `null` carries the same "not
   * attributable" meaning as `accepted`. */
  rejected: number | null;
  /** Present only when !ok. Truncated to MAX_ERROR_CHARS. */
  error?: string;
  /** Present only when ok: the receiver said something about a request it
   * nevertheless accepted in full. Worth logging once, never a failure. */
  advisory?: string;
}

function truncate(s: string): string {
  return s.length > MAX_ERROR_CHARS ? s.slice(0, MAX_ERROR_CHARS) : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The OTLP/JSON encoding permits BOTH the original protobuf field names and
 * their lowerCamelCase form, and a receiver must accept either
 * (opentelemetry.io/docs/specs/otlp — JSON Protobuf Encoding). Reading only
 * one spelling would report "nothing rejected" against an emitter using the
 * other, so every field this module reads goes through here.
 */
function field(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

/**
 * A non-negative integer, from either an int64-as-string or a JSON number.
 * `null` for anything else — including `""`, `"3.5"`, `-1`, NaN, Infinity,
 * booleans and objects. Absent/null is the caller's concern, not this one's.
 */
function parseCount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

const FULL_SUCCESS = (batchSize: number): OtlpClassification => ({
  ok: true,
  accepted: batchSize,
  rejected: 0,
});

function malformed(detail: string): OtlpClassification {
  // Neither count is attributable: the response did not describe the batch
  // we sent, so publishing either number would be a confident wrong answer.
  // The whole batch is treated as failed, which is the conservative reading
  // (it can only over-report failure, never under-report it).
  return { ok: false, accepted: null, rejected: null, error: truncate(detail) };
}

/**
 * Classify a DECODED `ExportLogsServiceResponse`.
 *
 * `response` is whatever the transport already has in hand: `res.message`
 * for otlp-grpc (k6 decodes the protobuf for us), or the JSON-parsed body
 * for otlp-http. Typed `unknown` so this module never imports k6's types.
 */
export function classifyOtlpPartialSuccess(
  response: unknown,
  batchSize: number,
): OtlpClassification {
  if (!isRecord(response)) return FULL_SUCCESS(batchSize);

  const ps = field(response, 'partialSuccess', 'partial_success');
  // Absent or explicitly null: the receiver took everything. This is the
  // normal path and must stay cheap and unambiguous.
  if (ps === undefined || ps === null) return FULL_SUCCESS(batchSize);
  if (!isRecord(ps)) {
    return malformed(
      `malformed OTLP response: partialSuccess is not an object (${JSON.stringify(ps)})`,
    );
  }

  const rawCount = field(ps, 'rejectedLogRecords', 'rejected_log_records');
  const rawMessage = field(ps, 'errorMessage', 'error_message');
  const message = typeof rawMessage === 'string' ? rawMessage : '';

  // An empty partialSuccess is a full success: the proto3 default for the
  // count is 0, so a receiver that always serialises the field but rejected
  // nothing lands here. Treating it as malformed would fail healthy runs.
  const rejected = rawCount === undefined || rawCount === null ? 0 : parseCount(rawCount);
  if (rejected === null) {
    return malformed(
      `malformed OTLP response: partialSuccess.rejectedLogRecords is not a ` +
        `non-negative integer (${JSON.stringify(rawCount)})` +
        (message ? ` — errorMessage: ${message}` : ''),
    );
  }

  if (rejected > batchSize) {
    return malformed(
      `malformed OTLP response: receiver reported ${rejected} rejected log records for a ` +
        `batch of ${batchSize}` + (message ? ` — errorMessage: ${message}` : ''),
    );
  }

  if (rejected === 0) {
    // ADVISORY, per the OTLP spec: a partial_success whose count is zero and
    // whose message is non-empty is a warning about the request, not a
    // rejection. Everything was accepted; the run is not failing.
    const c = FULL_SUCCESS(batchSize);
    if (message) c.advisory = truncate(`OTLP receiver advisory: ${message}`);
    return c;
  }

  // Any rejection at all is a failed send: the batch did not arrive whole.
  // `accepted` is still real and is still counted into events_sent — the
  // point of this classification is that the two numbers differ.
  const accepted = Math.min(Math.max(batchSize - rejected, 0), batchSize);
  return {
    ok: false,
    accepted,
    rejected,
    error: truncate(
      `OTLP partial success: ${rejected} of ${batchSize} log records rejected` +
        (message ? ` — ${message}` : ''),
    ),
  };
}

/**
 * Classify a k6 `http.Response` from an OTLP/HTTP export.
 *
 * status/body/error mirror k6's `Response.status`/`.body`/`.error` exactly
 * (see http-response.ts for why `error` must be read at all). `batchSize` is
 * the number of events in the batch that produced this response.
 */
export function classifyOtlpHttpResponse(
  status: number,
  body: unknown,
  error: string,
  batchSize: number,
): OtlpClassification {
  const base = classifyHttpResponse(status, body, error);
  if (!base.ok) {
    // A non-2xx (or a k6 non-HTTP failure) says nothing about individual
    // records: the whole batch failed and neither count is attributable.
    return { ok: false, accepted: null, rejected: null, error: base.error };
  }

  const text = String(body ?? '').trim();
  if (text.length === 0) return FULL_SUCCESS(batchSize);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // ASSERTED DECISION (tested): a 2xx whose body is not JSON is still an
    // acceptance — the receiver took the batch — so the events stay counted
    // as sent. Refusing them would invent a failure out of a proxy's
    // "OK". The body is surfaced as an advisory rather than dropped,
    // because non-JSON here usually means something other than the
    // collector answered.
    const c = FULL_SUCCESS(batchSize);
    c.advisory = truncate(`OTLP receiver returned a non-JSON ${status} body: ${text}`);
    return c;
  }

  return classifyOtlpPartialSuccess(parsed, batchSize);
}
