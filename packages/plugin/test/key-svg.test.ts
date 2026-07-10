import { describe, expect, it } from "vitest";
import {
  escapeXml,
  fallbackColor,
  graphemes,
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
  it("speaker key embeds the avatar and a pixel-bounded name band", () => {
    const svg = renderSpeakerKey("Jo <&> :3", "QUJD"); // short enough to skip truncation
    expect(svg).toContain('width="72" height="72"');
    expect(svg).toContain("data:image/png;base64,QUJD");
    expect(svg).toContain('textLength="68"'); // hard pixel bound for wide glyphs
    expect(svg).toContain("Jo &lt;&amp;&gt; :3"); // escaped
    expect(svg).not.toContain("Jo <&>"); // raw '<' never survives
  });

  it("initials key uses a deterministic per-user color and the first grapheme", () => {
    const svg = renderInitialsKey("👨‍👩‍👧‍👦 Family", "12345");
    expect(svg).toContain(fallbackColor("12345"));
    expect(svg).toContain("👨‍👩‍👧‍👦"); // whole cluster, not a slice of it
    expect(fallbackColor("12345")).toBe(fallbackColor("12345")); // stable
  });
});
