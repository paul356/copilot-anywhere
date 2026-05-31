/**
 * CLI Process Manager
 *
 * Manages the Copilot CLI process running in --ui-server mode.
 * Uses node-pty so the CLI sees a real TTY (required for slash commands).
 * The JSON-RPC server is exposed on a TCP port for SDK access.
 */

import * as pty from "node-pty";
import { EventEmitter } from "events";
import * as net from "net";

export interface CLIProcessOptions {
  port: number;
  model?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  /** Extra CLI flags (e.g. "--log-level", "info") */
  extraArgs?: string[];
}

export class CLIProcess extends EventEmitter {
  private proc?: pty.IPty;
  private options: CLIProcessOptions;
  private exitCode: number | null = null;

  constructor(options: CLIProcessOptions) {
    super();
    this.options = options;
  }

  /** Start copilot --ui-server --port <N> in a PTY */
  async start(): Promise<void> {
    const args = [
      "--ui-server",
      "--port", String(this.options.port),
      "--no-auto-update",
      "--allow-all-paths",
    ];

    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    console.log(`[cli-process] Starting: copilot ${args.join(" ")}`);

    this.proc = pty.spawn("copilot", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: this.options.workingDirectory ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
    });

    this.proc.onData((data: string) => {
      // Forward PTY output for logging/debugging
      this.emit("pty-output", data);
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.exitCode = exitCode;
      console.log(`[cli-process] Copilot CLI exited (code=${exitCode}, signal=${signal})`);
      this.emit("exit", exitCode, signal);
    });

    // Wait for the JSON-RPC port to become available
    await this.waitForPort(this.options.port, 30_000);

    console.log(`[cli-process] Copilot --ui-server ready on port ${this.options.port}`);
  }

  /** Write a slash command to the PTY and collect the TUI output.
   *  Waits for output to settle (no new data for `settleMs`) or until `timeoutMs`.
   *  Returns the raw PTY output (may include ANSI codes). */
  async sendCommandAndWait(
    cmd: string,
    timeoutMs = 10_000,
    settleMs = 1_500,
  ): Promise<string> {
    if (!this.proc) throw new Error("CLI process not running");

    console.log(`[cli-process] sendCommandAndWait: ${cmd.slice(0, 80)} (timeout=${timeoutMs}ms, settle=${settleMs}ms)`);

    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      let settleTimer: NodeJS.Timeout | undefined;
      let done = false;

      const onData = (data: string) => {
        if (done) return;
        chunks.push(data);

        // Reset settle timer — wait for output to stop
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          done = true;
          this.off("pty-output", onData);
          const output = chunks.join("");
          console.log(`[cli-process] output settled (${output.length} chars)`);
          resolve(output);
        }, settleMs);
      };

      // Total timeout
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        clearTimeout(settleTimer);
        this.off("pty-output", onData);
        const partial = chunks.join("");
        console.error(`[cli-process] timed out waiting for output (${timeoutMs}ms, ${partial.length} chars captured)`);
        reject(new Error(`Timed out waiting for CLI output (${timeoutMs}ms)`));
      }, timeoutMs);

      this.on("pty-output", onData);
      this.proc!.write(cmd + "\r");
    });
  }

  /** Check if the underlying process is alive */
  isAlive(): boolean {
    return this.proc !== undefined && this.exitCode === null;
  }

  /** Graceful stop — send SIGTERM, force kill after timeout */
  async stop(): Promise<void> {
    if (!this.proc) return;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { this.proc?.kill(); } catch {}
        resolve();
      }, 5000);

      this.proc!.onExit(() => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        // Send Ctrl+C first for graceful shutdown
        this.proc!.write("\x03");
      } catch {
        try { this.proc!.kill(); } catch {}
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  /** Wait for a TCP port to accept connections */
  private waitForPort(port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tryConnect = () => {
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`Timed out waiting for port ${port}`));
        }

        const socket = new net.Socket();
        socket.setTimeout(500);

        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });

        socket.on("error", () => {
          socket.destroy();
          setTimeout(tryConnect, 500);
        });

        socket.on("timeout", () => {
          socket.destroy();
          setTimeout(tryConnect, 500);
        });

        socket.connect(port, "127.0.0.1");
      };

      tryConnect();
    });
  }
}
