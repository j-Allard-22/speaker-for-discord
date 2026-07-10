/**
 * Prebuilt, pure-SVG key images for every non-speaker state (no network fetch).
 * The whole key is always one 72x72 SVG applied via setImage + setTitle("").
 *
 * All strings here are static — no user-controlled content, no escaping needed.
 * (User-controlled names go through escapeXml in key-svg.ts.)
 */

const BG = "#1e1f22"; // Discord dark
const MUTED = "#4e5058";
const TEXT = "#b5bac1";
const BLURPLE = "#5865f2";
const RED = "#da373c";
const AMBER = "#f0b232";

function keySvg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" fill="${BG}"/>${inner}</svg>`;
}

function micGlyph(color: string, cy = 0): string {
  return (
    `<rect x="31" y="${12 + cy}" width="10" height="22" rx="5" fill="${color}"/>` +
    `<path d="M23 ${30 + cy} a13 13 0 0 0 26 0" stroke="${color}" stroke-width="4" fill="none" stroke-linecap="round"/>` +
    `<line x1="36" y1="${43 + cy}" x2="36" y2="${49 + cy}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="27" y1="${52 + cy}" x2="45" y2="${52 + cy}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`
  );
}

function label(text: string, y: number, fill = TEXT, size = 11): string {
  return `<text x="36" y="${y}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="${size}" font-weight="600" fill="${fill}">${text}</text>`;
}

/** Nobody speaking: dim mic. */
export const IDLE_KEY = keySvg(micGlyph(MUTED));

/** Helper is connecting/authenticating to Discord. */
export const CONNECTING_KEY = keySvg(
  micGlyph(MUTED, -4) + label("Connecting…", 62),
);

/** AUTHORIZE in flight — the consent modal is in ANOTHER app; tell the user where to look. */
export const AUTHORIZING_KEY = keySvg(
  `<circle cx="36" cy="26" r="14" fill="none" stroke="${BLURPLE}" stroke-width="4"/>` +
    `<line x1="36" y1="18" x2="36" y2="27" stroke="${BLURPLE}" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="36" y1="27" x2="42" y2="31" stroke="${BLURPLE}" stroke-width="4" stroke-linecap="round"/>` +
    label("Check", 52, TEXT) +
    label("Discord", 64, TEXT),
);

/** Stored tokens dead; waiting for the user to re-authorize from the PI. */
export const AUTH_NEEDED_KEY = keySvg(
  `<circle cx="30" cy="26" r="9" fill="none" stroke="${AMBER}" stroke-width="4"/>` +
    `<line x1="37" y1="33" x2="48" y2="44" stroke="${AMBER}" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="44" y1="40" x2="48" y2="36" stroke="${AMBER}" stroke-width="4" stroke-linecap="round"/>` +
    label("Authorize", 62, AMBER),
);

/** No client ID/secret configured yet — first-run state. */
export const SETUP_KEY = keySvg(
  `<circle cx="36" cy="28" r="8" fill="none" stroke="${TEXT}" stroke-width="4"/>` +
    [0, 45, 90, 135, 180, 225, 270, 315]
      .map((deg) => {
        const rad = (deg * Math.PI) / 180;
        const x1 = 36 + Math.cos(rad) * 12;
        const y1 = 28 + Math.sin(rad) * 12;
        const x2 = 36 + Math.cos(rad) * 17;
        const y2 = 28 + Math.sin(rad) * 17;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${TEXT}" stroke-width="4" stroke-linecap="round"/>`;
      })
      .join("") +
    label("Setup", 64),
);

/** Discord client not running (all pipes refused). */
export const NO_DISCORD_KEY = keySvg(
  micGlyph(MUTED, -4) +
    `<line x1="18" y1="14" x2="54" y2="46" stroke="${RED}" stroke-width="5" stroke-linecap="round"/>` +
    label("Discord?", 64),
);

/** Connected + authed, but the user is not in a voice channel. */
export const NO_CHANNEL_KEY = keySvg(
  micGlyph(MUTED, -4) + label("No VC", 64),
);

/** Helper process is down; plugin is respawning it with backoff. */
export const HELPER_DOWN_KEY = keySvg(
  `<path d="M36 12 L60 54 L12 54 Z" fill="none" stroke="${RED}" stroke-width="4" stroke-linejoin="round"/>` +
    `<line x1="36" y1="26" x2="36" y2="40" stroke="${RED}" stroke-width="5" stroke-linecap="round"/>` +
    `<circle cx="36" cy="47" r="2.5" fill="${RED}"/>`,
);

/** Foreign process owns the helper port; user must change helperPort in the PI. */
export const PORT_CONFLICT_KEY = keySvg(
  `<path d="M36 8 L56 42 L16 42 Z" fill="none" stroke="${AMBER}" stroke-width="4" stroke-linejoin="round"/>` +
    `<line x1="36" y1="18" x2="36" y2="30" stroke="${AMBER}" stroke-width="4" stroke-linecap="round"/>` +
    `<circle cx="36" cy="36" r="2" fill="${AMBER}"/>` +
    label("Port conflict", 60, AMBER, 10),
);

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
