const MOJIBAKE_MARKERS = ["ðŸ", "à¸", "à¹", "Ã", "Â", "\uFFFD"] as const;

export type TextEncodingValidation = {
  ok: boolean;
  markers: string[];
  reasons: string[];
  preview: string;
};

export function hasMojibakeText(value: unknown) {
  if (typeof value !== "string" || !value) return false;
  return MOJIBAKE_MARKERS.some((marker) => value.includes(marker));
}

export function repairMojibakeText(value: string) {
  if (!hasMojibakeText(value)) return value;

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    return hasMojibakeText(repaired) ? value : repaired;
  } catch {
    return value;
  }
}

export function normalizeTextEncoding(value: string) {
  return repairMojibakeText(value).normalize("NFC");
}

export function validateTextEncoding(value: string, label = "text"): TextEncodingValidation {
  const markers = MOJIBAKE_MARKERS.filter((marker) => value.includes(marker));
  const reasons = markers.map((marker) => `${label} contains corrupted UTF-8 marker: ${marker}`);

  return {
    ok: reasons.length === 0,
    markers,
    reasons,
    preview: value.slice(0, 160)
  };
}

export function assertValidTextEncoding(value: string, label = "text") {
  const validation = validateTextEncoding(value, label);
  if (validation.ok) return value;

  const error = new Error(`${label} failed UTF-8 validation: ${validation.reasons.join("; ")}`);
  (error as Error & { code?: string; details?: TextEncodingValidation }).code = "caption_encoding_corrupted";
  (error as Error & { code?: string; details?: TextEncodingValidation }).details = validation;
  throw error;
}

