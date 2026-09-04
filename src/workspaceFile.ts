import * as fs from "fs";
import { parse as parseJsonc } from "jsonc-parser";
import * as path from "path";
import * as vscode from "vscode";
import { ownedKeys, type AgentFrame } from "./agentFrame";

/** Where the ignore entry for the workspace file goes, if anywhere. */
type IgnoreScope = "local" | "shared" | "none";

/**
 * A workspace file holding the folder it sits next to. VS Code writes workspace
 * settings into this file instead of .vscode/settings.json once the window is
 * opened through it, which is what keeps the frame colors out of the project.
 *
 * The folder's own settings come along for the ride. Opening through a
 * workspace file demotes .vscode/settings.json to folder settings, where only
 * resource-scoped entries still count, so anything else in it would quietly
 * stop applying. Copying the lot is safe rather than merely convenient: folder
 * settings outrank the workspace file, so every entry that does still count
 * keeps winning from the project's file and carries on following the project.
 */
function workspaceFileContents(settings: Record<string, unknown>): string {
  return `${JSON.stringify(
    { folders: [{ path: "." }], settings },
    undefined,
    2,
  )}\n`;
}

/**
 * The folder's settings, without the frame colors. Those are the one thing this
 * command is taking out of the project rather than carrying over.
 */
function settingsToCarry(root: string): Record<string, unknown> {
  const settings = readSettings(path.join(root, ".vscode", "settings.json"));
  const colors = settings["workbench.colorCustomizations"];

  if (isRecord(colors)) {
    const kept = Object.fromEntries(
      Object.entries(colors).filter(([key]) => !ownedKeys.includes(key)),
    );
    if (Object.keys(kept).length > 0) {
      settings["workbench.colorCustomizations"] = kept;
    } else {
      delete settings["workbench.colorCustomizations"];
    }
  }

  return settings;
}

/**
 * Moves the frame colors from the project's .vscode/settings.json into a
 * workspace file beside it. Both are workspace settings as far as the extension
 * is concerned, so nothing about the writing changes; only the file they land
 * in does, and that one can be ignored by Git without touching the project's
 * own settings.
 */
export async function useWorkspaceFile(frame: AgentFrame): Promise<void> {
  const current = vscode.workspace.workspaceFile;
  if (current) {
    void vscode.window.showInformationMessage(
      current.scheme === "untitled"
        ? "This window already uses a workspace, but it has not been saved to disk yet. Save it through File > Save Workspace As, and Agent Frame will write the colors there."
        : `This window is already open through ${path.basename(
            current.fsPath,
          )}, so Agent Frame writes the colors there rather than into .vscode/settings.json.`,
    );
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    void vscode.window.showInformationMessage(
      "Open a folder from disk first. A workspace file has to live next to the folder it holds.",
    );
    return;
  }

  const root = folder.uri.fsPath;
  const name = `${path.basename(root)}.code-workspace`;
  const target = path.join(root, name);
  const existed = fs.existsSync(target);

  const scope = await chooseIgnoreScope(root, name, existed);
  if (scope === undefined) {
    return;
  }

  const carried = existed ? {} : settingsToCarry(root);

  try {
    if (!existed) {
      fs.writeFileSync(target, workspaceFileContents(carried), "utf8");
    }
    applyIgnore(root, name, scope);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Agent Frame could not set up ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const count = Object.keys(carried).length;
  const reopen = "Reopen through workspace file";
  const choice = await vscode.window.showInformationMessage(
    `${name} is ready. Reopen the window through it?`,
    {
      modal: true,
      detail:
        (existed
          ? `${name} was already there and has been left as it is.\n\n`
          : count === 0
            ? "There was nothing in .vscode/settings.json to carry over.\n\n"
            : `The ${count} setting${
                count === 1 ? "" : "s"
              } in .vscode/settings.json came along, because opening through a workspace file stops some of them applying from there. The ones that still apply from the project keep doing so: folder settings outrank the workspace file.\n\n`) +
        "Agent Frame then writes the frame colors into the workspace file rather than .vscode/settings.json, and Git never sees them.\n\n" +
        "This window's terminals close with the reload, taking any agent running in them with it.",
    },
    reopen,
    "Later",
  );

  if (choice !== reopen) {
    return;
  }

  // Only on the way out. Until the window actually reopens the colors are still
  // doing their job from .vscode/settings.json, and clearing them early would
  // just have the next agent event write them straight back.
  await frame.releaseWorkspaceColors();

  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(target),
    false,
  );
}

