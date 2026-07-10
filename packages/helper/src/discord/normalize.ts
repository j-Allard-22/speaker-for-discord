/**
 * Discord's IPC server has a documented client bug: some payloads arrive with
 * camelCase keys instead of snake_case (and may have extra/missing fields).
 * Every inbound frame passes through normalizeKeys() before dispatch, and all
 * readers treat documented fields as optional.
 */

export function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[camelToSnake(k)] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}
