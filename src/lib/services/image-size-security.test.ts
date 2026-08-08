import { imageSize } from "image-size";
import { findBox } from "image-size/types/utils";
import { describe, expect, it } from "vitest";

describe("vendored image-size security patch", () => {
  it("does not loop on a zero-length ISO box", () => {
    const zeroLengthBox = new Uint8Array([
      0, 0, 0, 0, // length
      102, 116, 121, 112, // ftyp
    ]);

    expect(findBox(zeroLengthBox, "meta", 0)).toBeUndefined();
  });

  it("rejects a zero-length ICNS image entry", () => {
    const malformedIcns = new Uint8Array([
      105, 99, 110, 115, // icns
      0, 0, 0, 16, // file length
      105, 99, 48, 55, // ic07
      0, 0, 0, 0, // entry length
    ]);

    expect(() => imageSize(malformedIcns)).toThrow(
      "Invalid ICNS, invalid image length",
    );
  });
});
