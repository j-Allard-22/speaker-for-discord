/**
 * File logger for the helper. Writes to %LOCALAPPDATA%\DiscordSpeakerHelper\helper.log
 * (NEVER inside the .sdPlugin folder — open handles there would block plugin updates)
 * and mirrors to the console for standalone runs.
 *
 * Redaction: values of secret-ish keys are scrubbed before serialization. Never log
 * token-endpoint bodies or AUTHENTICATE args directly — pass everything through the
 * logger's data parameter so redact() sees it.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Keys whose *string* values are secrets. Numeric values (e.g. RPC error `code`) pass. */
const SECRET_KEY = /^(access_token|refresh_token|client_secret|code|secret|token|password)$/i;

export function helperStateDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "DiscordSpeakerHelper");
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

export type LogLevel = "debug" | "info" | "warn" | "error";

export class HelperLogger {
  private readonly file: string;
  private mirrorToConsole: boolean;
  private writesSinceRotateCheck = 0;

  constructor(opts: { dir?: string; mirrorToConsole?: boolean } = {}) {
    const dir = opts.dir ?? helperStateDir();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "helper.log");
    this.mirrorToConsole = opts.mirrorToConsole ?? true;
    this.rotateIfHuge();
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
    const line = this.format(level, msg, data);
    try {
      appendFileSync(this.file, line + "\n");
      // Rotation must also happen while RUNNING — a wedged retry loop once grew the
      // log to 17 MB because the size was only checked at startup.
      if (++this.writesSinceRotateCheck >= 200) {
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
