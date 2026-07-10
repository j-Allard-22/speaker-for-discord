/**
 * Supervises the helper process.
 *
 * - Adopt-or-spawn: a running helper (hot-reload survivor) is adopted — its Discord
 *   connection is the whole point of the two-process split. Spawn only when nobody
 *   answers the port.
 * - Upgrade swap: if the adopted helper's hello.buildId differs from bin/helper.meta.json
 *   (or its protocolVersion mismatches), send shutdown, wait for socket close AND actual
 *   pid exit, then respawn. Checked at plugin startup only — no fs-watching (rapid dev
 *   saves would burn Discord's ~2/min connection budget).
 * - Respawn backoff: 1 s -> x2 -> cap 60 s; reset after 5 min of healthy connection.
 * - The helper runs with cwd + logs + state under %LOCALAPPDATA%\DiscordSpeakerHelper —
 *   NOTHING inside .sdPlugin is opened for write (Windows locks would break updates).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_STATE_DIRNAME, PROTOCOL_VERSION, type HelloMessage } from "@dsd/shared";
import type { HelperClient } from "./helper-client";

const RESPAWN_BASE_MS = 1_000;
const RESPAWN_CAP_MS = 60_000;
const HEALTHY_RESET_MS = 5 * 60_000;
const PID_EXIT_TIMEOUT_MS = 5_000;

export function helperStateDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const dir = join(base, HELPER_STATE_DIRNAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** <sdPlugin>/ — derived from the bundled plugin.js location (bin/plugin.js). */
export function sdPluginDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface HelperManagerOptions {
  client: HelperClient;
  port: number;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export class HelperManager {
  private respawnExp = 0;
  private lastSpawnAt = 0;
  private connectedSince = 0;
  private swapping = false;

  constructor(private readonly opts: HelperManagerOptions) {
    opts.client.on("connected", (hello: HelloMessage) => this.onConnected(hello));
    opts.client.on("helperUnreachable", () => void this.respawn("unreachable"));
  }

  /** Kick things off: the client starts connecting; if nobody answers, we spawn. */
  start(): void {
    this.opts.client.start();
  }

  private expectedBuildId(): string | null {
    try {
      const metaPath = join(sdPluginDir(), "bin", "helper.meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { buildId?: string };
      return meta.buildId ?? null;
    } catch {
      return null;
    }
  }

  private onConnected(hello: HelloMessage): void {
    this.connectedSince = Date.now();
    this.respawnExp = 0;

    const staleProtocol = hello.protocolVersion !== PROTOCOL_VERSION;
    const expected = this.expectedBuildId();
    const staleBuild = expected !== null && hello.buildId !== expected;
    if ((staleProtocol || staleBuild) && !this.swapping) {
      this.opts.logger.info(
        `helper stale (${staleProtocol ? "protocol" : "buildId"}: have ${hello.buildId}, want ${expected}); swapping`,
      );
      void this.swap(hello.pid);
    }
  }

  /** Graceful upgrade: shutdown -> wait for REAL process exit -> spawn fresh build. */
  private async swap(pid: number): Promise<void> {
    this.swapping = true;
    try {
      this.opts.client.send({ type: "shutdown" });
      await this.waitForPidExit(pid, PID_EXIT_TIMEOUT_MS);
      this.spawnHelper();
      // The client's own reconnect loop picks the new instance up.
    } finally {
      this.swapping = false;
    }
  }

  private async respawn(reason: string): Promise<void> {
    // Reset the ramp after a long healthy stretch.
    if (this.connectedSince && Date.now() - this.connectedSince > HEALTHY_RESET_MS) {
      this.respawnExp = 0;
    }
    const delay = Math.min(RESPAWN_BASE_MS * 2 ** this.respawnExp, RESPAWN_CAP_MS);
    this.respawnExp = Math.min(this.respawnExp + 1, 6);
    const sinceLast = Date.now() - this.lastSpawnAt;
    const wait = Math.max(0, delay - sinceLast);
    this.opts.logger.warn(`helper ${reason}; respawning in ${wait} ms`);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.spawnHelper();
  }

  private spawnHelper(): void {
    const helperPath = join(sdPluginDir(), "bin", "helper.mjs");
    if (!existsSync(helperPath)) {
      this.opts.logger.error(`helper bundle missing: ${helperPath}`);
      return;
    }
    const stateDir = helperStateDir();
    this.lastSpawnAt = Date.now();
    this.opts.logger.info(`spawning helper (${helperPath}) on port ${this.opts.port}`);
    try {
      const child = spawn(
        process.execPath,
        [helperPath, "--port", String(this.opts.port)],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd: stateDir, // never hold a cwd lock inside .sdPlugin
        },
      );
      child.unref();
    } catch (err) {
      this.opts.logger.error(`helper spawn failed: ${String(err)}`);
    }
  }

  private waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        try {
          process.kill(pid, 0); // throws when the process is gone
        } catch {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          this.opts.logger.warn(`helper pid ${pid} still alive after ${timeoutMs} ms; spawning anyway`);
          resolve(); // the new instance's bind-retry window absorbs the race
          return;
        }
        setTimeout(poll, 150);
      };
      poll();
    });
  }
}
