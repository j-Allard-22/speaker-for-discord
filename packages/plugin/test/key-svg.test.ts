import { describe, expect, it } from "vitest";
import {
  escapeXml,
  fallbackColor,
  graphemes,
  renderIdleGuildKey,
  renderInitialsKey,
  renderSpeakerKey,
  truncateName,
} from "../src/render/key-svg";

describe("escapeXml", () => {
  it("neutralizes SVG injection via display names", () => {
    const evil = `<script>alert(1)</script>"'&`;
    const out = escapeXml(evil);
    expect(out).not.toContain("<script>");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&apos;&amp;");
  });
});

describe("truncateName", () => {
  it("keeps short names untouched", () => {
    expect(truncateName("Jo")).toBe("Jo");
    expect(truncateName("exactlyten")).toBe("exactlyten");
  });

  it("truncates long names with an ellipsis", () => {
    expect(truncateName("Bartholomew III")).toBe("Bartholom…");
  });

  it("never shreds ZWJ emoji clusters (grapheme-safe)", () => {
    const family = "👨‍👩‍👧‍👦"; // single grapheme, many code points
    const name = family.repeat(12);
    const out = truncateName(name);
    expect(graphemes(out)).toHaveLength(10); // 9 families + ellipsis
    expect(out.endsWith("…")).toBe(true);
    // No orphaned ZWJ at the cut point:
    expect(out.at(-2)).not.toBe("‍");
  });

  it("flag emoji count as single graphemes", () => {
    expect(truncateName("🇨🇦🇨🇦🇨🇦", 2)).toBe("🇨🇦…");
  });
});

describe("key SVGs", () => {
  it("speaker key embeds the avatar and a pixel-bounded, outlined name", () => {
    const svg = renderSpeakerKey("Jo <&> :3", "QUJD"); // short enough to skip truncation
    expect(svg).toContain('width="72" height="72"');
    expect(svg).toContain("data:image/png;base64,QUJD");
    expect(svg).toContain('textLength="68"'); // hard pixel bound for wide glyphs
    expect(svg).toContain("Jo &lt;&amp;&gt; :3"); // escaped
    expect(svg).not.toContain("Jo <&>"); // raw '<' never survives
    // Outline = black-stroked layer under a white-filled layer — no banner rect.
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).not.toContain("rgba(0,0,0,0.62)");
    expect(svg.split("Jo &lt;&amp;&gt; :3")).toHaveLength(3); // label rendered twice
    // ORDER matters: the stroke layer must come FIRST or the outline covers the fill
    // (paint-order is unreliable in the Stream Deck rasterizer — see nameLabel).
    expect(svg.indexOf('fill="#ffffff"')).toBeGreaterThan(svg.indexOf('stroke="#000000"'));
    // The pixel bound must sit on BOTH layers or stroke and fill render at different widths.
    expect(svg.match(/textLength="68"/g)).toHaveLength(2);
  });

  it("initials key uses a deterministic per-user color and the first grapheme", () => {
    const svg = renderInitialsKey("👨‍👩‍👧‍👦 Family", "12345");
    expect(svg).toContain(fallbackColor("12345"));
    expect(svg).toContain("👨‍👩‍👧‍👦"); // whole cluster, not a slice of it
    expect(fallbackColor("12345")).toBe(fallbackColor("12345")); // stable
  });

  it("idle guild key dims the icon with an overlay and carries no text", () => {
    const svg = renderIdleGuildKey("QUJD");
    expect(svg).toContain("data:image/png;base64,QUJD");
    expect(svg).toContain("rgba(0,0,0,0.55)"); // dim overlay
    expect(svg).not.toContain("<text"); // no name, no label
    // ORDER matters: the overlay must paint AFTER the image or nothing is dimmed.
    expect(svg.indexOf("rgba(0,0,0,0.55)")).toBeGreaterThan(svg.indexOf("<image"));
  });
});
