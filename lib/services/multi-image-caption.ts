function stripLeadingDecorations(line: string) {
  return line
    .trim()
    .replace(/^[\s\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u20E3#*.()\[\]{}_\-–—:：]+/gu, "")
    .trim();
}

function isMainModelLine(line: string) {
  return /^แบบ\s*1\s*[:：]/u.test(stripLeadingDecorations(line));
}

function isDuplicateIntroItem(line: string) {
  const trimmed = line.trim();
  const normalized = stripLeadingDecorations(trimmed);

  if (!normalized) {
    return false;
  }

  return (
    /^\d+\s*แบบ\s*\d+\s*[—\-–:：]\s*.+$/u.test(normalized) ||
    /^แบบ\s*\d+\s*[—\-–]\s*.+$/u.test(normalized)
  );
}

export function sanitizeMultiImageCaption(caption: string): string {
  const lines = caption.split(/\r?\n/);

  const mainListStartIndex = lines.findIndex((line) => isMainModelLine(line));

  if (mainListStartIndex === -1) {
    return caption.trim();
  }

  const beforeMain = lines.slice(0, mainListStartIndex);
  const mainAndAfter = lines.slice(mainListStartIndex);

  const cleanedBeforeMain = beforeMain.filter((line) => !isDuplicateIntroItem(line));

  return [...cleanedBeforeMain, ...mainAndAfter].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

