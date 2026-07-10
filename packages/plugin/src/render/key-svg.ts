/**
 * Speaker-key SVG. The whole key is ONE 72x72 SVG (setTitle("") suppresses overlays):
 * avatar fills the key, a dark bottom band carries the truncated name.
 *
 * Safety rails:
 * - every user-controlled string passes escapeXml (names can contain < & " ')
 * - truncation uses Intl.Segmenter graphemes (code-point slicing shreds ZWJ emoji)
 * - textLength="68" hard-bounds the pixel width regardless of glyph widths
 */

const BAND_TOP = 53;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function graphemes(s: string): string[] {
  return [...segmenter.segment(s)].map((seg) => seg.segment);
}

export function truncateName(name: string, max = 10): string {
  const parts = graphemes(name);
  if (parts.length <= max) return name;
  return parts.slice(0, max - 1).join("") + "…";
}

/** Deterministic per-user fallback color (Discord-ish palette). */
const FALLBACK_COLORS = [
  "#5865f2",
  "#3ba55c",
  "#faa61a",
  "#ed4245",
  "#eb459e",
  "#00b0f4",
  "#9b59b6",
  "#e67e22",
] as const;

export function fallbackColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
}

function nameBand(name: string): string {
  const truncated = truncateName(name);
  const label = escapeXml(truncated);
  // textLength hard-bounds wide glyphs — but it also STRETCHES short names, so only
  // apply it when the name is long enough to plausibly overflow the 68 px band.
  const bound =
    graphemes(truncated).length > 8 ? ` textLength="68" lengthAdjust="spacingAndGlyphs"` : "";
  return (
    `<rect x="0" y="${BAND_TOP}" width="72" height="${72 - BAND_TOP}" fill="rgba(0,0,0,0.62)"/>` +
    `<text x="36" y="66" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif"` +
    ` font-size="11" font-weight="600" fill="#ffffff"${bound}>${label}</text>`
  );
}

/** Avatar (base64 PNG) filling the key + name band. */
export function renderSpeakerKey(name: string, avatarPngB64: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<image href="data:image/png;base64,${avatarPngB64}" x="0" y="0" width="72" height="72" preserveAspectRatio="xMidYMid slice"/>` +
    nameBand(name) +
    `</svg>`
  );
}

/** No avatar available: colored disc + first grapheme + name band. */
export function renderInitialsKey(name: string, userId: string): string {
  const initial = escapeXml(graphemes(name)[0] ?? "?");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" fill="#1e1f22"/>` +
    `<circle cx="36" cy="28" r="20" fill="${fallbackColor(userId)}"/>` +
    `<text x="36" y="36" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif"` +
    ` font-size="20" font-weight="700" fill="#ffffff">${initial}</text>` +
    nameBand(name) +
    `</svg>`
  );
}
