import { describe, it, expect } from 'vitest';
import { kvAudit } from '../../src/logtypes/families/kv-audit.ts';
import { auditd } from '../../src/logtypes/definitions/auditd.ts';
import { parseWithArtifact } from './parse-with-artifact.ts';

const vals = { arch: 'c000003e', syscall: '59', success: 'yes', uid: '1042', exe: '/usr/bin/host-0731' };

describe('kv-audit serialize', () => {
  it('opens with the constant type and the audit prefix', () => {
    const line = kvAudit.serialize(auditd, vals, 1788130943351, 24287);
    expect(line).toMatch(/^type=SYSCALL msg=audit\(1788130943\.351:24287\): /);
  });

  it('renders the epoch as seconds with exactly three decimal places', () => {
    // 1788130943000 must be ...943.000, not ...943.0 — a receiver's prefix regex
    // is written against a fixed-width fraction.
    const line = kvAudit.serialize(auditd, vals, 1788130943000, 1);
    expect(line).toContain('msg=audit(1788130943.000:1):');
  });

  it('uses seq as the audit serial', () => {
    expect(kvAudit.serialize(auditd, vals, 1000, 99)).toContain(':99):');
  });

  it('emits every value as key=value after the prefix', () => {
    const line = kvAudit.serialize(auditd, vals, 1000, 1);
    expect(line).toContain('arch=c000003e');
    expect(line).toContain('uid=1042');
  });

  it('quotes a value containing a space, and escapes an embedded quote', () => {
    const line = kvAudit.serialize(auditd, { ...vals, exe: 'a b"c' }, 1000, 1);
    expect(line).toContain('exe="a b\\"c"');
  });

  it('does not quote a value that needs no quoting', () => {
    expect(kvAudit.serialize(auditd, vals, 1000, 1)).toContain('uid=1042');
    expect(kvAudit.serialize(auditd, vals, 1000, 1)).not.toContain('uid="1042"');
  });

  it('never emits a newline, even when a value contains one', () => {
    const line = kvAudit.serialize(auditd, { ...vals, exe: 'a\nb' }, 1000, 1);
    expect(line).not.toMatch(/\n/);
  });
});

describe('kv-audit parseArtifact', () => {
  it('describes the prefix as a regex and the body as kv', () => {
    const a = kvAudit.parseArtifact(auditd) as { kind: 'kv'; separator: string };
    expect(a.kind).toBe('kv');
    expect(a.separator).toBe(' ');
  });

  it('has a prefix pattern that matches what serialize emits', () => {
    // This is the whole point of the family owning both halves.
    const line = kvAudit.serialize(auditd, vals, 1788130943351, 24287);
    const a = kvAudit.parseArtifact(auditd) as { kind: 'kv'; prefixPattern: string };
    const m = new RegExp(a.prefixPattern).exec(line);
    expect(m).not.toBeNull();
    expect(m!.groups!.epoch).toBe('1788130943.351');
    expect(m!.groups!.serial).toBe('24287');
  });
});

describe('kv-audit round trip via parseWithArtifact', () => {
  // The brief's tests above pin the wire format by hand-matching the prefix
  // regex. This is the genuine round trip: parseWithArtifact is driven
  // entirely by the artifact, so it proves parseArtifact's description is
  // actually sufficient to recover what serialize wrote — not just that the
  // prefix lines up.
  const full = {
    arch: 'c000003e', syscall: '59', success: 'yes', exit: '0',
    uid: '1042', gid: '1042', exe: '/usr/bin/host-0731', key: 'exec',
  };

  it('recovers every field, plus the prefix groups, from a plain line', () => {
    const body = kvAudit.serialize(auditd, full, 1788130943351, 24287);
    const artifact = kvAudit.parseArtifact(auditd);
    expect(parseWithArtifact(artifact, body)).toMatchObject({
      type: 'SYSCALL',
      epoch: '1788130943.351',
      serial: '24287',
      ...full,
    });
  });

  it('recovers a quoted value containing an escaped quote', () => {
    const body = kvAudit.serialize(auditd, { ...full, exe: 'a b"c' }, 1000, 1);
    const artifact = kvAudit.parseArtifact(auditd);
    const parsed = parseWithArtifact(artifact, body);
    expect(parsed.exe).toBe('a b"c');
  });
});
