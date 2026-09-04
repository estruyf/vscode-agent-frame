import * as vscode from "vscode";
import type { AgentFrame } from "./agentFrame";

export const copilotProvider = "copilot-cli";

/** Extracts the executable name from a command line, ignoring env prefixes. */
function leadingCommand(commandLine: string): string | undefined {
  for (const token of commandLine.trim().split(/\s+/)) {
    if (token.includes("=")) {
      continue; // FOO=bar style prefix
    }
    const name = token.split(/[\\/]/).pop();
    return name?.toLowerCase();
  }
  return undefined;
}

/**
 * Tracks agent CLIs launched in the integrated terminal. VS Code reports when a
 * shell command starts and ends, which is enough for busy/idle but cannot see
 * inside a long-running interactive session.
 */
export class TerminalWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly active = new Map<vscode.TerminalShellExecution, string>();
  private counter = 0;

  constructor(private readonly frame: AgentFrame) {}

  public start(): void {
    if (this.disposables.length > 0) {
      return;
    }

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const name = leadingCommand(event.execution.commandLine.value);
        if (!name || !this.commands().includes(name)) {
          return;
        }

        const id = `${event.terminal.name}#${++this.counter}`;
        this.active.set(event.execution, id);
        void this.frame.updateAgent({
          provider: copilotProvider,
          id,
          state: "busy",
        });
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const id = this.active.get(event.execution);
        if (!id) {
          return;
        }
        this.active.delete(event.execution);
        void this.frame.removeAgent(copilotProvider, id);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [execution, id] of [...this.active]) {
          if (id.startsWith(`${terminal.name}#`)) {
            this.active.delete(execution);
            void this.frame.removeAgent(copilotProvider, id);
          }
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.active.clear();
  }

  private commands(): string[] {
    return vscode.workspace
      .getConfiguration("agentFrame")
      .get<string[]>("terminal.commands", [])
      .map((command) => command.toLowerCase());
  }
}
