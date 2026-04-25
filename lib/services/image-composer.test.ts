import assert from "node:assert/strict";
import sharp from "sharp";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { composeImageWithLogo, composeMultipleImagesWithLogo } from "./image-composer.ts";

async function createPngBuffer(hex: string, width = 120, height = 120) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: hex
    }
  })
    .png()
    .toBuffer();
}

async function main() {
  const baseImage = await createPngBuffer("#f8fafc");
  const secondImage = await createPngBuffer("#e2e8f0");
  const logoImage = await createPngBuffer("#1d4ed8", 48, 48);

  const composed = await composeImageWithLogo(
    {
      kind: "binary",
      fileName: "base.png",
      bytes: Uint8Array.from(baseImage).buffer,
      mimeType: "image/png"
    },
    {
      bytes: Uint8Array.from(logoImage).buffer,
      mimeType: "image/png"
    }
  );

  assert.equal(composed.kind, "binary");
  assert.notDeepEqual(Buffer.from(composed.bytes), baseImage);

  const multi = await composeMultipleImagesWithLogo(
    [
      {
        kind: "binary",
        fileName: "one.png",
        bytes: Uint8Array.from(baseImage).buffer,
        mimeType: "image/png"
      },
      {
        kind: "binary",
        fileName: "two.png",
        bytes: Uint8Array.from(secondImage).buffer,
        mimeType: "image/png"
      }
    ],
    {
      bytes: Uint8Array.from(logoImage).buffer,
      mimeType: "image/png"
    }
  );

  assert.equal(multi.length, 2);
  assert.equal(multi.every((item) => item.kind === "binary"), true);
  assert.notDeepEqual(Buffer.from((multi[0] as { bytes: ArrayBuffer }).bytes), baseImage);
  assert.notDeepEqual(Buffer.from((multi[1] as { bytes: ArrayBuffer }).bytes), secondImage);

  console.log("PASS composeImageWithLogo เพิ่ม logo ลงภาพได้");
  console.log("PASS composeMultipleImagesWithLogo ใส่ logo ครบทุกภาพ");
}

void main().catch((error) => {
  console.error("FAIL image composer tests");
  throw error;
});
