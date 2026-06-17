import { describe, expect, it } from "vitest";
import { resizeImageUrl } from "../src/index.js";

describe("resizeImageUrl", () => {
  it("sets Tesco image dimensions while preserving the original path", () => {
    expect(
      resizeImageUrl("https://digitalcontent.api.tesco.com/v2/media/ghs/red.jpeg?h=225&w=225", {
        width: 135,
        height: 135,
      }),
    ).toBe("https://digitalcontent.api.tesco.com/v2/media/ghs/red.jpeg?h=135&w=135");
  });

  it("preserves unrelated query parameters", () => {
    expect(
      resizeImageUrl("https://digitalcontent.api.tesco.com/v2/media/ghs/red.jpeg?fmt=webp", {
        width: 960,
        height: 720,
      }),
    ).toBe("https://digitalcontent.api.tesco.com/v2/media/ghs/red.jpeg?fmt=webp&w=960&h=720");
  });

  it("returns null for a null image URL", () => {
    expect(resizeImageUrl(null, { width: 135, height: 135 })).toBeNull();
  });

  it.each([
    ["width", { width: 0, height: 135 }],
    ["width", { width: -1, height: 135 }],
    ["width", { width: 1.5, height: 135 }],
    ["width", { width: Number.NaN, height: 135 }],
    ["height", { width: 135, height: 0 }],
    ["height", { width: 135, height: -1 }],
    ["height", { width: 135, height: 1.5 }],
    ["height", { width: 135, height: Number.POSITIVE_INFINITY }],
  ])("rejects invalid %s", (_name, size) => {
    expect(() => resizeImageUrl("https://example.com/image.jpeg", size)).toThrow(RangeError);
  });
});
