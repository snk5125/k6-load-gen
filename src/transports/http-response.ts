// Pure classification of a k6 http.Response outcome. Imports NOTHING from
// k6 — this is the testable half of otlp-http.ts and hec.ts, same pattern
// as otlp-payload.ts, syslog-format.ts and hec-params.ts: the k6-coupled
// adapters stay thin, the logic that can be exercised without a k6 runtime
// lives here instead.
//
// Both otlp-http.ts and hec.ts used to build their error text from
// `String(res.body ?? '')` alone. k6 represents a non-HTTP failure —
// connection refused, DNS failure, TLS failure, timeout — as `status: 0`
// with `body: null`, and puts the actual diagnostic in `Response.error`
// ("Non-HTTP error message", @types/k6/http/index.d.ts) instead. Reading
// only `body` silently discards that diagnostic for the single most common
// failure mode, so src/main.ts logged `status=0 error=` for an entire
// outage. This helper reads both fields so that case is handled.

export interface HttpClassification {
  ok: boolean;
  /** Present only when !ok. Truncated to MAX_ERROR_CHARS. */
  error?: string;
}

const MAX_ERROR_CHARS = 500;

/**
 * status/body/error mirror k6's `Response.status` / `Response.body` /
 * `Response.error` exactly, but are typed loosely here so this module never
 * needs to import k6's types.
 *
 * Decision, asserted by test so it cannot silently change: when BOTH a
 * non-empty body and a non-empty error are present, the body wins. A real
 * non-2xx HTTP response's body is the target's own diagnostic, which is
 * more specific than k6's generic non-HTTP error string; `error` is used
 * only when there is no body to read from — which is exactly the
 * status:0/body:null case this helper exists to fix.
 */
export function classifyHttpResponse(
  status: number,
  body: unknown,
  error: string,
): HttpClassification {
  if (status >= 200 && status < 300) {
    return { ok: true };
  }
  const bodyText = String(body ?? '');
  const text = bodyText.length > 0 ? bodyText : error;
  return { ok: false, error: text.slice(0, MAX_ERROR_CHARS) };
}
