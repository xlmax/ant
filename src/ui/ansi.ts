let colorEnabled = true;
const reset = "\u001B[0m";

export function configureAnsi(enabled: boolean): void {
  colorEnabled = enabled;
}

function colorsAvailable(): boolean {
  return colorEnabled && Boolean(process.stdout.isTTY);
}

function style(code: number, text: string): string {
  return colorsAvailable() ? `\u001B[${code}m${text}${reset}` : text;
}

function dimPreservingStyles(text: string): string {
  if (!colorsAvailable()) {
    return text;
  }

  const dim = "\u001B[2m";
  return `${dim}${text.replaceAll(reset, `${reset}${dim}`)}${reset}`;
}

export const ansi = {
  bold: (text: string): string => style(1, text),
  dim: (text: string): string => style(2, text),
  dimPreservingStyles,
  red: (text: string): string => style(31, text),
  green: (text: string): string => style(32, text),
  yellow: (text: string): string => style(33, text),
  blue: (text: string): string => style(34, text),
  magenta: (text: string): string => style(35, text),
  cyan: (text: string): string => style(36, text),
};
