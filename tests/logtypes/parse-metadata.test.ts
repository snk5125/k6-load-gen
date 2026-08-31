import { describe, it, expect } from 'vitest';
import { LOG_TYPES } from '../../src/logtypes/registry.ts';

describe('parse metadata', () => {
  it('every field of every type declares parse explicitly', () => {
    // The default exists for safety, not as a place to leave decisions unmade.
    for (const def of Object.values(LOG_TYPES)) {
      for (const f of def.fields) {
        expect(f.parse, `${def.name}.${f.name} has no parse`).toBeDefined();
      }
    }
  });

  it('types the numeric auditd fields as int and leaves arch a string', () => {
    const byName = Object.fromEntries(LOG_TYPES.auditd.fields.map((f) => [f.name, f]));
    expect(byName.uid.parse!.type).toBe('int');
    expect(byName.exit.parse!.type).toBe('int');
    // arch is a hex token (c000003e), not a number.
    expect(byName.arch.parse!.type).toBe('string');
  });

  it('types address fields as ip', () => {
    const nginx = Object.fromEntries(LOG_TYPES['nginx-access'].fields.map((f) => [f.name, f]));
    expect(nginx.remote_addr.parse!.type).toBe('ip');
    const ct = Object.fromEntries(LOG_TYPES.cloudtrail.fields.map((f) => [f.name, f]));
    expect(ct.sourceIPAddress.parse!.type).toBe('ip');
  });

  it('indexes a subset, not everything — indexing everything is the most expensive answer', () => {
    for (const def of Object.values(LOG_TYPES)) {
      const indexed = def.fields.filter((f) => f.parse?.index).length;
      expect(indexed, `${def.name} indexes nothing`).toBeGreaterThan(0);
      expect(indexed, `${def.name} indexes every field`).toBeLessThan(def.fields.length);
    }
  });

  it('declares an int type only where the field can actually generate digits', () => {
    // A field whose FieldSpec produces `${name}-${i}` cannot be an int, and a
    // renderer that coerces it would drop every value. This is the same class
    // as the body_bytes_sent defect from the previous sub-project.
    for (const def of Object.values(LOG_TYPES)) {
      for (const f of def.fields) {
        if (f.parse?.type !== 'int') continue;
        const s = f.spec as { cardinality?: unknown; prefix?: string; values?: string[] };
        const digitsOnly =
          (typeof s.cardinality === 'number' && s.prefix === '') ||
          (Array.isArray(s.values) && s.values.every((v) => /^\d+$/.test(v)));
        expect(digitsOnly, `${def.name}.${f.name} is typed int but cannot generate digits`).toBe(true);
      }
    }
  });
});
