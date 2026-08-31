// Hand-written declaration for `k6/x/tcp` (grafana/xk6-tcp). There is no
// `@types` package for this extension and no bundled declaration ships with
// k6 itself — `import { Socket } from 'k6/x/tcp'` does not typecheck without
// this file.
//
// This is NOT written from the extension's docs. The real surface was
// verified by running against xk6-tcp v0.3.1 (provisioned locally via k6's
// automatic extension resolution) and, where behaviour needed confirming
// beyond what a probe script can observe (promise-vs-event error semantics,
// the exact shape `connect()` accepts, what actually owns the background
// goroutine that must be destroyed), by reading the extension's Go source
// at that tag (github.com/grafana/xk6-tcp, tree v0.3.1, package tcp). See
// task-6-report.md for the verification transcript. Things a docs-only
// reading would have gotten wrong:
//   - `connect()` takes at most TWO arguments. TLS is a plain boolean field
//     on the single options object form — `connect({ port, host, tls })` —
//     not a third argument, and not `{ tls: {} }`.
//   - There is no `close()` method. The only teardown method is `destroy()`.
//   - `destroy()` must be called on EVERY Socket that was constructed, on
//     every path — including one that connected and wrote successfully.
//     It is not special to a failed connect(). See destroy()'s own comment
//     below.
//
// Only the members this project's syslog transport (src/transports/syslog.ts)
// actually uses are declared here — the extension exposes more (setTimeout,
// bytes_written, bytes_read, local_ip/port, remote_ip/port, ready_state,
// per-call `tags`, the 'close'/'data'/'connect'/'timeout' events) that this
// project has no use for. Declaring unused surface here would let code that
// depends on it typecheck clean while this project has never verified that
// surface's real behaviour — so it stays out until something actually uses it.
declare module 'k6/x/tcp' {
  export interface ConnectOptions {
    port: number;
    host?: string;
    /** Uses k6's own VU-level TLS config (e.g. insecureSkipTLSVerify); there
     * is no per-socket TLS config object in this extension. */
    tls?: boolean;
  }

  /** The shape of the error object `TCPError` (Go) surfaces as, both as a
   * rejection value and as the argument to an 'error' event handler. */
  export interface TCPError {
    name: string;
    method: string;
    message: string;
  }

  export class Socket {
    constructor();

    /** Rejects with a TCPError — never throws synchronously. */
    connect(options: ConnectOptions): Promise<void>;

    /** Rejects with an error (not necessarily a TCPError — a raw write
     * failure rejects with the underlying Go error) — never throws
     * synchronously. */
    write(data: string): Promise<void>;

    /**
     * Closes the connection and cancels the socket's background goroutine
     * (started in the constructor, not in connect()). Idempotent — safe to
     * call more than once, and safe to call on a socket that never
     * connected.
     *
     * MUST be called exactly once for every constructed Socket, on every
     * path — success and failure alike. Verified live (not assumed): a
     * script that connected, wrote, and returned WITHOUT calling destroy()
     * hung the whole k6 process indefinitely at shutdown (both messages
     * were actually delivered to the peer — the hang is unrelated to
     * whether the send worked), while the identical script calling
     * destroy() exited normally in under half a second. This is a property
     * of construction, not of a failed connect() specifically.
     */
    destroy(): void;

    /**
     * 'error' fires asynchronously and independently of any write() call —
     * e.g. the socket's background read loop detects a reset connection
     * while idle. It is NOT a substitute for handling a write() rejection;
     * both paths can carry the failure and neither implies the other.
     */
    on(event: 'error', handler: (err: TCPError) => void): void;
  }
}
