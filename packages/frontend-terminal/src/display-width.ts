import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function truncateDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;

  const ellipsis = "…";
  const contentWidth = Math.max(0, maxWidth - displayWidth(ellipsis));
  let result = "";
  let width = 0;
  for (const part of graphemeSegmenter.segment(text)) {
    const partWidth = displayWidth(part.segment);
    if (width + partWidth > contentWidth) break;
    result += part.segment;
    width += partWidth;
  }
  return `${result}${ellipsis}`;
}
