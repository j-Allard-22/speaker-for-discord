/**
 * Speaker-key SVG. The whole key is ONE 72x72 SVG (setTitle("") suppresses overlays):
 * avatar fills the key, the truncated name sits at the bottom as white text with a
 * black outline (no banner — the avatar stays visible behind the label).
 *
 * Safety rails:
 * - every user-controlled string passes escapeXml (names can contain < & " ')
 * - truncation uses Intl.Segmenter graphemes (code-point slicing shreds ZWJ emoji)
 * - textLength="68" hard-bounds the pixel width regardless of glyph widths
 */

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

function nameLabel(name: string): string {
  const truncated = truncateName(name);
  const label = escapeXml(truncated);
  // textLength hard-bounds wide glyphs — but it also STRETCHES short names, so only
  // apply it when the name is long enough to plausibly overflow 68 px.
  const bound =
    graphemes(truncated).length > 8 ? ` textLength="68" lengthAdjust="spacingAndGlyphs"` : "";
  const common =
    `x="36" y="66" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif"` +
    ` font-size="11" font-weight="600"${bound}`;
  // Two passes instead of paint-order="stroke fill": the Stream Deck rasterizer may not
  // support paint-order, and the default order would draw the stroke OVER the fill.
  return (
    `<text ${common} fill="#000000" stroke="#000000" stroke-width="3" stroke-linejoin="round">${label}</text>` +
    `<text ${common} fill="#ffffff">${label}</text>`
  );
}

/** Avatar (base64 PNG) filling the key + outlined name. */
export function renderSpeakerKey(name: string, avatarPngB64: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<image href="data:image/png;base64,${avatarPngB64}" x="0" y="0" width="72" height="72" preserveAspectRatio="xMidYMid slice"/>` +
    nameLabel(name) +
    `</svg>`
  );
}

/** No avatar available: colored disc + first grapheme + outlined name. */
export function renderInitialsKey(name: string, userId: string): string {
  const initial = escapeXml(graphemes(name)[0] ?? "?");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" fill="#1e1f22"/>` +
    `<circle cx="36" cy="28" r="20" fill="${fallbackColor(userId)}"/>` +
    `<text x="36" y="36" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif"` +
    ` font-size="20" font-weight="700" fill="#ffffff">${initial}</text>` +
    nameLabel(name) +
    `</svg>`
  );
}

/** Idle in VC: the guild's icon, dimmed, no text. Overlay rect, not image opacity (proven pattern). */
export function renderIdleGuildKey(iconPngB64: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" fill="#1e1f22"/>` +
    `<image href="data:image/png;base64,${iconPngB64}" x="0" y="0" width="72" height="72" preserveAspectRatio="xMidYMid slice"/>` +
    `<rect width="72" height="72" fill="rgba(0,0,0,0.55)"/>` +
    `</svg>`
  );
}
