import { describe, it, expect } from 'vitest';
import { SAFE_OPTION_KEYS, redactProfile, REDACTED } from '../../src/config/redact.ts';
import type { Profile } from '../../src/config/schema.ts';

const base = (options: Record<string, unknown>): Profile =>
  ({
    name: 'p',
    target: { transport: 'hec', endpoint: 'https://splunk:8088', options },
    payload: { template: 'json-app', batch_size: 10, fields: { host: { cardinality: 3 } } },
    anchor: { mode: 'absolute', base_eps: 100 },
    scenario: 'smoke',
  }) as Profile;

// Like `base`, but lets a test supply its own `target` (transport, endpoint,
// options) while keeping the other required sections fixed.
const profile = (overrides: { target: Profile['target'] }): Profile =>
  ({
    name: 'p',
    payload: { template: 'json-app', batch_size: 10, fields: { host: { cardinality: 3 } } },
    anchor: { mode: 'absolute', base_eps: 100 },
    scenario: 'smoke',
    ...overrides,
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
    for (const k of ['plaintext', 'timeout', 'path', 'encoding', 'index', 'sourcetype', 'gzip', 'rfc', 'framing', 'tls', 'app_name', 'count_bytes', 'token_env', 'resource_attributes']) {
      expect(SAFE_OPTION_KEYS).toContain(k);
    }
    // The ones that can carry credentials must NOT be on it.
    expect(SAFE_OPTION_KEYS).not.toContain('headers');
    expect(SAFE_OPTION_KEYS).not.toContain('token');
  });

  it('redactProfile trusts the schema, not the value, to keep tls safe', () => {
    // redactProfile only looks at the key name — it does not re-check that
    // `tls` is actually a boolean. What makes allowlisting it safe is that
    // src/config/schema.ts rejects a non-boolean `tls` for syslog before a
    // profile ever reaches redactProfile in the real pipeline (src/main.ts
    // calls validateProfile first). This test calls redactProfile directly,
    // bypassing that guarantee, to document the boundary explicitly: if
    // schema.ts's `tls` validator were ever loosened back to accepting an
    // object, this is the function that would publish it unredacted.
    const r = redactProfile(
      base({
        tls: {
          ca_file: '/etc/ssl/ca.pem',
          client_key: '-----BEGIN PRIVATE KEY-----NESTED-TLS-SECRET-----',
        },
      }),
    );
    expect(r.target.options!.tls).toEqual({
      ca_file: '/etc/ssl/ca.pem',
      client_key: '-----BEGIN PRIVATE KEY-----NESTED-TLS-SECRET-----',
    });
  });

  it('keeps resource_attributes, a container kept on purpose', () => {
    // The deliberate counterpart to the `tls` case: operator-authored
    // descriptive metadata that already travels inside the events, so
    // redacting it would cost reproducibility for no security gain.
    const attrs = { 'service.name': 'k6-load-gen', 'deployment.environment': 'test' };
    const r = redactProfile(base({ resource_attributes: attrs }));
    expect(r.target.options!.resource_attributes).toEqual(attrs);
  });

  it('publishes syslog tls, which the schema constrains to a boolean', () => {
    const p = profile({ target: { transport: 'syslog', endpoint: 'h:601', options: { tls: true } } });
    expect(redactProfile(p).target.options).toEqual({ tls: true });
  });

  it('redacts otlp-http headers, which routinely carry Authorization', () => {
    const p = profile({
      target: { transport: 'otlp-http', endpoint: 'http://h:4318',
                options: { path: '/v1/logs', headers: { Authorization: 'Bearer sk-real-token' } } },
    });
    const out = redactProfile(p).target.options!;
    expect(out.path).toBe('/v1/logs');
    expect(out.headers).toBe(REDACTED);
    // The value must not survive anywhere in the serialised artifact.
    expect(JSON.stringify(redactProfile(p))).not.toContain('sk-real-token');
  });

  it('redacts an unknown option added by a future transport', () => {
    // Fail-safe direction: new key, not on the list, redacted rather than leaked.
    const p = profile({ target: { transport: 'hec', endpoint: 'http://h:8088', options: { future_secret: 'x' } } });
    expect(redactProfile(p).target.options!.future_secret).toBe(REDACTED);
  });
});
