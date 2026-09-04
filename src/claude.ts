import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { AgentFrame, AgentState } from "./agentFrame";

export const claudeProvider = "claude-code";

/** Hook payloads land here, one file per session, named by session id. */
export const sessionsDirectory = path.join(
  os.homedir(),
  ".agent-frame",
  "sessions",
);

const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");

/** Identifies hooks this extension owns, so installs stay idempotent. */
const hookMarker = "AGENT_FRAME_HOOK";

/** Sessions untouched for this long are treated as crashed leftovers. */
const staleAfterMs = 12 * 60 * 60 * 1000;

/**
 * A dead session leaves no file event behind, so the directory is swept on a
 * timer as well as on every change.
 */
const sweepIntervalMs = 30 * 1000;

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

interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  pid?: unknown;
}

/**
 * Whether the process that wrote a session file is still around. Closing the
 * Claude Code panel kills its process without running SessionEnd, so the file
 * it leaves behind is the only thing still claiming the session exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process is there but owned by someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Partially written or hand-edited file; the next event re-reads it.
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
 * Watches the session directory and mirrors every Claude session whose cwd
 * belongs to this window onto the frame. Other windows watch the same files and
 * ignore the ones that are not theirs.
 */
export class ClaudeWatcher implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sweep: NodeJS.Timeout | undefined;
  private scanning = false;
  private rescan = false;
  /**
   * The last state read for every session of this window. A scan runs while
   * other sessions are writing their own files, and a file caught mid-rename or
   * carrying an event we do not map would otherwise drop that session from the
   * sync, letting a finished session decide the colour while another one is
   * still working. Its previous state is used instead.
   */
  private readonly known = new Map<string, AgentState>();

  constructor(private readonly frame: AgentFrame) {}

  public start(): void {
    if (this.watcher) {
      return;
    }

    try {
      fs.mkdirSync(sessionsDirectory, { recursive: true });
      this.watcher = fs.watch(sessionsDirectory, (_event, filename) => {
        // Hooks write a .tmp file and rename it into place; only the rename
        // matters, and reacting to the temporary file doubles the work.
        if (filename && !filename.toString().endsWith(".json")) {
          return;
        }
        this.schedule();
      });
    } catch {
      // Without a watcher the extension still works through the commands.
      return;
    }
    this.sweep = setInterval(() => void this.scan(), sweepIntervalMs);
    void this.scan();
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.sweep) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Coalesces the burst of events a single write produces. */
  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan();
    }, 120);
  }

  /**
   * Every session in this workspace is collected first and handed over in one
   * call, so a scan repaints the frame once. Overlapping scans would each work
   * from their own half-built view of the directory, so a second one waits and
   * runs after the first instead.
   */
  public async scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }

    this.scanning = true;
    try {
      do {
        this.rescan = false;
        await this.collect();
      } while (this.rescan);
    } finally {
      this.scanning = false;
    }
  }

  private async collect(): Promise<void> {
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDirectory);
    } catch {
      return;
    }

    const seen = new Map<string, AgentState>();
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const full = path.join(sessionsDirectory, file);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }

      if (Date.now() - mtimeMs > staleAfterMs) {
        try {
          fs.unlinkSync(full);
        } catch {
          // Another window may have pruned it first.
        }
        continue;
      }

      // Named after the session it belongs to, so the file still identifies a
      // session we already know about even when its contents are unusable.
      const id = file.slice(0, -".json".length);
      const payload = readJsonFile(full) as HookPayload | undefined;
      const readable =
        payload &&
        typeof payload.session_id === "string" &&
        typeof payload.cwd === "string" &&
        typeof payload.hook_event_name === "string";

      if (readable && !isInsideWorkspace(payload.cwd as string)) {
        this.known.delete(id);
        continue;
      }

      // Claude only deletes the file on SessionEnd, which never runs when its
      // window or panel is closed, so a session whose process is gone is
      // cleaned up here instead. Sessions written by an older version of the
      // hooks carry no pid and fall back to the staleness sweep above.
      if (
        readable &&
        typeof payload.pid === "number" &&
        !isProcessAlive(payload.pid)
      ) {
        try {
          fs.unlinkSync(full);
        } catch {
          // Another window may have pruned it first.
        }
        this.known.delete(id);
        continue;
      }

      const state = readable
        ? stateForEvent(payload.hook_event_name as string)
        : undefined;
      // Only sessions of this window ever reach `known`, so falling back to it
      // cannot pull in another workspace's session.
      const resolved = state ?? this.known.get(id);
      if (!resolved) {
        continue;
      }

      this.known.set(id, resolved);
      seen.set(id, resolved);
    }

    for (const id of [...this.known.keys()]) {
      if (!seen.has(id)) {
        this.known.delete(id);
      }
    }

    await this.frame.syncProvider(claudeProvider, seen);
  }
}
