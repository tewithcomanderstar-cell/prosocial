export function parseCsvRows(input: string) {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return [] as Array<Record<string, string>>;
  }

  const headers = lines[0].split(",").map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((cell) => cell.trim());
    return headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = values[index] ?? "";
      return acc;
    }, {});
  });
}
