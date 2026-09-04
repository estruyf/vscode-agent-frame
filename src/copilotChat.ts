import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentFrame, AgentState } from "./agentFrame";
import {
  HookPayload,
  SessionSource,
  SessionWatcher,
  readJsonFile,
  stateDirectory,
} from "./sessions";

export const copilotChatProvider = "copilot-chat";

/** Hook payloads land here, one file per session, named by session id. */
export const copilotSessionsDirectory = path.join(stateDirectory, "copilot");

/**
 * VS Code reads hooks from a handful of well-known places; this is the personal
 * one, so a single install covers every workspace and nothing lands in a repo.
 */
const copilotHooksPath = path.join(
  os.homedir(),
  ".copilot",
  "hooks",
  "agent-frame.json",
);

/** Identifies the hooks as ours, matching the Claude side. */
const hookMarker = "AGENT_FRAME_HOOK";

const shellPrelude =
  `${hookMarker}=1; d=$(cat); ` +
  `i=$(printf '%s' "$d" | grep -o '"session_id":"[^"]*"' | head -1 | ` +
  `cut -d'"' -f4 | tr -cd 'A-Za-z0-9_-'); `;

const deleteCommand =
  shellPrelude +
  `if [ -n "$i" ]; then rm -f "$HOME/.agent-frame/copilot/$i.json"; fi; exit 0`;

/**
 * Copilot hook payloads carry no cwd, so a session cannot be placed by its
 * directory the way a Claude one is. VS Code spawns the hook from the extension
 * host of the window that owns the chat, which makes `$PPID` that window: the
 * watcher claims the sessions whose pid is its own process, and the same check
 * prunes what a closed window left behind. The tool name comes along because it
 * is the only thing that separates a tool the agent runs by itself from the one
 * it uses to put a question to you.
 */
function writeCommand(event: string): string {
  return (
    shellPrelude +
    `t=$(printf '%s' "$d" | grep -o '"tool_name":"[^"]*"' | head -1 | ` +
    `cut -d'"' -f4 | tr -cd 'A-Za-z0-9_./-'); ` +
    `if [ -n "$i" ]; then m="$HOME/.agent-frame/copilot"; ` +
    `mkdir -p "$m"; ` +
    `printf '{"session_id":"%s","hook_event_name":"${event}","tool_name":"%s","pid":%s}' ` +
    `"$i" "$t" "$PPID" > "$m/$i.tmp" && mv -f "$m/$i.tmp" "$m/$i.json"; fi; exit 0`
  );
}

/**
 * Hook events we register, in the names VS Code uses for its own hook files.
 * `errorOccurred` is mapped because a turn that failed would otherwise stay
 * busy until the next one starts.
 */
const hookEvents: Record<string, string> = {
  sessionStart: writeCommand("sessionStart"),
  userPromptSubmitted: writeCommand("userPromptSubmitted"),
  preToolUse: writeCommand("preToolUse"),
  postToolUse: writeCommand("postToolUse"),
  agentStop: writeCommand("agentStop"),
  errorOccurred: writeCommand("errorOccurred"),
  sessionEnd: deleteCommand,
};

/**
 * The tool the agent calls to put a question to you. VS Code registers it as
 * `vscode_askQuestions`, models reference it as `askQuestions`, and the Claude
 * harness maps it onto `AskUserQuestion`, so the shapes are matched rather than
 * listed.
 */
const questionTool = /ask.*question/i;

/**
 * Maps a hook payload onto the frame state it implies. Copilot has no event for
 * a prompt awaiting an answer, but the tool that asks one is announced through
 * `preToolUse` and does not return until you answer, so it brackets the wait the
 * way Claude's Notification hook does. A tool waiting on approval cannot be told
 * apart this way and stays busy.
 */
function stateFor(payload: HookPayload): AgentState | undefined {
  switch (payload.hook_event_name) {
    case "preToolUse":
      return typeof payload.tool_name === "string" &&
        questionTool.test(payload.tool_name)
        ? "waiting"
        : "busy";
    case "userPromptSubmitted":
    case "postToolUse":
      return "busy";
    case "sessionStart":
    case "agentStop":
    case "errorOccurred":
      return "idle";
    default:
      return undefined;
  }
}

/** The whole file, which this extension owns outright. */
function hookFile(): Record<string, unknown> {
  return {
    hooks: Object.fromEntries(
      Object.entries(hookEvents).map(([event, command]) => [
        event,
        [{ type: "command", command, timeout: 5 }],
      ]),
    ),
  };
}

export function areCopilotHooksInstalled(): boolean {
  const existing = readJsonFile(copilotHooksPath);
  return (
    existing !== undefined &&
    JSON.stringify(existing) === JSON.stringify(hookFile())
  );
}

/**
 * True when a file of ours is there in any shape, including the one an older
 * version of the extension wrote. Those are refreshed in place rather than
 * asked about again: the user already agreed to them once.
 */
export function areOwnCopilotHooksPresent(): boolean {
  return readJsonFile(copilotHooksPath) !== undefined;
}

/**
 * Writes ~/.copilot/hooks/agent-frame.json. The file holds nothing but our own
 * hooks, so every other hook file VS Code reads is left alone.
 */
export function installCopilotHooks(): void {
  fs.mkdirSync(path.dirname(copilotHooksPath), { recursive: true });
  fs.writeFileSync(
    copilotHooksPath,
    JSON.stringify(hookFile(), undefined, 2) + "\n",
    "utf8",
  );
}

/** Removes the file this extension added. */
export function uninstallCopilotHooks(): void {
  try {
    fs.unlinkSync(copilotHooksPath);
  } catch {
    // Already gone, which is the state the caller asked for.
  }
}

const copilotChatSource: SessionSource = {
  provider: copilotChatProvider,
  directory: copilotSessionsDirectory,
  isReadable: (payload: HookPayload) =>
    typeof payload.session_id === "string" &&
    typeof payload.hook_event_name === "string" &&
    typeof payload.pid === "number",
  isOwned: (payload: HookPayload) => payload.pid === process.pid,
  stateFor,
};

export class CopilotChatWatcher extends SessionWatcher {
  constructor(frame: AgentFrame) {
    super(frame, copilotChatSource);
  }
}
