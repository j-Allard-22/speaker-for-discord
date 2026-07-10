/**
 * Discord's IPC server has a documented client bug: some payloads arrive with
 * camelCase keys instead of snake_case (and may have extra/missing fields).
 * Every inbound frame passes through normalizeKeys() before dispatch, and all
 * readers treat documented fields as optional.
 */

/**
 * Real Discord RPC payloads nest only a handful of levels. A cap well above that
 * turns a hostile deeply-nested frame (e.g. from a process that squatted the
 * discord-ipc pipe before Discord) into a caught error instead of a stack overflow
 * that would escape as an uncaughtException and kill the helper.
 */
export const MAX_NORMALIZE_DEPTH = 64;

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizeError";
  }
}

export function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function normalizeKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_NORMALIZE_DEPTH) {
    throw new NormalizeError(`payload nested deeper than ${MAX_NORMALIZE_DEPTH} levels`);
  }
  if (Array.isArray(value)) return value.map((v) => normalizeKeys(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Never let an incoming "__proto__"/"constructor" key walk the prototype chain.
      const key = camelToSnake(k);
      Object.defineProperty(out, key, {
        value: normalizeKeys(v, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
