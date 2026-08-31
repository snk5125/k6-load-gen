// Pure request-params builder for hec.ts. Imports NOTHING from k6 — this is
// the testable half of the transport, same pattern as otlp-payload.ts and
// syslog-format.ts: the k6-coupled adapter (hec.ts) stays thin, the logic
// that can be exercised without a k6 runtime lives here instead.

export interface HecParams {
  headers: Record<string, string>;
  compression?: 'gzip';
}

// The `compression` key must be OMITTED, not set to `undefined`, when gzip
// is off. `{ compression: undefined }` reads as "no compression" in
// idiomatic JS, but k6's HTTP client does not treat an explicitly-undefined
// value the same as an absent key: it read the key's mere presence as
// "compression requested" and rejected every request with `unknown
// compression algorithm undefined` — a 100% send-failure rate for the
// shipped hec profile, whose default is `gzip: false`. Caught only by
// running this transport against a real listener (Task 9); nothing that
// calls k6/http is in the unit suite, which is exactly why this narrow
// piece of otherwise-pure logic is pulled out here where it CAN be.
//
// The bug this guards against is a broken-vs-fixed distinction that lives
// entirely in whether the key is PRESENT, not in what it's set to — so a
// test must assert with `in` / Object.keys, not `toBeUndefined()`, or it
// would pass against both the broken and fixed builders.
export function buildHecParams(headers: Record<string, string>, gzip: boolean): HecParams {
  const params: HecParams = { headers };
  if (gzip) params.compression = 'gzip';
  return params;
}
