// Pure syslog message formatting. Imports NOTHING from k6 — this is the
// testable half of the transport, and the vitest suite depends on that
// (vitest cannot resolve `k6/x/tcp` or any other k6 built-in module).
import type { LogEvent } from '../payload/types.ts';

const FACILITY_USER = 1;

// k6 severity name -> syslog severity number (RFC 5424 §6.2.1 table),
// defaulting to 6 (Informational) for anything unrecognized.
const SEVERITY_MAP: Record<string, number> = {
  ERROR: 3,
  WARN: 4,
  INFO: 6,
  DEBUG: 7,
};

function severityNumber(severity: string): number {
  return SEVERITY_MAP[severity] ?? 6;
}

export function priority(facility: number, severity: number): number {
  return facility * 8 + severity;
}

// Structured-data PARAM-VALUE (RFC 5424 §6.3.3) requires '"', '\' and ']' to
// be backslash-escaped; nothing else is unsafe there.
function escapeSdValue(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/]/g, '\\]');
}

// A syslog message is one line on the wire; framing (frame(), below) is the
// only thing allowed to introduce a delimiter. A newline embedded in a free
// text field — body is arbitrary generated content, run_id comes from the
// harness — would otherwise split one event into two for the receiver, so
// every free-text field that lands in the message is passed through this
// rather than trusted. escapeSdValue (above) is a DIFFERENT concern: it
// makes a value safe inside an RFC 5424 SD-VALUE's quoting, but does not
// touch newlines, and RFC 3164 has no SD-VALUE quoting at all — so this
// still has to run everywhere a free-text field is interpolated.
//
// app_name does NOT use this — see sanitizeAppName below. A newline turns
// into a harmless space in free text, but APP-NAME is a single positional
// token: a space (or any other stray character) inside it shifts every
// field after it out of phase for the receiver, which oneLine()'s
// space-substitution would not fix.
function oneLine(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

// RFC 5424's APP-NAME is a single PRINTUSASCII token (no spaces, no control
// characters) with NILVALUE "-" when absent; RFC 3164's TAG is positional
// the same way. Unlike body/run_id (free text where a stray delimiter is a
// framing problem), a malformed APP-NAME corrupts the header's own field
// boundaries — a space in it makes HOSTNAME/APP-NAME/PROCID/MSGID parse one
// position out of phase, and an empty string leaves an invalid empty field
// where the grammar requires NILVALUE. Disallowed characters are replaced
// (not stripped) so the token's presence is still visible — this is a
// one-for-one, length-preserving substitution, so the only way the result
// is empty is if the input already was; that case falls back to NILVALUE.
function sanitizeAppName(name: string): string {
  const cleaned = name.replace(/[^\x21-\x7E]/g, '_');
  return cleaned.length > 0 ? cleaned : '-';
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatRfc5424(e: LogEvent, appName: string): string {
  const pri = priority(FACILITY_USER, severityNumber(e.severity));
  const timestamp = new Date(e.ts_ms).toISOString();
  const sd =
    `[meta run_id="${escapeSdValue(oneLine(e.run_id))}" ` +
    `gen_index="${escapeSdValue(String(e.gen_index))}" ` +
    `seq="${escapeSdValue(String(e.seq))}"]`;
  const body = oneLine(e.body);
  // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
  return `<${pri}>1 ${timestamp} - ${sanitizeAppName(appName)} - - ${sd} ${body}`;
}

// Legacy BSD syslog (RFC 3164 §4.1.1): "Mmm dd hh:mm:ss" timestamp, no
// version field, no structured data — identity fields fold into the body
// since 3164 has nowhere else to carry them.
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function formatRfc3164(e: LogEvent, appName: string): string {
  const pri = priority(FACILITY_USER, severityNumber(e.severity));
  const d = new Date(e.ts_ms);
  // RFC 3164 pads single-digit day with a space, not a zero.
  const day = d.getUTCDate() < 10 ? ` ${d.getUTCDate()}` : String(d.getUTCDate());
  const timestamp =
    `${MONTHS[d.getUTCMonth()]} ${day} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const body = oneLine(e.body);
  const meta = `run_id="${oneLine(e.run_id)}" gen_index="${e.gen_index}" seq="${e.seq}"`;
  return `<${pri}>${timestamp} - ${sanitizeAppName(appName)}: ${meta} ${body}`;
}

// UTF-8 byte length of a string without Buffer (not available in k6).
// encodeURIComponent escapes every byte outside the ASCII printable range as
// %XX against the string's UTF-8 encoding, so each escape triple stands for
// one extra byte beyond the single JS char it replaces.
function utf8ByteLength(s: string): number {
  const escaped = encodeURIComponent(s);
  let bytes = 0;
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '%') {
      bytes += 1;
      i += 2; // skip the two hex digits of this escape
    } else {
      bytes += 1;
    }
  }
  return bytes;
}

export function frame(msg: string, framing: 'octet-counted' | 'lf'): string {
  if (framing === 'lf') return `${msg}\n`;
  return `${utf8ByteLength(msg)} ${msg}`;
}
