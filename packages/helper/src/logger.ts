/**
 * File logger for the helper. Writes to %LOCALAPPDATA%\<StateDir>\helper.log
 * (NEVER inside the .sdPlugin folder — open handles there would block plugin updates)
 * and mirrors to the console for standalone runs.
 *
 * Level: defaults to `info`. `debug` is opt-in (`--log-level debug` or DSD_LOG_LEVEL)
 * because debug traffic includes RPC command arguments carrying channel IDs.
 *
 * Redaction: values of secret-ish keys are scrubbed before serialization, in BOTH the
 * wire casing (`access_token`) and our own storage casing (`accessToken`). Never log
 * token-endpoint bodies or AUTHENTICATE args directly — pass them as the `data`
 * argument so redact() sees them.
 */
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { helperStateDir } from "@dsd/shared";

export { helperStateDir };

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 200;

/**
 * Keys whose *string* values are secrets — wire casing and StoredAuth casing.
 * Numeric values (e.g. an RPC error `code`) are left alone.
 */
const SECRET_KEY =
  /^(access_token|refresh_token|client_secret|code|secret|token|password|accessToken|refreshToken|clientSecret|codeVerifier|code_verifier)$/i;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function resolveLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

export class HelperLogger {
  private readonly file: string;
  private readonly mirrorToConsole: boolean;
  private readonly minRank: number;
  private writesSinceRotateCheck = 0;

  constructor(opts: { dir?: string; mirrorToConsole?: boolean; minLevel?: LogLevel } = {}) {
    const dir = opts.dir ?? helperStateDir();
    this.file = join(dir, "helper.log");
    this.mirrorToConsole = opts.mirrorToConsole ?? true;
    this.minRank = LEVEL_RANK[opts.minLevel ?? "info"];
    this.rotateIfHuge();
  }

  /** True when debug output would be written — lets callers skip building payloads. */
  get debugEnabled(): boolean {
    return this.minRank <= LEVEL_RANK.debug;
  }

  debug(msg: string, data?: unknown): void {
    this.write("debug", msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.write("info", msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.write("warn", msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.write("error", msg, data);
  }

  /** Serialize `data` with secrets scrubbed; exposed for tests. */
  format(level: LogLevel, msg: string, data?: unknown): string {
    const ts = new Date().toISOString();
    const suffix = data === undefined ? "" : ` ${safeStringify(redact(data))}`;
    return `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
  }

  private write(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const line = this.format(level, msg, data);
    try {
      appendFileSync(this.file, line + "\n");
      // Rotation must also happen while RUNNING — a wedged retry loop once grew the
      // log to 17 MB because the size was only checked at startup.
      if (++this.writesSinceRotateCheck >= ROTATE_CHECK_EVERY) {
        this.writesSinceRotateCheck = 0;
        this.rotateIfHuge();
      }
    } catch {
      // Logging must never crash the helper.
    }
    if (this.mirrorToConsole) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  private rotateIfHuge(): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_LOG_BYTES) {
        renameSync(this.file, this.file + ".1"); // replaces any previous .1
      }
    } catch {
      /* best effort */
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
