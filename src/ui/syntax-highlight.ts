import hljs from "highlight.js";

import { ansi } from "./ansi.js";

function decodeHtml(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'");
}

function styleToken(className: string, text: string): string {
  if (className.includes("comment")) {
    return ansi.dim(text);
  }

  if (
    className.includes("keyword") ||
    className.includes("type") ||
    className.includes("built_in")
  ) {
    return ansi.magenta(text);
  }

  if (
    className.includes("string") ||
    className.includes("regexp") ||
    className.includes("attr")
  ) {
    return ansi.yellow(text);
  }

  if (className.includes("number") || className.includes("literal")) {
    return ansi.cyan(text);
  }

  if (
    className.includes("title") ||
    className.includes("function") ||
    className.includes("class")
  ) {
    return ansi.blue(text);
  }

  return text;
}

function renderHighlightedHtml(html: string): string {
  const rendered = html.replace(
    /<span class="([^"]+)">([\s\S]*?)<\/span>/gu,
    (_match, className: string, content: string) =>
      styleToken(className, decodeHtml(content.replace(/<[^>]+>/gu, ""))),
  );

  return decodeHtml(rendered.replace(/<[^>]+>/gu, ""));
}

export function highlightCode(line: string, language?: string): string {
  if (!language || !hljs.getLanguage(language)) {
    return line;
  }

  try {
    return renderHighlightedHtml(hljs.highlight(line, { language }).value);
  } catch {
    return line;
  }
}
