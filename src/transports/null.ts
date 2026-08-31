import type { TransportFactory } from './types.ts';

/**
 * Discards everything. Not a mock — this is how `calibrate` measures what one
 * generator can produce with no network in the path.
 */
export const createNullTransport: TransportFactory = (cfg) => {
  const countBytes = (cfg.options?.count_bytes as boolean | undefined) !== false;

  return {
    name: 'null',
    async connect() {
      /* nothing to connect */
    },
    async send(events) {
      let bytes = 0;
      if (countBytes) {
        for (let i = 0; i < events.length; i++) bytes += events[i].body.length;
      }
      // null, not 0, when counting is off: the field distinguishes "not
      // observed" from "zero bytes", and a confident 0 would be added to the
      // wire_bytes counter as if it had been measured.
      return { ok: true, status: 200, wire_bytes: countBytes ? bytes : null };
    },
    async close() {
      /* nothing to release */
    },
  };
};
