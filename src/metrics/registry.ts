import { Counter, Rate, Trend } from 'k6/metrics';

export const eventsAttempted = new Counter('events_attempted');
export const eventsSent = new Counter('events_sent');
/**
 * Events a target ACCEPTED THE REQUEST FOR and then refused.
 *
 * Only OTLP can produce these: its `ExportLogsServiceResponse` may carry a
 * `partial_success` block rejecting part of a batch on a 200/StatusOK (see
 * src/transports/otlp-partial.ts). Before this counter existed those records
 * were counted into `events_sent`, so a collector dropping half of every
 * batch published a run with a 0% failure rate. `events_sent` now counts
 * only what was accepted; the difference lands here.
 *
 * Invariant, per batch: accepted + rejected === batch size. Run-wide,
 * events_sent + events_rejected <= events_attempted (a batch that failed
 * outright contributes to neither).
 */
export const eventsRejected = new Counter('events_rejected');
export const sendFailures = new Rate('send_failures');
/**
 * Absolute count of failed sends, run-wide.
 *
 * `send_failures` is a Rate because thresholds need ratios; this Counter carries
 * the true total (spec §11: rate-limited error logging must still put the real
 * number in the summary). It must be a k6 metric rather than a module-scope
 * counter because k6 runs `handleSummary` in a fresh runtime — module state from
 * the VU runtimes is not visible there, but metrics are.
 */
export const sendErrors = new Counter('send_errors');
/** Transport-agnostic batch latency: one comparable series across gRPC, HTTP, syslog. */
export const sendDuration = new Trend('send_duration', true);
/** Only incremented when a transport can actually observe its wire size. */
export const wireBytes = new Counter('wire_bytes');
