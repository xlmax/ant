const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function style(code: number, text: string): string {
  return enabled ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const ansi = {
  bold: (text: string): string => style(1, text),
  dim: (text: string): string => style(2, text),
  red: (text: string): string => style(31, text),
  green: (text: string): string => style(32, text),
  yellow: (text: string): string => style(33, text),
  blue: (text: string): string => style(34, text),
  magenta: (text: string): string => style(35, text),
  cyan: (text: string): string => style(36, text),
};
