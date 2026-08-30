// Hand-written declaration for `k6/x/tcp` (grafana/xk6-tcp). There is no
// `@types` package for this extension and no bundled declaration ships with
// k6 itself — `import { Socket } from 'k6/x/tcp'` does not typecheck without
// this file.
//
// This is NOT written from the extension's docs. The real surface was
// verified by running against xk6-tcp v0.3.1 (provisioned locally via k6's
// automatic extension resolution) and, where behaviour needed confirming
// beyond what a probe script can observe (promise-vs-event error semantics,
// the exact shape `connect()` accepts), by reading the extension's Go source
// at that tag (github.com/grafana/xk6-tcp, tree v0.3.1, package tcp). See
// task-6-report.md for the verification transcript. Two things a docs-only
// reading would have gotten wrong:
//   - `connect()` takes at most TWO arguments. TLS is a plain boolean field
//     on the single options object form — `connect({ port, host, tls })` —
//     not a third argument, and not `{ tls: {} }`.
//   - There is no `close()` method. The only teardown method is `destroy()`.
//
// Only the members this project's syslog transport (src/transports/syslog.ts)
// actually uses are declared here — the extension exposes more (setTimeout,
// bytes_written, bytes_read, local_ip/port, remote_ip/port, ready_state,
// 'data'/'connect'/'timeout' events) that this project has no use for yet.
declare module 'k6/x/tcp' {
  export interface ConnectOptions {
    port: number;
    host?: string;
    /** Uses k6's own VU-level TLS config (e.g. insecureSkipTLSVerify); there
     * is no per-socket TLS config object in this extension. */
    tls?: boolean;
    tags?: Record<string, string>;
  }

  /** The shape of the error object `TCPError` (Go) surfaces as, both as a
   * rejection value and as the argument to an 'error' event handler. */
  export interface TCPError {
    name: string;
    method: string;
    message: string;
  }

  export class Socket {
    constructor(options?: { tags?: Record<string, string> });

    /** Rejects with a TCPError — never throws synchronously. */
    connect(options: ConnectOptions): Promise<void>;

    /** Rejects with an error (not necessarily a TCPError — a raw write
     * failure rejects with the underlying Go error) — never throws
     * synchronously. */
    write(data: string): Promise<void>;

    /** Closes the connection and releases the socket's background
     * goroutines. Idempotent — safe to call more than once, and safe to call
     * on a socket that never connected. MUST be called exactly once per
     * constructed Socket on every path (including a failed connect()):
     * verified live that a Socket left undestroyed after connect() rejects
     * hangs the entire k6 process at shutdown, not just the iteration. */
    destroy(): void;

    /**
     * 'error' fires asynchronously and independently of any write() call —
     * e.g. the socket's background read loop detects a reset connection
     * while idle. It is NOT a substitute for handling a write() rejection;
     * both paths can carry the failure and neither implies the other.
     */
    on(event: 'error', handler: (err: TCPError) => void): void;
    on(event: 'close', handler: () => void): void;
  }
}
