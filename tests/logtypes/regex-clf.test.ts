import { describe, it, expect } from 'vitest';
import { regexClf } from '../../src/logtypes/families/regex-clf.ts';
import { nginxAccess } from '../../src/logtypes/definitions/nginx-access.ts';
import { parseWithArtifact } from './parse-with-artifact.ts';

const vals = {
  remote_addr: '10.0.4.31', request_method: 'GET', request_uri: '/api/v2/items?id=8831',
  status: '200', body_bytes_sent: '4213', http_user_agent: 'curl/8.4.0',
};

describe('regex-clf', () => {
  it('round-trips: the pattern extracts every field serialize wrote', () => {
    // The single most important test in this task. If it fails, the emitter and
    // the parser config Sub-project B generates have diverged.
    const line = regexClf.serialize(nginxAccess, vals, Date.parse('2026-08-30T18:22:41Z'), 1);
    const a = regexClf.parseArtifact(nginxAccess) as { kind: 'regex'; pattern: string };
    const m = new RegExp(a.pattern).exec(line);
    expect(m).not.toBeNull();
    expect(m!.groups!.remote_addr).toBe('10.0.4.31');
    expect(m!.groups!.status).toBe('200');
    expect(m!.groups!.body_bytes_sent).toBe('4213');
    expect(m!.groups!.http_user_agent).toBe('curl/8.4.0');
  });

  it('formats the timestamp in strftime %d/%b/%Y:%H:%M:%S %z form', () => {
    const line = regexClf.serialize(nginxAccess, vals, Date.parse('2026-08-30T18:22:41Z'), 1);
    expect(line).toContain('[30/Aug/2026:18:22:41 +0000]');
  });

  it('quotes the request line and the user agent', () => {
    const line = regexClf.serialize(nginxAccess, vals, 1000, 1);
    expect(line).toContain('"GET /api/v2/items?id=8831 HTTP/1.1"');
    expect(line).toContain('"curl/8.4.0"');
  });

  it('still round-trips when a value contains a quote', () => {
    // A raw quote inside the UA would terminate the quoted field early and
    // shift every later capture — the classic CLF injection bug.
    const line = regexClf.serialize(nginxAccess, { ...vals, http_user_agent: 'a"b' }, 1000, 1);
    const a = regexClf.parseArtifact(nginxAccess) as { kind: 'regex'; pattern: string };
    expect(new RegExp(a.pattern).exec(line)).not.toBeNull();
  });

  it('never emits a newline', () => {
    const line = regexClf.serialize(nginxAccess, { ...vals, request_uri: '/a\nb' }, 1000, 1);
    expect(line).not.toMatch(/\n/);
  });
});

describe('regex-clf round trip via parseWithArtifact', () => {
  // The tests above hand-match the pattern. This is the genuine round trip:
  // parseWithArtifact is driven entirely by the artifact, proving
  // parseArtifact's pattern is actually sufficient to recover every field
  // serialize wrote — including the defaults for fields the caller omitted.
  it('recovers every field, including defaulted ones, from a plain line', () => {
    const body = regexClf.serialize(nginxAccess, vals, Date.parse('2026-08-30T18:22:41Z'), 1);
    const artifact = regexClf.parseArtifact(nginxAccess);
    expect(parseWithArtifact(artifact, body)).toMatchObject({
      remote_addr: '10.0.4.31',
      remote_user: '-',
      request_method: 'GET',
      request_uri: '/api/v2/items?id=8831',
      server_protocol: 'HTTP/1.1',
      status: '200',
      body_bytes_sent: '4213',
      http_referer: '-',
      http_user_agent: 'curl/8.4.0',
    });
  });

  it('recovers a user agent whose embedded quote was stripped to a space', () => {
    const body = regexClf.serialize(nginxAccess, { ...vals, http_user_agent: 'a"b' }, 1000, 1);
    const artifact = regexClf.parseArtifact(nginxAccess);
    const parsed = parseWithArtifact(artifact, body);
    expect(parsed.http_user_agent).toBe('a b');
  });
});
