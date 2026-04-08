import { createHash } from "crypto";

export function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function contentFingerprint(input: {
  content: string;
  hashtags?: string[];
  imageUrls?: string[];
  targetPageIds?: string[];
}) {
  return stableHash({
    content: input.content.trim().toLowerCase(),
    hashtags: [...(input.hashtags ?? [])].map((item) => item.trim().toLowerCase()).sort(),
    imageUrls: [...(input.imageUrls ?? [])].sort(),
    targetPageIds: [...(input.targetPageIds ?? [])].sort()
  });
}

export function imageFingerprint(imageUrls: string[]) {
  return stableHash([...imageUrls].sort());
}
