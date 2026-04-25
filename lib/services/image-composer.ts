import sharp from "sharp";

export type LogoBinary = {
  bytes: ArrayBuffer;
  mimeType: string;
};

export type OverlayableImage =
  | { kind: "url"; value: string }
  | { kind: "binary"; fileName: string; bytes: ArrayBuffer; mimeType: string };

export async function composeImageWithLogo(
  image: OverlayableImage,
  profileImage?: LogoBinary | null
): Promise<OverlayableImage> {
  if (image.kind !== "binary" || !profileImage) {
    return image;
  }

  const inputBuffer = Buffer.from(image.bytes);
  const metadata = await sharp(inputBuffer).metadata();
  const baseSize = Math.min(metadata.width ?? 1200, metadata.height ?? 1200);
  const avatarSize = Math.max(92, Math.round(baseSize * 0.17));
  const containerWidth = Math.round(avatarSize * 1.18);
  const containerHeight = Math.round(avatarSize * 1.18);
  const inset = Math.max(32, Math.round(baseSize * 0.055));
  const avatarInset = Math.round((containerWidth - avatarSize) / 2);
  const profileBuffer = await sharp(Buffer.from(profileImage.bytes))
    .resize(avatarSize, avatarSize, { fit: "cover" })
    .png()
    .toBuffer();

  const containerSvg = Buffer.from(`
    <svg width="${containerWidth}" height="${containerHeight}" viewBox="0 0 ${containerWidth} ${containerHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="profileFrame" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.96)"/>
          <stop offset="100%" stop-color="rgba(233,241,255,0.9)"/>
        </linearGradient>
        <filter id="profileShadow" x="-35%" y="-35%" width="180%" height="180%">
          <feDropShadow dx="0" dy="9" stdDeviation="9" flood-color="#0f172a" flood-opacity="0.26"/>
        </filter>
      </defs>
      <rect x="3" y="3" width="${containerWidth - 6}" height="${containerHeight - 6}" rx="${Math.round(containerWidth * 0.34)}" fill="url(#profileFrame)" fill-opacity="0.96" stroke="rgba(255,255,255,0.9)" stroke-width="2" filter="url(#profileShadow)"/>
      <circle cx="${containerWidth / 2}" cy="${containerHeight / 2}" r="${avatarSize / 2 + 5}" fill="none" stroke="rgba(37,86,216,0.9)" stroke-width="3"/>
      <circle cx="${containerWidth / 2}" cy="${containerHeight / 2}" r="${avatarSize / 2 + 1}" fill="none" stroke="rgba(255,255,255,0.82)" stroke-width="2"/>
    </svg>
  `);

  const maskSvg = Buffer.from(
    `<svg width="${avatarSize}" height="${avatarSize}" viewBox="0 0 ${avatarSize} ${avatarSize}" xmlns="http://www.w3.org/2000/svg"><circle cx="${avatarSize / 2}" cy="${
      avatarSize / 2
    }" r="${avatarSize / 2 - 4}" fill="#ffffff"/></svg>`
  );

  const avatar = await sharp(profileBuffer)
    .composite([{ input: maskSvg, blend: "dest-in" }])
    .png()
    .toBuffer();

  const top = Math.max(24, (metadata.height ?? baseSize) - containerHeight - inset);
  const left = Math.max(24, (metadata.width ?? baseSize) - containerWidth - inset);

  const output = await sharp(inputBuffer)
    .composite([
      {
        input: avatar,
        top: top + avatarInset,
        left: left + avatarInset
      },
      {
        input: containerSvg,
        top,
        left
      }
    ])
    .toBuffer({ resolveWithObject: true });

  return {
    kind: "binary",
    fileName: image.fileName,
    bytes: Uint8Array.from(output.data).buffer,
    mimeType: output.info.format === "png" ? "image/png" : "image/jpeg"
  };
}

export async function composeMultipleImagesWithLogo(
  images: OverlayableImage[],
  profileImage?: LogoBinary | null
) {
  const decorated: OverlayableImage[] = [];
  for (const image of images) {
    decorated.push(await composeImageWithLogo(image, profileImage));
  }
  return decorated;
}
