import * as vscode from "vscode";
import {
  activeThemeColors,
  composite,
  readableForeground,
  resolveThemeColor,
} from "./theme";

export type AgentState = "busy" | "waiting" | "idle";
export type ProviderAgentState =
  | AgentState
  | "running"
  | "working"
  | "completed";

export interface AgentUpdate {
  id: string;
  provider: string;
  state: ProviderAgentState;
}

const statePriority: Record<AgentState, number> = {
  busy: 3,
  waiting: 2,
  idle: 1,
};

interface FrameColorKey {
  key: string;
  /** Alpha applied to the state color, as a fraction between 0 and 1. */
  opacity?: number;
  /** Paired foreground, set to black or white for contrast when enabled. */
  foregroundKey?: string;
}

const frameColorKeys: FrameColorKey[] = [
  { key: "window.activeBorder" },
  {
    key: "titleBar.activeBackground",
    foregroundKey: "titleBar.activeForeground",
  },
  {
    key: "titleBar.inactiveBackground",
    opacity: 0.6,
    foregroundKey: "titleBar.inactiveForeground",
  },
  { key: "statusBar.background", foregroundKey: "statusBar.foreground" },
];

/** Every key the extension may write, needed to keep theme reads uncontaminated. */
const ownedKeys = frameColorKeys.flatMap(({ key, foregroundKey }) =>
  foregroundKey ? [key, foregroundKey] : [key],
);

/** Theme color ids tried in order when the color source is the theme. */
const defaultThemeCandidates: Record<AgentState, string[]> = {
  busy: [
    "terminal.ansiGreen",
    "gitDecoration.addedResourceForeground",
    "editorGutter.addedBackground",
    "charts.green",
  ],
  waiting: [
    "terminal.ansiYellow",
    "notificationsWarningIcon.foreground",
    "editorWarning.foreground",
    "statusBarItem.warningBackground",
    "problemsWarningIcon.foreground",
    "charts.yellow",
  ],
  idle: [
    "terminal.ansiBlue",
    "statusBarItem.remoteBackground",
    "activityBarBadge.background",
    "focusBorder",
  ],
};

/** Keys this extension owns, remembered across window reloads. */
const appliedColorsKey = "agentFrame.appliedColors";

export function withOpacity(color: string, opacity?: number): string {
  if (opacity === undefined) {
    return color;
  }

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!hex) {
    return color;
  }

  const digits = hex[1];
  const shorthand = digits.length <= 4;
  const rgb = shorthand
    ? digits
        .slice(0, 3)
        .split("")
        .map((digit) => digit + digit)
        .join("")
    : digits.slice(0, 6);
  const existingAlpha =
    digits.length === 4
      ? parseInt(digits[3] + digits[3], 16) / 255
      : digits.length === 8
        ? parseInt(digits.slice(6, 8), 16) / 255
        : 1;
  const alpha = Math.round(
    Math.min(Math.max(existingAlpha * opacity, 0), 1) * 255,
  );

  return `#${rgb}${alpha.toString(16).padStart(2, "0")}`;
}

export function normalizeState(state: ProviderAgentState): AgentState {
  switch (state) {
    case "running":
    case "working":
      return "busy";
    case "completed":
      return "idle";
    default:
      return state;
  }
}

export function isProviderAgentState(
  state: unknown,
): state is ProviderAgentState {
  return (
    typeof state === "string" &&
    ["busy", "running", "working", "waiting", "idle", "completed"].includes(
      state,
    )
  );
}

