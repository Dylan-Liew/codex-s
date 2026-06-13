import process from "node:process";

const COLORS_ENABLED = process.stdout.isTTY && !Object.hasOwn(process.env, "NO_COLOR");

export function styleMuted(text: string): string {
  if (!COLORS_ENABLED) {
    return text;
  }

  return `\u001b[2m${text}\u001b[0m`;
}

export function styleStrong(text: string): string {
  if (!COLORS_ENABLED) {
    return text;
  }

  return `\u001b[1m${text}\u001b[0m`;
}

export function sanitizeInline(value: unknown): string {
  return String(value ?? "").replace(/[\t\n\r]+/g, " ");
}
