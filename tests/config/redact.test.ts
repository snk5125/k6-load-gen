import { describe, it, expect } from 'vitest';
import { SAFE_OPTION_KEYS, redactProfile } from '../../src/config/redact.ts';
import type { Profile } from '../../src/config/schema.ts';

const base = (options: Record<string, unknown>): Profile =>
  ({
    name: 'p',
    target: { transport: 'hec', endpoint: 'https://splunk:8088', options },
    payload: { template: 'json-app', batch_size: 10, fields: { host: { cardinality: 3 } } },
    anchor: { mode: 'absolute', base_eps: 100 },
    scenario: 'smoke',
  }) as Profile;

describe('redactProfile', () => {
  it('redacts an option key that is not on the safe list', () => {
    const r = redactProfile(base({ token: 'Splunk-SECRET-abc123' }));
    expect(r.target.options!.token).toBe('[redacted]');
    expect(JSON.stringify(r)).not.toContain('Splunk-SECRET-abc123');
  });

  it('redacts every unknown key, not just ones that look secret', () => {
    // Fails safe: a NEW option added without updating the safe list is
    // redacted (visible, recoverable) rather than leaked (silent, permanent).
    const r = redactProfile(base({ password: 'hunter2', some_future_option: 'x' }));
    expect(r.target.options!.password).toBe('[redacted]');
    expect(r.target.options!.some_future_option).toBe('[redacted]');
  });

  it('redacts headers, which routinely carry Authorization', () => {
    const r = redactProfile(base({ headers: { Authorization: 'Bearer sk-live-123' } }));
    expect(r.target.options!.headers).toBe('[redacted]');
    expect(JSON.stringify(r)).not.toContain('sk-live-123');
  });

  it('keeps safe behavioural options, which are needed to reproduce a run', () => {
    const r = redactProfile(base({ plaintext: true, timeout: '10s', gzip: false, index: 'main' }));
    expect(r.target.options!.plaintext).toBe(true);
    expect(r.target.options!.timeout).toBe('10s');
    expect(r.target.options!.gzip).toBe(false);
    expect(r.target.options!.index).toBe('main');
  });

  it('keeps token_env, which names a variable rather than holding a value', () => {
    const r = redactProfile(base({ token_env: 'HEC_TOKEN' }));
    expect(r.target.options!.token_env).toBe('HEC_TOKEN');
  });

  it('leaves a profile with no options untouched', () => {
    const p = base({});
    delete p.target.options;
    expect(() => redactProfile(p)).not.toThrow();
    expect(redactProfile(p).target.options).toBeUndefined();
  });

  it('does not mutate the profile it is given', () => {
    const p = base({ token: 'Splunk-SECRET-abc123' });
    redactProfile(p);
    expect(p.target.options!.token).toBe('Splunk-SECRET-abc123');
  });

  it('preserves every non-target section verbatim', () => {
    const p = base({ token: 'x' });
    const r = redactProfile(p);
    expect(r.name).toBe(p.name);
    expect(r.payload).toEqual(p.payload);
    expect(r.anchor).toEqual(p.anchor);
    expect(r.scenario).toBe(p.scenario);
    expect(r.target.endpoint).toBe(p.target.endpoint);
    expect(r.target.transport).toBe(p.target.transport);
  });

  it('exports a safe list covering the options the schema documents', () => {
    for (const k of ['plaintext', 'timeout', 'path', 'encoding', 'index', 'sourcetype', 'gzip', 'rfc', 'framing', 'app_name', 'count_bytes', 'token_env', 'resource_attributes']) {
      expect(SAFE_OPTION_KEYS).toContain(k);
    }
    // The ones that can carry credentials must NOT be on it.
    expect(SAFE_OPTION_KEYS).not.toContain('headers');
    expect(SAFE_OPTION_KEYS).not.toContain('token');
    // `tls` is a CONTAINER and was removed from the allowlist — see below.
    expect(SAFE_OPTION_KEYS).not.toContain('tls');
  });

  it('redacts a nested credential under `tls`, which passed through while it was allowlisted', () => {
    // The allowlist is one level deep: an allowlisted value is copied whole,
    // by reference, so everything nested inside it is published verbatim.
    // `tls` was on the list AND is a container — Plan 2's syslog `tls` block
    // is exactly where a client key or passphrase would live — so a profile
    // like this one would have shipped the private key to S3 in cleartext
    // inside `resolved_config`. It is now off the list and redacted whole.
    const r = redactProfile(
      base({
        tls: {
          ca_file: '/etc/ssl/ca.pem',
          client_key: '-----BEGIN PRIVATE KEY-----NESTED-TLS-SECRET-----',
          passphrase: 'hunter2',
        },
      }),
    );
    expect(r.target.options!.tls).toBe('[redacted]');
    expect(JSON.stringify(r)).not.toContain('NESTED-TLS-SECRET');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('keeps resource_attributes, a container kept on purpose', () => {
    // The deliberate counterpart to the `tls` case: operator-authored
    // descriptive metadata that already travels inside the events, so
    // redacting it would cost reproducibility for no security gain.
    const attrs = { 'service.name': 'k6-load-gen', 'deployment.environment': 'test' };
    const r = redactProfile(base({ resource_attributes: attrs }));
    expect(r.target.options!.resource_attributes).toEqual(attrs);
  });
});