/** Shallow comparison, used to leave the settings file alone when nothing moved. */
function sameColors(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

export class AgentFrame {
  private readonly agents = new Map<string, AgentState>();
  private appliedColors: Record<string, string>;
  private cachedThemeColors: Record<string, string> | undefined;
  /** Set while the user is previewing, overriding the tracked agent state. */
  private previewColor: string | undefined;
  /**
   * Refreshes read the settings file, change it, and write it back. Running two
   * of those at once lets a stale read undo the write before it, which shows up
   * as the frame blinking off and on, so they are chained instead.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {
    this.appliedColors =
      memento.get<Record<string, string>>(appliedColorsKey) ?? {};
  }

  public async updateAgent(update: AgentUpdate): Promise<void> {
    const key = `${update.provider}:${update.id}`;
    const state = normalizeState(update.state);
    if (this.agents.get(key) === state) {
      return;
    }
    this.agents.set(key, state);
    await this.refresh();
  }

  public async removeAgent(provider: string, id: string): Promise<void> {
    if (!this.agents.delete(`${provider}:${id}`)) {
      return;
    }
    await this.refresh();
  }

  /**
   * Replaces every agent of one provider at once. A watcher that rescans all of
   * its sessions repaints the frame a single time this way, rather than once
   * per session with the frame briefly unset in between.
   */
  public async syncProvider(
    provider: string,
    states: ReadonlyMap<string, AgentState>,
  ): Promise<void> {
    const prefix = `${provider}:`;
    let changed = false;

    for (const key of [...this.agents.keys()]) {
      if (key.startsWith(prefix) && !states.has(key.slice(prefix.length))) {
        this.agents.delete(key);
        changed = true;
      }
    }

    for (const [id, state] of states) {
      const key = `${prefix}${id}`;
      if (this.agents.get(key) !== state) {
        this.agents.set(key, state);
        changed = true;
      }
    }

    if (changed) {
      await this.refresh();
    }
  }

  /** Drops every agent for one provider, used when a source is disabled. */
  public async removeProvider(provider: string): Promise<void> {
    const prefix = `${provider}:`;
    let changed = false;
    for (const key of [...this.agents.keys()]) {
      if (key.startsWith(prefix)) {
        this.agents.delete(key);
        changed = true;
      }
    }
    if (changed) {
      await this.refresh();
    }
  }

  public async reset(): Promise<void> {
    if (this.agents.size === 0) {
      return;
    }
    this.agents.clear();
    await this.refresh();
  }

  public refresh(): Promise<void> {
    this.queue = this.queue.then(
      () => this.apply(),
      () => this.apply(),
    );
    return this.queue;
  }

  private async apply(): Promise<void> {
    const activeState = this.getActiveState();
    const color =
      this.previewColor ??
      (activeState ? this.colorForState(activeState) : undefined);
    const workbench = vscode.workspace.getConfiguration("workbench");
    // Only the workspace layer is ours to rewrite. Reading the merged value
    // here would copy the user's own customizations into .vscode/settings.json.
    const existing =
      workbench.inspect<Record<string, string>>("colorCustomizations")
        ?.workspaceValue ?? {};
    const next = { ...existing };

    for (const key of ownedKeys) {
      if (next[key] === this.appliedColors[key]) {
        delete next[key];
      }
    }

    const applied: Record<string, string> = {};
    if (color) {
      const autoForeground = vscode.workspace
        .getConfiguration("agentFrame")
        .get<boolean>("colors.autoForeground", true);
      const backdrop = this.backdrop();

      for (const { key, opacity, foregroundKey } of frameColorKeys) {
        const frameColor = withOpacity(color, opacity);
        next[key] = frameColor;
        applied[key] = frameColor;

        if (!autoForeground || !foregroundKey) {
          continue;
        }
        // A translucent bar blends into the window, so judge contrast against
        // the color that will actually be on screen.
        const effective = opacity ? composite(frameColor, backdrop) : frameColor;
        const foreground = readableForeground(effective);
        if (foreground) {
          next[foregroundKey] = foreground;
          applied[foregroundKey] = foreground;
        }
      }
    }

    if (!sameColors(applied, this.appliedColors)) {
      this.appliedColors = applied;
      await this.memento.update(appliedColorsKey, applied);
    }

    // Rewriting the same colors still makes the workbench re-apply them, which
    // reads as a flicker, so only write when the value actually differs.
    if (sameColors(next, existing)) {
      return;
    }

    await workbench.update(
      "colorCustomizations",
      Object.keys(next).length > 0 ? next : undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  }

  /** Resolves one state to a concrete color, honouring the configured source. */
  public colorForState(state: AgentState): string | undefined {
    const configuration = vscode.workspace.getConfiguration("agentFrame");
    const fallback = configuration.get<string>(`colors.${state}`);

    if (configuration.get<string>("colors.source", "custom") !== "theme") {
      return fallback;
    }

    const candidates = configuration.get<string[]>(
      `theme.${state}`,
      defaultThemeCandidates[state],
    );
    return resolveThemeColor(candidates, this.themeColors()) ?? fallback;
  }

  /** What a translucent frame color sits on top of. */
  private backdrop(): string {
    const colors = this.themeColors();
    return (
      colors["titleBar.inactiveBackground"] ??
      colors["titleBar.activeBackground"] ??
      colors["editor.background"] ??
      (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
        ? "#FFFFFF"
        : "#1E1E1E")
    );
  }

  private themeColors(): Record<string, string> {
    this.cachedThemeColors ??= activeThemeColors(ownedKeys);
    return this.cachedThemeColors;
  }

  /**
   * Shows `color` on the frame without touching the tracked agents. Passing
   * undefined drops back to whatever the agents actually say.
   */
  public async preview(color: string | undefined): Promise<void> {
    if (this.previewColor === color) {
      return;
    }
    this.previewColor = color;
    await this.refresh();
  }

  /** Every color id the active theme defines, for the theme color picker. */
  public themeColorIds(): string[] {
    return Object.keys(this.themeColors()).sort();
  }

  /** Looks one color id up in the active theme. */
  public themeColorValue(id: string): string | undefined {
    return this.themeColors()[id];
  }

  /** Called when the theme or the user's customizations change. */
  public invalidateTheme(): void {
    this.cachedThemeColors = undefined;
  }

  private getActiveState(): AgentState | undefined {
    return [...this.agents.values()].sort(
      (left, right) => statePriority[right] - statePriority[left],
    )[0];
  }
}
