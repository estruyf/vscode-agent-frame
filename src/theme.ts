import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Colors a theme leaves undefined fall through to these. */
const includeDepthLimit = 10;

interface ThemeContribution {
  id?: string;
  label?: string;
  path: string;
}

/** Tolerates the comments and trailing commas some published themes contain. */
function parseThemeJson(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Fall through to the lenient pass.
  }

  const withoutComments = raw
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, (match) =>
      match.startsWith('"') ? match : " ",
    )
    .replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(withoutComments) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Resolves a `%key%` label through the extension's English nls bundle. */
function resolveLabel(extensionPath: string, label: string | undefined): string | undefined {
  if (!label || !label.startsWith("%") || !label.endsWith("%")) {
    return label;
  }

  const bundle = parseThemeJson(
    (() => {
      try {
        return fs.readFileSync(path.join(extensionPath, "package.nls.json"), "utf8");
      } catch {
        return "";
      }
    })(),
  );
  const value = bundle?.[label.slice(1, -1)];
  return typeof value === "string" ? value : label;
}

function findTheme(
  name: string,
): { extensionPath: string; themePath: string } | undefined {
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON?.contributes?.themes as
      | ThemeContribution[]
      | undefined;
    if (!Array.isArray(themes)) {
      continue;
    }

    for (const theme of themes) {
      if (
        theme.id === name ||
        theme.label === name ||
        resolveLabel(extension.extensionPath, theme.label) === name
      ) {
        return {
          extensionPath: extension.extensionPath,
          themePath: path.join(extension.extensionPath, theme.path),
        };
      }
    }
  }
  return undefined;
}

/** Walks the `include` chain, with a base theme's colors overridden by its child. */
function readThemeColors(themePath: string, depth = 0): Record<string, string> {
  if (depth > includeDepthLimit) {
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(themePath, "utf8");
  } catch {
    return {};
  }

  const theme = parseThemeJson(raw);
  if (!theme) {
    return {};
  }

  const inherited =
    typeof theme.include === "string"
      ? readThemeColors(
          path.resolve(path.dirname(themePath), theme.include),
          depth + 1,
        )
      : {};

  const own = theme.colors;
  const colors: Record<string, string> = { ...inherited };
  if (own && typeof own === "object") {
    for (const [key, value] of Object.entries(own)) {
      if (typeof value === "string") {
        colors[key] = value;
      }
    }
  }
  return colors;
}

/**
 * The colors of the active theme, with the user's own colorCustomizations
 * layered on top. Keys owned by this extension are skipped so that the frame
 * never derives its next color from the color it just applied.
 */
export function activeThemeColors(ownedKeys: string[]): Record<string, string> {
  const name = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme");
  const located = name ? findTheme(name) : undefined;
  const colors = located ? readThemeColors(located.themePath) : {};

  const inspected = vscode.workspace
    .getConfiguration("workbench")
    .inspect<Record<string, unknown>>("colorCustomizations");

  for (const layer of [inspected?.globalValue, inspected?.workspaceValue]) {
    if (!layer || typeof layer !== "object") {
      continue;
    }

    // Flat entries apply to every theme; a "[Theme Name]" block only to this one.
    const scoped = name ? layer[`[${name}]`] : undefined;
    for (const source of [layer, scoped]) {
      if (!source || typeof source !== "object") {
        continue;
      }
      for (const [key, value] of Object.entries(source)) {
        if (
          typeof value === "string" &&
          !key.startsWith("[") &&
          !ownedKeys.includes(key)
        ) {
          colors[key] = value;
        }
      }
    }
  }

  return colors;
}

/** Drops the alpha channel and expands shorthand, returning `#rrggbb`. */
function toOpaqueHex(color: string): string | undefined {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!match) {
    return undefined;
  }

  const digits = match[1];
  if (digits.length <= 4) {
    return `#${digits
      .slice(0, 3)
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  }
  return `#${digits.slice(0, 6)}`;
}

/** Picks the first theme color that the active theme actually defines. */
export function resolveThemeColor(
  candidates: string[],
  colors: Record<string, string>,
): string | undefined {
  for (const candidate of candidates) {
    const value = colors[candidate];
    if (typeof value === "string" && toOpaqueHex(value)) {
      return value;
    }
  }
  return undefined;
}

function channels(color: string): [number, number, number] | undefined {
  const hex = toOpaqueHex(color);
  if (!hex) {
    return undefined;
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Alpha-composites `color` over `backdrop`. Colors without alpha pass through. */
export function composite(color: string, backdrop: string): string {
  const alphaDigits = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(color.trim());
  const top = channels(color);
  const bottom = channels(backdrop);
  if (!alphaDigits || !top || !bottom) {
    return color;
  }

  const raw = alphaDigits[1];
  const alpha =
    raw.length === 4
      ? parseInt(raw[3] + raw[3], 16) / 255
      : parseInt(raw.slice(6, 8), 16) / 255;

  const blended = top.map((value, index) =>
    Math.round(value * alpha + bottom[index] * (1 - alpha)),
  );
  return `#${blended
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG relative luminance, used to choose a readable foreground. */
function luminance(color: string): number | undefined {
  const rgb = channels(color);
  if (!rgb) {
    return undefined;
  }

  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Black or white, whichever contrasts more with the given background. */
export function readableForeground(background: string): string | undefined {
  const value = luminance(background);
  if (value === undefined) {
    return undefined;
  }

  const withWhite = 1.05 / (value + 0.05);
  const withBlack = (value + 0.05) / 0.05;
  return withWhite >= withBlack ? "#FFFFFF" : "#000000";
}
