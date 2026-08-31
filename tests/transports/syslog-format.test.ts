import { describe, it, expect } from 'vitest';
import { formatRfc5424, formatRfc3164, frame, priority } from '../../src/transports/syslog-format.ts';

const ev = (over: Partial<any> = {}) => ({
  ts_ms: Date.parse('2026-08-30T12:34:56.789Z'),
  severity: 'WARN', body: '{"a":1}', fields: {},
  run_id: 'r1', gen_index: 0, type: 'auditd', seq: 7, ...over,
});

describe('priority', () => {
  it('is facility*8 + severity', () => {
    // user-level facility (1) + warning (4) = 12
    expect(priority(1, 4)).toBe(12);
  });
});

describe('formatRfc5424', () => {
  it('emits the documented field order with version 1', () => {
    const s = formatRfc5424(ev(), 'k6');
    expect(s).toMatch(/^<\d+>1 /);
    expect(s).toContain('2026-08-30T12:34:56.789Z');
    expect(s).toContain('k6');
    expect(s).toContain('{"a":1}');
  });

  it('carries run_id, gen_index and seq as structured data', () => {
    // The correctness layer matches on these; they must survive the transport.
    const s = formatRfc5424(ev(), 'k6');
    expect(s).toMatch(/run_id="r1"/);
    expect(s).toMatch(/gen_index="0"/);
    expect(s).toMatch(/seq="7"/);
  });

  it('maps severity to a numeric priority', () => {
    const warn = formatRfc5424(ev({ severity: 'WARN' }), 'k6');
    const err = formatRfc5424(ev({ severity: 'ERROR' }), 'k6');
    expect(warn.slice(0, warn.indexOf('>'))).not.toBe(err.slice(0, err.indexOf('>')));
  });

  it('pins the actual PRI value, not just that it differs by severity', () => {
    // The above test only proves warn's PRI differs from err's — it would
    // still pass if the severity map were wrong in some OTHER way (e.g. a
    // facility mismatch, or WARN/ERROR both mapped wrong but differently).
    // user-level facility (1): WARN=4 -> 1*8+4=12, ERROR=3 -> 1*8+3=11.
    expect(formatRfc5424(ev({ severity: 'WARN' }), 'k6')).toMatch(/^<12>1 /);
    expect(formatRfc5424(ev({ severity: 'ERROR' }), 'k6')).toMatch(/^<11>1 /);
  });

  it('escapes a quote in a structured-data value rather than producing invalid output', () => {
    const s = formatRfc5424(ev({ run_id: 'a"b' }), 'k6');
    expect(s).toContain('a\\"b');
  });

  it('escapes a backslash in a structured-data value', () => {
    const s = formatRfc5424(ev({ run_id: 'a\\b' }), 'k6');
    expect(s).toContain('a\\\\b');
  });

  it('escapes a closing bracket in a structured-data value', () => {
    // An unescaped ']' would look like the end of the SD-ELEMENT to a parser.
    const s = formatRfc5424(ev({ run_id: 'a]b' }), 'k6');
    expect(s).toContain('a\\]b');
  });

  it('never emits a newline, which would split one message into two', () => {
    // Framing is the only thing allowed to add a delimiter.
    expect(formatRfc5424(ev({ body: 'line1\nline2' }), 'k6')).not.toMatch(/\n/);
  });

  it('never emits a newline from a run_id, not just from the body', () => {
    // run_id lands in structured data, not the body — escapeSdValue does not
    // strip newlines (RFC 5424 does not require it to), so this has to be
    // handled independently of the body's newline stripping.
    expect(formatRfc5424(ev({ run_id: 'r1\nx' }), 'k6')).not.toMatch(/\n/);
  });

  it('replaces a space in app_name so field boundaries are not shifted', () => {
    // APP-NAME is a single positional token — a raw space would make every
    // field after it (PROCID, MSGID, the structured data) parse one
    // position out of phase for the receiver.
    const s = formatRfc5424(ev(), 'my app');
    expect(s).toContain(' my_app - - [meta');
    expect(s).not.toMatch(/my app/);
  });

  it('falls back to NILVALUE "-" for app_name when it sanitizes to empty', () => {
    // An empty APP-NAME field is invalid; RFC 5424 requires NILVALUE "-".
    const s = formatRfc5424(ev(), '');
    expect(s).toMatch(/^<\d+>1 \S+ - - - - \[meta/);
  });
});

describe('formatRfc3164', () => {
  it('emits the legacy format without a version field', () => {
    const s = formatRfc3164(ev(), 'k6');
    expect(s).toMatch(/^<\d+>[A-Z][a-z]{2} /);
    expect(s).not.toMatch(/^<\d+>1 /);
  });

  it('never emits a newline', () => {
    expect(formatRfc3164(ev({ body: 'a\nb' }), 'k6')).not.toMatch(/\n/);
  });

  it('never emits a newline from a run_id, either', () => {
    // RFC 3164 has no structured-data quoting at all, so run_id here is
    // plain concatenation — nothing else would strip an embedded newline.
    expect(formatRfc3164(ev({ run_id: 'r1\nx' }), 'k6')).not.toMatch(/\n/);
  });

  it('replaces a space in app_name here too — TAG is positional in 3164 as well', () => {
    const s = formatRfc3164(ev(), 'my app');
    expect(s).toContain('my_app:');
    expect(s).not.toMatch(/my app/);
  });
});

describe('frame', () => {
  it('octet-counted prefixes the byte length and a space', () => {
    expect(frame('hello', 'octet-counted')).toBe('5 hello');
  });

  it('counts BYTES, not characters', () => {
    // A multi-byte character makes length-in-chars wrong, and a receiver that
    // trusts the count would mis-frame every subsequent message on the stream.
    expect(frame('é', 'octet-counted')).toBe('2 é');
  });

  it('counts a 4-byte astral character (surrogate pair) correctly', () => {
    // U+1F600 is a surrogate PAIR in a JS string (.length === 2) but a
    // single 4-byte UTF-8 sequence on the wire — a bug that only handled
    // BMP characters would get this one wrong even after passing the 'é'
    // case above.
    expect(frame('😀', 'octet-counted')).toBe('4 😀');
  });

  it('lf appends a newline', () => {
    expect(frame('hello', 'lf')).toBe('hello\n');
  });

  it('the octet count matches the real UTF-8 byte length end-to-end, for a formatted message', () => {
    // Ground truth from Node's own TextEncoder (available under vitest,
    // independent of this module's own utf8ByteLength implementation) —
    // this is the check that would actually catch a wrong byte-counting
    // algorithm, as opposed to one that merely handles the two hand-picked
    // cases above.
    const msg = formatRfc5424(ev({ body: 'héllo wörld 😀' }), 'k6');
    const framed = frame(msg, 'octet-counted');
    const firstSpace = framed.indexOf(' ');
    const count = Number(framed.slice(0, firstSpace));
    const rest = framed.slice(firstSpace + 1);
    expect(rest).toBe(msg);
    expect(count).toBe(new TextEncoder().encode(msg).length);
  });
});
