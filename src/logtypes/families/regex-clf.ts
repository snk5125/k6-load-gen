import type { FamilyModule, LogTypeDef, ParseArtifact } from '../types.ts';

/**
 * Combined Log Format (nginx/Apache access log). This is the only
 * regex/grok-parsed family — a regex parse typically costs 10-50x a JSON
 * decode, so this pattern is the deliverable, not the serializer around it.
 *
 * Defined once, here, and returned verbatim by parseArtifact() below: the
 * pattern's quoted fields are `[^"]*`, so serialize() must strip `"` from
 * any value it places inside quotes (see stripQuotedValue) — that stripping
 * rule and this pattern are one decision in two places, which is exactly
 * what a family module exists to keep from drifting apart.
 */
const PATTERN =
  '^(?<remote_addr>\\S+) \\S+ (?<remote_user>\\S+) ' +
  '\\[(?<time_local>[^\\]]+)\\] ' +
  '"(?<request_method>\\S+) (?<request_uri>[^"]*) (?<server_protocol>[^"]*)" ' +
  '(?<status>\\d{3}) (?<body_bytes_sent>\\d+) ' +
  '"(?<http_referer>[^"]*)" "(?<http_user_agent>[^"]*)"$';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** strftime `%d/%b/%Y:%H:%M:%S %z` — timestamps are always UTC, so the zone is fixed. */
function formatClfTime(ts_ms: number): string {
  const d = new Date(ts_ms);
  const day = pad2(d.getUTCDate());
  const month = MONTHS[d.getUTCMonth()];
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${day}/${month}/${d.getUTCFullYear()}:${hh}:${mm}:${ss} +0000`;
}

/** A raw newline anywhere would split one event into two on the receiver. */
function stripNewlines(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

/**
 * Values placed inside a quoted field must not contain `"` — PATTERN's
 * quoted groups are `[^"]*`, so a literal quote would close the field early
 * and shift every capture after it (the classic CLF injection bug).
 */
function stripQuotedValue(value: string): string {
  return stripNewlines(value).replace(/"/g, ' ');
}

export const regexClf: FamilyModule = {
  serialize(_def: LogTypeDef, values: Record<string, string>, ts_ms: number, _seq: number): string {
    const remoteAddr = stripNewlines(values.remote_addr ?? '');
    const remoteUser = stripNewlines(values.remote_user ?? '-');
    const method = stripQuotedValue(values.request_method ?? '');
    const uri = stripQuotedValue(values.request_uri ?? '');
    const protocol = stripQuotedValue(values.server_protocol ?? 'HTTP/1.1');
    const status = stripNewlines(values.status ?? '');
    const bodyBytesSent = stripNewlines(values.body_bytes_sent ?? '');
    const referer = stripQuotedValue(values.http_referer ?? '-');
    const userAgent = stripQuotedValue(values.http_user_agent ?? '-');

    return (
      `${remoteAddr} - ${remoteUser} [${formatClfTime(ts_ms)}] ` +
      `"${method} ${uri} ${protocol}" ${status} ${bodyBytesSent} ` +
      `"${referer}" "${userAgent}"`
    );
  },

  parseArtifact(_def: LogTypeDef): ParseArtifact {
    return { kind: 'regex', pattern: PATTERN };
  },
};
