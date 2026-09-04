import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { AgentFrame, AgentState } from "./agentFrame";

/** Root for everything the hooks write, one directory per integration. */
export const stateDirectory = path.join(os.homedir(), ".agent-frame");

/** Sessions untouched for this long are treated as crashed leftovers. */
const staleAfterMs = 12 * 60 * 60 * 1000;

/**
 * A dead session leaves no file event behind, so the directory is swept on a
 * timer as well as on every change.
 */
const sweepIntervalMs = 30 * 1000;

/**
 * What a hook writes. Only the identity fields are ever read back: a tool event
 * carries its whole input and response, which can run to megabytes, so every
 * hook re-emits these instead of its payload.
 */
export interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  pid?: unknown;
}

/** What separates one agent's session files from another's. */
export interface SessionSource {
  /** Provider name the sessions are reported under. */
  readonly provider: string;
  /** Directory the hooks of this integration write into. */
  readonly directory: string;
  /** Whether a payload carries the fields this source needs to place it. */
  isReadable(payload: HookPayload): boolean;
  /** Whether a readable session belongs to this window. */
  isOwned(payload: HookPayload): boolean;
  /** Maps a hook payload onto the frame state it implies. */
  stateFor(payload: HookPayload): AgentState | undefined;
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Partially written or hand-edited file; the next event re-reads it.
    return undefined;
  }
}

/**
 * Whether the process that wrote a session file is still around. An agent that
 * goes away without running its closing hook leaves the file behind, and that
 * file is then the only thing still claiming the session exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process is there but owned by someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Watches a session directory and mirrors every session that belongs to this
 * window onto the frame. Other windows watch the same files and ignore the ones
 * that are not theirs.
 */
export class SessionWatcher implements vscode.Disposable {
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

  constructor(
    private readonly frame: AgentFrame,
    private readonly source: SessionSource,
  ) {}

  public start(): void {
    if (this.watcher) {
      return;
    }

    try {
      fs.mkdirSync(this.source.directory, { recursive: true });
      this.watcher = fs.watch(this.source.directory, (_event, filename) => {
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
      files = fs.readdirSync(this.source.directory);
    } catch {
      return;
    }

    const seen = new Map<string, AgentState>();
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const full = path.join(this.source.directory, file);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }

      if (Date.now() - mtimeMs > staleAfterMs) {
        this.remove(full);
        continue;
      }

      // Named after the session it belongs to, so the file still identifies a
      // session we already know about even when its contents are unusable.
      const id = file.slice(0, -".json".length);
      const payload = readJsonFile(full) as HookPayload | undefined;
      const readable = payload !== undefined && this.source.isReadable(payload);

      // The closing hook never runs when a window or panel is closed, so a
      // session whose process is gone is cleaned up here instead. Any window
      // may do it, which is why this comes before the ownership check.
      if (
        readable &&
        typeof payload.pid === "number" &&
        !isProcessAlive(payload.pid)
      ) {
        this.remove(full);
        this.known.delete(id);
        continue;
      }

      if (readable && !this.source.isOwned(payload)) {
        this.known.delete(id);
        continue;
      }

      const state = readable ? this.source.stateFor(payload) : undefined;
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

    await this.frame.syncProvider(this.source.provider, seen);
  }

  private remove(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      // Another window may have pruned it first.
    }
  }
}
