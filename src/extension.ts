import * as vscode from "vscode";
import {
  AgentFrame,
  isProviderAgentState,
  type AgentUpdate,
} from "./agentFrame";
import {
  ClaudeWatcher,
  areHooksInstalled,
  claudeProvider,
  installHooks,
  uninstallHooks,
} from "./claude";
import { TerminalWatcher, copilotProvider } from "./copilot";
import { previewColors } from "./preview";

function claudeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentFrame")
    .get<boolean>("claude.enabled", true);
}

function terminalEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentFrame")
    .get<boolean>("terminal.enabled", true);
}

/**
 * Claude reports state through hooks in ~/.claude/settings.json, so the first
 * run asks before touching a file the user owns.
 */
async function offerHookInstall(context: vscode.ExtensionContext): Promise<void> {
  const declinedKey = "agentFrame.hookInstallDeclined";
  if (context.globalState.get<boolean>(declinedKey) || areHooksInstalled()) {
    return;
  }

  const install = "Install hooks";
  const notNow = "Not now";
  const never = "Never ask again";
  const choice = await vscode.window.showInformationMessage(
    "Agent Frame can colour the window while Claude Code is working. This adds hooks to ~/.claude/settings.json.",
    install,
    notNow,
    never,
  );

  if (choice === install) {
    await vscode.commands.executeCommand("vscode-agent-frame.installClaudeHooks");
  } else if (choice === never) {
    await context.globalState.update(declinedKey, true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const frame = new AgentFrame(context.workspaceState);
  const claudeWatcher = new ClaudeWatcher(frame);
  const terminalWatcher = new TerminalWatcher(frame);

  const applyEnablement = () => {
    if (claudeEnabled()) {
      claudeWatcher.start();
    } else {
      claudeWatcher.dispose();
      void frame.removeProvider(claudeProvider);
    }

    if (terminalEnabled()) {
      terminalWatcher.start();
    } else {
      terminalWatcher.dispose();
      void frame.removeProvider(copilotProvider);
    }
  };

  applyEnablement();

  context.subscriptions.push(
    claudeWatcher,
    terminalWatcher,
    vscode.commands.registerCommand(
      "vscode-agent-frame.setAgentState",
      async (update: AgentUpdate) => {
        if (
          !update?.id ||
          !update.provider ||
          !isProviderAgentState(update.state)
        ) {
          throw new Error(
            "Expected { id, provider, state }; state must be busy, running, working, waiting, idle, or completed.",
          );
        }
        await frame.updateAgent(update);
      },
    ),
    vscode.commands.registerCommand(
      "vscode-agent-frame.clearAgentState",
      async (provider: string, id: string) => {
        await frame.removeAgent(provider, id);
      },
    ),
    vscode.commands.registerCommand("vscode-agent-frame.resetAgentStates", () =>
      frame.reset(),
    ),
    vscode.commands.registerCommand(
      "vscode-agent-frame.installClaudeHooks",
      async () => {
        try {
          installHooks();
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Agent Frame could not write ~/.claude/settings.json: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        void vscode.window.showInformationMessage(
          "Agent Frame hooks installed. Claude Code sessions started from now on will drive the window colour.",
        );
      },
    ),
    vscode.commands.registerCommand(
      "vscode-agent-frame.uninstallClaudeHooks",
      async () => {
        try {
          uninstallHooks();
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Agent Frame could not write ~/.claude/settings.json: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        await frame.removeProvider(claudeProvider);
        void vscode.window.showInformationMessage(
          "Agent Frame hooks removed from ~/.claude/settings.json.",
        );
      },
    ),
    vscode.commands.registerCommand("vscode-agent-frame.previewColors", () =>
      previewColors(frame),
    ),
    vscode.window.onDidChangeActiveColorTheme(() => {
      frame.invalidateTheme();
      void frame.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("agentFrame.colors") ||
        event.affectsConfiguration("agentFrame.theme")
      ) {
        frame.invalidateTheme();
        void frame.refresh();
      }
      if (event.affectsConfiguration("workbench.colorTheme")) {
        frame.invalidateTheme();
        void frame.refresh();
      }
      if (
        event.affectsConfiguration("agentFrame.claude.enabled") ||
        event.affectsConfiguration("agentFrame.terminal.enabled")
      ) {
        applyEnablement();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void claudeWatcher.scan();
    }),
  );

  if (claudeEnabled()) {
    void offerHookInstall(context);
  }
}

export function deactivate(): void {}
