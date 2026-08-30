// @types/k6 declares init-context globals like `open()` and `__ENV`, but not
// `console` — even though k6 provides it at runtime (verified: log lines
// from tests/k6/probe-transport-init.ts appear in `k6 run` output). The
// obvious fix, adding "dom" to tsconfig.json's `lib`, is deliberately
// rejected: it would also pull in `document`, `window`, `fetch`, and the
// rest of the browser surface, none of which exists in k6, and would let
// genuinely broken code (code that assumes a browser environment) typecheck
// clean. This declares only the methods this project actually uses.
declare global {
  const console: {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
}

export {};
