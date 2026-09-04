import * as vscode from "vscode";
import type { AgentFrame, AgentState } from "./agentFrame";

const states: AgentState[] = ["busy", "waiting", "idle"];

interface StateItem extends vscode.QuickPickItem {
  state: AgentState;
}

interface ActionItem extends vscode.QuickPickItem {
  action: "hex" | "themeColor" | "settings";
}

interface ThemeColorItem extends vscode.QuickPickItem {
  id: string;
  value: string;
}

/**
 * Runs a quick pick whose highlighted item is shown on the window frame, and
 * restores the real state once the user is done.
 */
async function pickWithPreview<T extends vscode.QuickPickItem>(
  frame: AgentFrame,
  items: T[],
  options: { title: string; placeholder: string; colorOf: (item: T) => string | undefined },
): Promise<T | undefined> {
  const quickPick = vscode.window.createQuickPick<T>();
  quickPick.title = options.title;
  quickPick.placeholder = options.placeholder;
  quickPick.matchOnDescription = true;
  quickPick.items = items;

  try {
    return await new Promise<T | undefined>((resolve) => {
      let accepted: T | undefined;

      quickPick.onDidChangeActive((active) => {
        void frame.preview(active[0] ? options.colorOf(active[0]) : undefined);
      });
      quickPick.onDidAccept(() => {
        accepted = quickPick.selectedItems[0];
        quickPick.hide();
      });
      quickPick.onDidHide(() => resolve(accepted));

      quickPick.show();
      // show() does not fire onDidChangeActive for the initial selection.
      if (items[0]) {
        void frame.preview(options.colorOf(items[0]));
      }
    });
  } finally {
    quickPick.dispose();
  }
}

/**
 * Updates a setting where it is already defined, so an existing workspace
 * override keeps winning. Otherwise these are user preferences and belong in
 * the global scope rather than in every project's .vscode/settings.json.
 */
function configurationTarget(key: string): vscode.ConfigurationTarget {
  const inspected = vscode.workspace
    .getConfiguration("agentFrame")
    .inspect(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

async function chooseHex(
  frame: AgentFrame,
  state: AgentState,
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("agentFrame");
  const current = configuration.get<string>(`colors.${state}`) ?? "";

  const value = await new Promise<string | undefined>((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = `Agent Frame: ${state} color`;
    input.value = current;
    input.prompt = "Hex color, for example #2E7D32";
    let accepted: string | undefined;

    input.onDidChangeValue((next) => {
      if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(next.trim())) {
        input.validationMessage = undefined;
        void frame.preview(next.trim());
      } else {
        input.validationMessage = next.trim()
          ? "Expected a hex color such as #2E7D32."
          : undefined;
      }
    });
    input.onDidAccept(() => {
      const next = input.value.trim();
      if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(next)) {
        input.validationMessage = "Expected a hex color such as #2E7D32.";
        return;
      }
      accepted = next;
      input.hide();
    });
    input.onDidHide(() => {
      resolve(accepted);
      input.dispose();
    });
    input.show();
  });

  if (!value) {
    return;
  }

  await configuration.update(
    `colors.${state}`,
    value,
    configurationTarget(`colors.${state}`),
  );
  // A hex color only takes effect when the source is not the theme.
  if (configuration.get<string>("colors.source", "custom") === "theme") {
    const useCustom = "Switch to custom colors";
    const choice = await vscode.window.showInformationMessage(
      `Saved, but agentFrame.colors.source is "theme", so ${state} still resolves from the theme.`,
      useCustom,
    );
    if (choice === useCustom) {
      await configuration.update(
        "colors.source",
        "custom",
        configurationTarget("colors.source"),
      );
    }
  }
}

async function chooseThemeColor(
  frame: AgentFrame,
  state: AgentState,
): Promise<void> {
  const items: ThemeColorItem[] = frame
    .themeColorIds()
    .map((id) => ({ id, value: frame.themeColorValue(id) ?? "", label: id }))
    .filter((item) => item.value)
    .map((item) => ({ ...item, description: item.value }));

  if (items.length === 0) {
    void vscode.window.showWarningMessage(
      "Agent Frame could not read any colors from the active theme.",
    );
    return;
  }

  const picked = await pickWithPreview(frame, items, {
    title: `Agent Frame: theme color for ${state}`,
    placeholder: "Type to filter, arrow keys to preview",
    colorOf: (item) => item.value,
  });

  if (!picked) {
    return;
  }

  const configuration = vscode.workspace.getConfiguration("agentFrame");
  const existing = configuration.get<string[]>(`theme.${state}`, []);
  await configuration.update(
    `theme.${state}`,
    [picked.id, ...existing.filter((id) => id !== picked.id)],
    configurationTarget(`theme.${state}`),
  );
  if (configuration.get<string>("colors.source", "custom") !== "theme") {
    await configuration.update(
      "colors.source",
      "theme",
      configurationTarget("colors.source"),
    );
  }
}

/** The `Agent Frame: Preview State Colors` command. */
export async function previewColors(frame: AgentFrame): Promise<void> {
  frame.invalidateTheme();
  const source = vscode.workspace
    .getConfiguration("agentFrame")
    .get<string>("colors.source", "custom");

  const items: StateItem[] = states.map((state) => ({
    state,
    label: state,
    description: frame.colorForState(state) ?? "(unresolved)",
  }));

  try {
    const state = await pickWithPreview(frame, items, {
      title: `Agent Frame colors (source: ${source})`,
      placeholder: "Arrow keys preview each state, Enter to change one",
      colorOf: (item) => frame.colorForState(item.state),
    });

    if (!state) {
      return;
    }

    const actions: ActionItem[] = [
      {
        action: "hex",
        label: "$(paintcan) Enter a hex color",
        description: `sets agentFrame.colors.${state.state}`,
      },
      {
        action: "themeColor",
        label: "$(symbol-color) Choose a color from the theme",
        description: `sets agentFrame.theme.${state.state}`,
      },
      {
        action: "settings",
        label: "$(gear) Open in Settings",
        description: "edit every Agent Frame setting",
      },
    ];

    const action = await vscode.window.showQuickPick(actions, {
      title: `Agent Frame: ${state.state}`,
      placeHolder: `Currently ${frame.colorForState(state.state) ?? "unresolved"}`,
    });

    if (action?.action === "hex") {
      await chooseHex(frame, state.state);
    } else if (action?.action === "themeColor") {
      await chooseThemeColor(frame, state.state);
    } else if (action?.action === "settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "agentFrame",
      );
    }
  } finally {
    frame.invalidateTheme();
    await frame.preview(undefined);
  }
}
