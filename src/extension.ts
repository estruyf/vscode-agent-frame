import * as vscode from "vscode";
import {
  AgentFrame,
  isProviderAgentState,
  type AgentUpdate,
} from "./agentFrame";
import {
  ClaudeWatcher,
  areHooksInstalled,
  areOwnHooksPresent,
  claudeProvider,
  installHooks,
  uninstallHooks,
} from "./claude";
import { TerminalWatcher, copilotProvider } from "./copilot";
import {
  CopilotChatWatcher,
  areCopilotHooksInstalled,
  areOwnCopilotHooksPresent,
  copilotChatProvider,
  installCopilotHooks,
  uninstallCopilotHooks,
} from "./copilotChat";
import { previewColors } from "./preview";

function claudeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentFrame")
    .get<boolean>("claude.enabled", true);
}

function copilotChatEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentFrame")
    .get<boolean>("copilotChat.enabled", true);
}

function terminalEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentFrame")
    .get<boolean>("terminal.enabled", true);
}

/** One agent whose hooks live in a file the user owns. */
interface Integration {
  readonly label: string;
  readonly file: string;
  install(): void;
  isInstalled(): boolean;
  areOwnHooksPresent(): boolean;
}

const integrations: Record<"claude" | "copilotChat", Integration> = {
  claude: {
    label: "Claude Code",
    file: "~/.claude/settings.json",
    install: installHooks,
    isInstalled: areHooksInstalled,
    areOwnHooksPresent,
  },
  copilotChat: {
    label: "GitHub Copilot Chat",
    file: "~/.copilot/hooks/agent-frame.json",
    install: installCopilotHooks,
    isInstalled: areCopilotHooksInstalled,
    areOwnHooksPresent: areOwnCopilotHooksPresent,
  },
};

function reportInstallFailure(integration: Integration, error: unknown): void {
  void vscode.window.showErrorMessage(
    `Agent Frame could not write ${integration.file}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/**
 * Both agents report state through hooks in a file the user owns, so the first
 * run asks before touching one. Hooks from an older version of the extension
 * are rewritten in place instead: the user agreed to them once, and only our
 * own entries change. Asking is kept for the case where there is nothing of
 * ours in the file yet.
 */
async function ensureHooks(context: vscode.ExtensionContext): Promise<void> {
  const wanted = [
    ...(claudeEnabled() ? [integrations.claude] : []),
    ...(copilotChatEnabled() ? [integrations.copilotChat] : []),
  ];

  const pending: Integration[] = [];
  for (const integration of wanted) {
    if (integration.isInstalled()) {
      continue;
    }
    if (integration.areOwnHooksPresent()) {
      try {
        integration.install();
        continue;
      } catch {
        // Falls through to the prompt, which reports the failure itself.
      }
    }
    pending.push(integration);
  }

  if (pending.length === 0) {
    return;
  }

  const declinedKey = "agentFrame.hookInstallDeclined";
  if (context.globalState.get<boolean>(declinedKey)) {
    return;
  }

  const install = "Install hooks";
  const notNow = "Not now";
  const never = "Never ask again";
  const agents = pending.map((one) => one.label).join(" and ");
  const files = pending.map((one) => one.file).join(" and ");
  const choice = await vscode.window.showInformationMessage(
    `Agent Frame can colour the window while ${agents} is working. This adds hooks to ${files}.`,
    install,
    notNow,
    never,
  );

  if (choice === never) {
    await context.globalState.update(declinedKey, true);
    return;
  }
  if (choice !== install) {
    return;
  }

  for (const integration of pending) {
    try {
      integration.install();
    } catch (error) {
      reportInstallFailure(integration, error);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const frame = new AgentFrame(context.workspaceState);
  const claudeWatcher = new ClaudeWatcher(frame);
  const copilotChatWatcher = new CopilotChatWatcher(frame);
  const terminalWatcher = new TerminalWatcher(frame);

  const applyEnablement = () => {
    if (claudeEnabled()) {
      claudeWatcher.start();
    } else {
      claudeWatcher.dispose();
      void frame.removeProvider(claudeProvider);
    }

    if (copilotChatEnabled()) {
      copilotChatWatcher.start();
    } else {
      copilotChatWatcher.dispose();
      void frame.removeProvider(copilotChatProvider);
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
    copilotChatWatcher,
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
          reportInstallFailure(integrations.claude, error);
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
          reportInstallFailure(integrations.claude, error);
          return;
        }
        await frame.removeProvider(claudeProvider);
        void vscode.window.showInformationMessage(
          "Agent Frame hooks removed from ~/.claude/settings.json.",
        );
      },
    ),
    vscode.commands.registerCommand(
      "vscode-agent-frame.installCopilotHooks",
      async () => {
        try {
          installCopilotHooks();
        } catch (error) {
          reportInstallFailure(integrations.copilotChat, error);
          return;
        }
        void vscode.window.showInformationMessage(
          "Agent Frame hooks installed. Copilot Chat sessions started from now on will drive the window colour.",
        );
      },
    ),
    vscode.commands.registerCommand(
      "vscode-agent-frame.uninstallCopilotHooks",
      async () => {
        try {
          uninstallCopilotHooks();
        } catch (error) {
          reportInstallFailure(integrations.copilotChat, error);
          return;
        }
        await frame.removeProvider(copilotChatProvider);
        void vscode.window.showInformationMessage(
          "Agent Frame hooks removed from ~/.copilot/hooks/agent-frame.json.",
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
        event.affectsConfiguration("agentFrame.copilotChat.enabled") ||
        event.affectsConfiguration("agentFrame.terminal.enabled")
      ) {
        applyEnablement();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void claudeWatcher.scan();
    }),
  );

  void ensureHooks(context);
}

export function deactivate(): void {}