async function chooseIgnoreScope(
  root: string,
  name: string,
  existed: boolean,
): Promise<IgnoreScope | undefined> {
  const git = path.join(root, ".git");
  if (!fs.existsSync(git)) {
    return "none";
  }

  // A worktree or submodule has .git as a file pointing elsewhere, and the
  // exclude file that governs it is not simply next to it, so only the shared
  // route is offered there.
  const hasLocalExclude = fs.statSync(git).isDirectory();

  interface Item extends vscode.QuickPickItem {
    scope: IgnoreScope;
  }

  const items: Item[] = [
    ...(hasLocalExclude
      ? [
          {
            label: "Keep it to this clone",
            detail: `Adds ${name} to .git/info/exclude, which is never committed.`,
            scope: "local" as const,
          },
        ]
      : []),
    {
      label: "Ignore it for the whole project",
      detail: `Adds ${name} to .gitignore, which is committed. Anyone running this command gets the same file name, so one line covers the team.`,
      scope: "shared",
    },
    {
      label: "Leave Git alone",
      detail: existed
        ? "Nothing is added to any ignore file."
        : `${name} stays visible to Git, so the colors can still end up in a commit.`,
      scope: "none",
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Keep ${name} out of Git?`,
    placeHolder: "The workspace file is where the frame colors will be written",
  });
  return picked?.scope;
}

function applyIgnore(root: string, name: string, scope: IgnoreScope): void {
  if (scope === "none") {
    return;
  }
  if (scope === "shared") {
    appendEntry(path.join(root, ".gitignore"), name);
    return;
  }

  const info = path.join(root, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  appendEntry(path.join(info, "exclude"), name);
}

/** Adds one line to an ignore file, leaving it alone when it is already there. */
function appendEntry(file: string, entry: string): void {
  let contents = "";
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    // The file does not exist yet, which append handles.
  }

  if (contents.split(/\r?\n/).some((line) => line.trim() === entry)) {
    return;
  }

  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${separator}${entry}\n`, "utf8");
}

interface DroppedSetting {
  key: string;
  value: unknown;
}

/**
 * Carries settings a folder asks for but is not getting into the workspace file.
 * The conversion command already brings them along, so this is the repair for a
 * workspace file written by hand, or one whose settings were pruned too far.
 */
export async function copyDroppedSettings(): Promise<void> {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (!workspaceFile || workspaceFile.scheme !== "file") {
    void vscode.window.showInformationMessage(
      "This window is open on a folder rather than through a workspace file, so its .vscode/settings.json is the workspace layer and nothing in it is being dropped. Run Agent Frame: Store Window Colors in a Workspace File first.",
    );
    return;
  }

  const dropped = droppedSettings();
  if (dropped.length === 0) {
    void vscode.window.showInformationMessage(
      `Every setting in .vscode/settings.json still reaches this window, so there is nothing to copy into ${path.basename(
        workspaceFile.fsPath,
      )}.`,
    );
    return;
  }

  interface Item extends vscode.QuickPickItem {
    setting: DroppedSetting;
  }

  const picked = await vscode.window.showQuickPick<Item>(
    dropped.map((setting) => ({
      label: setting.key,
      description: summarize(setting.value),
      picked: true,
      setting,
    })),
    {
      canPickMany: true,
      title: "Copy into the workspace file",
      placeHolder:
        "Leave out anything that should keep following the project instead",
    },
  );

  if (!picked) {
    return;
  }

  const configuration = vscode.workspace.getConfiguration();
  const failed: string[] = [];
  for (const { setting } of picked) {
    try {
      await configuration.update(
        setting.key,
        setting.value,
        vscode.ConfigurationTarget.Workspace,
      );
    } catch {
      failed.push(setting.key);
    }
  }

  if (failed.length > 0) {
    void vscode.window.showWarningMessage(
      `VS Code refused to write ${failed.join(", ")} to the workspace file.`,
    );
  }

  const copied = picked.length - failed.length;
  if (copied > 0) {
    void vscode.window.showInformationMessage(
      `Copied ${copied} setting${copied === 1 ? "" : "s"} into ${path.basename(
        workspaceFile.fsPath,
      )}.`,
    );
  }
}

/** The settings a folder asks for that are not reaching the window. */
function droppedSettings(): DroppedSetting[] {
  const dropped: DroppedSetting[] = [];
  const seen = new Set<string>();

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") {
      continue;
    }

    const raw = readSettings(
      path.join(folder.uri.fsPath, ".vscode", "settings.json"),
    );
    const configuration = vscode.workspace.getConfiguration(
      undefined,
      folder.uri,
    );

    for (const [key, value] of Object.entries(raw)) {
      // A "[language]" block is language-overridable, which folder settings are
      // allowed to carry, so it is never among the casualties.
      if (key.startsWith("[") || seen.has(key)) {
        continue;
      }
      // Nothing registers this setting, so no extension is reading it either
      // and moving it would only make the workspace file harder to read.
      if (!configuration.has(key)) {
        continue;
      }
      if (applies(configuration.get(key), value)) {
        continue;
      }
      seen.add(key);
      dropped.push({ key, value });
    }
  }

  return dropped;
}

function readSettings(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }

  // Settings files are JSON with comments and trailing commas, which is why
  // this does not go through JSON.parse.
  const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true });
  return isRecord(parsed) ? parsed : {};
}

/**
 * Whether a value a settings file asks for is the one in force. Object settings
 * are merged across layers rather than replaced, so an effective value only has
 * to contain what was asked for; everything else has to match outright.
 */
function applies(effective: unknown, wanted: unknown): boolean {
  if (isRecord(wanted)) {
    return (
      isRecord(effective) &&
      Object.entries(wanted).every(([key, value]) =>
        applies(effective[key], value),
      )
    );
  }
  return JSON.stringify(effective) === JSON.stringify(wanted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A one-line preview of a setting's value for the picker. */
function summarize(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 60 ? `${text.slice(0, 59)}\u2026` : text;
}
