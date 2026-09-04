import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { AgentFrame, AgentState } from "./agentFrame";
import {
  HookPayload,
  SessionSource,
  SessionWatcher,
  readJsonFile,
  stateDirectory,
} from "./sessions";

export const claudeProvider = "claude-code";

/** Hook payloads land here, one file per session, named by session id. */
export const sessionsDirectory = path.join(stateDirectory, "sessions");

const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");

/** Identifies hooks this extension owns, so installs stay idempotent. */
const hookMarker = "AGENT_FRAME_HOOK";

const shellPrelude =
  `${hookMarker}=1; d=$(cat); ` +
  `i=$(printf '%s' "$d" | grep -o '"session_id":"[^"]*"' | head -1 | ` +
  `cut -d'"' -f4 | tr -cd 'A-Za-z0-9_-'); `;

const deleteCommand =
  shellPrelude +
  `if [ -n "$i" ]; then rm -f "$HOME/.agent-frame/sessions/$i.json"; fi; exit 0`;

/**
 * Only the identity fields are ever read back, and a tool event carries its
 * whole input and response, which can run to megabytes, so every hook re-emits
 * those fields instead of its payload. `$PPID` is the Claude process that ran
 * the hook: a session whose process is gone had its window closed without
 * SessionEnd ever firing, which is how the watcher recognises it.
 */
function writeCommand(event: string): string {
  return (
    shellPrelude +
    `c=$(printf '%s' "$d" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4); ` +
    `if [ -n "$i" ] && [ -n "$c" ]; then m="$HOME/.agent-frame/sessions"; ` +
    `mkdir -p "$m"; ` +
    `printf '{"session_id":"%s","cwd":"%s","hook_event_name":"${event}","pid":%s}' ` +
    `"$i" "$c" "$PPID" > "$m/$i.tmp" && mv -f "$m/$i.tmp" "$m/$i.json"; fi; exit 0`
  );
}

/** Hook events we register, and the command each one runs. */
const hookEvents: Record<string, string> = {
  SessionStart: writeCommand("SessionStart"),
  UserPromptSubmit: writeCommand("UserPromptSubmit"),
  Notification: writeCommand("Notification"),
  PermissionRequest: writeCommand("PermissionRequest"),
  // Bracket the permission prompt: PreToolUse lands before it, PostToolUse
  // once the tool actually ran, which is the only signal that an answered
  // prompt let the session carry on working.
  PreToolUse: writeCommand("PreToolUse"),
  PostToolUse: writeCommand("PostToolUse"),
  Stop: writeCommand("Stop"),
  SessionEnd: deleteCommand,
};

/** The settings entry one hook event gets, used to write and to recognise it. */
function hookEntry(command: string): Record<string, unknown> {
  return { hooks: [{ type: "command", command, timeout: 5 }] };
}

/** Maps a hook event name onto the frame state it implies. */
function stateForEvent(event: string): AgentState | undefined {
  switch (event) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "busy";
    case "Notification":
    case "PermissionRequest":
      return "waiting";
    case "SessionStart":
    case "Stop":
      return "idle";
    default:
      return undefined;
  }
}

/** True when `target` is the workspace folder itself or lives inside it. */
function isInsideWorkspace(target: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((folder) => {
    const root = path.resolve(folder.uri.fsPath);
    const candidate = path.resolve(target);
    return (
      candidate === root || candidate.startsWith(root + path.sep)
    );
  });
}

export function areHooksInstalled(): boolean {
  const settings = readJsonFile(claudeSettingsPath);
  if (!settings || typeof settings !== "object") {
    return false;
  }

  const hooks = (settings as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object") {
    return false;
  }

  return Object.entries(hookEvents).every(([event, command]) => {
    const entries = (hooks as Record<string, unknown>)[event];
    const expected = JSON.stringify(hookEntry(command));
    return (
      Array.isArray(entries) &&
      entries.some((entry) => JSON.stringify(entry) === expected)
    );
  });
}

/**
 * True when hooks of ours are present in any shape, including the ones an
 * older version of the extension wrote. Those are refreshed in place rather
 * than asked about again: the user already agreed to them once.
 */
export function areOwnHooksPresent(): boolean {
  const settings = readJsonFile(claudeSettingsPath);
  const hooks =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).hooks
      : undefined;
  if (!hooks || typeof hooks !== "object") {
    return false;
  }

  return Object.values(hooks as Record<string, unknown>).some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some((entry) => JSON.stringify(entry).includes(hookMarker)),
  );
}

/**
 * Merges our hooks into ~/.claude/settings.json, leaving every other hook and
 * setting untouched. Re-running replaces our own entries rather than stacking.
 */
export function installHooks(): void {
  const existing = readJsonFile(claudeSettingsPath);
  const settings: Record<string, unknown> =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const currentHooks = settings.hooks;
  const hooks: Record<string, unknown> =
    currentHooks && typeof currentHooks === "object"
      ? { ...(currentHooks as Record<string, unknown>) }
      : {};

  for (const [event, command] of Object.entries(hookEvents)) {
    const entries = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[]).filter(
          (entry) => !JSON.stringify(entry).includes(hookMarker),
        )
      : [];
    entries.push(hookEntry(command));
    hooks[event] = entries;
  }

  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(
    claudeSettingsPath,
    JSON.stringify(settings, undefined, 2) + "\n",
    "utf8",
  );
}

/** Removes only the hook entries this extension added. */
export function uninstallHooks(): void {
  const existing = readJsonFile(claudeSettingsPath);
  if (!existing || typeof existing !== "object") {
    return;
  }

  const settings = { ...(existing as Record<string, unknown>) };
  const currentHooks = settings.hooks;
  if (!currentHooks || typeof currentHooks !== "object") {
    return;
  }

  const hooks: Record<string, unknown> = {
    ...(currentHooks as Record<string, unknown>),
  };
  for (const event of Object.keys(hookEvents)) {
    if (!Array.isArray(hooks[event])) {
      continue;
    }
    const entries = (hooks[event] as unknown[]).filter(
      (entry) => !JSON.stringify(entry).includes(hookMarker),
    );
    if (entries.length > 0) {
      hooks[event] = entries;
    } else {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }

  fs.writeFileSync(
    claudeSettingsPath,
    JSON.stringify(settings, undefined, 2) + "\n",
    "utf8",
  );
}

/**
 * A Claude session is placed by its cwd: the hooks live in the CLI, so the same
 * file is written whether the session runs in the sidebar, in a terminal or in
 * a worktree, and only the window whose workspace holds that cwd claims it.
 */
const claudeSource: SessionSource = {
  provider: claudeProvider,
  directory: sessionsDirectory,
  isReadable: (payload: HookPayload) =>
    typeof payload.session_id === "string" &&
    typeof payload.cwd === "string" &&
    typeof payload.hook_event_name === "string",
  isOwned: (payload: HookPayload) => isInsideWorkspace(payload.cwd as string),
  stateFor: (payload: HookPayload) =>
    stateForEvent(payload.hook_event_name as string),
};

export class ClaudeWatcher extends SessionWatcher {
  constructor(frame: AgentFrame) {
    super(frame, claudeSource);
  }
}
