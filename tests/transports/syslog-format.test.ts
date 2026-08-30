import { describe, it, expect } from 'vitest';
import { formatRfc5424, formatRfc3164, frame, priority } from '../../src/transports/syslog-format.ts';

const ev = (over: Partial<any> = {}) => ({
  ts_ms: Date.parse('2026-08-30T12:34:56.789Z'),
  severity: 'WARN', body: '{"a":1}', fields: {},
  run_id: 'r1', gen_index: 0, seq: 7, ...over,
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

  it('escapes a quote in a structured-data value rather than producing invalid output', () => {
    const s = formatRfc5424(ev({ run_id: 'a"b' }), 'k6');
    expect(s).toContain('a\\"b');
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

  it('lf appends a newline', () => {
    expect(frame('hello', 'lf')).toBe('hello\n');
  });
});
