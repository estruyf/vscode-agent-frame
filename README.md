<h1 align="center">
  <img src="https://raw.githubusercontent.com/estruyf/vscode-agent-frame/main/assets/icon.png" alt="Agent Frame" width="128" />
  <br />
  Agent Frame
</h1>

<p align="center">See which of your coding agents are working, waiting, or idle at a glance — Agent Frame colors the VS Code window to match.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=eliostruyf.vscode-agent-frame"><img src="https://vscode-marketplace-badge.vercel.app/api/badge/version/eliostruyf.vscode-agent-frame?style=flat-square&label=Marketplace&color=green" alt="Visual Studio Marketplace" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=eliostruyf.vscode-agent-frame"><img src="https://vscode-marketplace-badge.vercel.app/api/badge/installs/eliostruyf.vscode-agent-frame?style=flat-square&label=Installs" alt="Installs" /></a>
  <a href="https://github.com/sponsors/estruyf"><img src="https://img.shields.io/badge/Sponsor-Elio%20Struyf%20%E2%9D%A4-%23fe8e86?logo=GitHub&style=flat-square" alt="Sponsor" /></a>
  <a href="https://visitorbadge.io/status?path=https%3A%2F%2Fgithub.com%2Festruyf%2Fvscode-agent-frame"><img src="https://api.visitorbadge.io/api/visitors?path=https%3A%2F%2Fgithub.com%2Festruyf%2Fvscode-agent-frame&countColor=%23263759&style=flat-square" alt="Visitors" /></a>
</p>

Agent Frame colors VS Code while one or more coding agents are active. It writes only the frame-related entries in `workbench.colorCustomizations` and preserves all other color customizations.

## How it looks

The frame follows the most urgent agent in the window. Colors below are the defaults; every state is configurable.

**Busy** — at least one agent is working.

![Agent Frame with the busy color applied to the title bar, window border and status bar](https://raw.githubusercontent.com/estruyf/vscode-agent-frame/main/assets/screenshots/state-busy.png)

**Waiting** — an agent needs your input or approval, even when another one is still working.

![Agent Frame with the waiting color applied to the title bar, window border and status bar](https://raw.githubusercontent.com/estruyf/vscode-agent-frame/main/assets/screenshots/state-waiting.png)

**Idle** — agents are tracked but all of them are idle.

![Agent Frame with the idle color applied to the title bar, window border and status bar](https://raw.githubusercontent.com/estruyf/vscode-agent-frame/main/assets/screenshots/state-idle.png)

## Configuration

- `agentFrame.colors.source`: `custom` (default) uses the colors below; `theme` derives them from the active color theme.
- `agentFrame.colors.busy`: used when at least one tracked agent is working and none are waiting.
- `agentFrame.colors.waiting`: used when at least one agent is waiting for input or approval.
- `agentFrame.colors.idle`: used when every tracked agent is idle.
- `agentFrame.colors.autoForeground`: set a black or white title bar and status bar foreground so text stays readable against the state color.
- `agentFrame.claude.enabled`: track Claude Code sessions through hooks.
- `agentFrame.terminal.enabled`: track agent CLIs launched in the integrated terminal.
- `agentFrame.terminal.commands`: executable names that count as an agent in the terminal (default `["copilot"]`).

Waiting takes precedence over busy, which takes precedence over idle: a session that needs an answer is what you have to act on, and the frame only goes idle once every tracked session is idle. Clearing the final agent restores the frame colors that Agent Frame changed.

## Theme matching

With `agentFrame.colors.source` set to `theme`, each state resolves against the active theme instead of a fixed hex value. `agentFrame.theme.busy`, `agentFrame.theme.waiting`, and `agentFrame.theme.idle` each hold a list of theme color ids; the first one the theme actually defines wins, and `agentFrame.colors.<state>` is the fallback when none of them are. Run `Agent Frame: Preview State Colors` to see and change what each state resolves to.

The colors are read from the theme extension's JSON, following its `include` chain, with your own `workbench.colorCustomizations` layered on top — so pinning `terminal.ansiGreen` in your settings also changes the busy color. Themes only ship the colors they override; everything else comes from VS Code's internal defaults, which are not readable by an extension. The default candidate lists resolve for roughly 70% of installed themes for busy and waiting and effectively all of them for idle, and the configured hex covers the rest.

Because a theme color is picked for its meaning rather than its hue, an unusual theme can produce an unusual result. Override that state's list if so.

## Picking colors

`Agent Frame: Preview State Colors` lists the three states and paints the window with whichever one is highlighted, so the arrow keys walk through the colors on the real frame. Press Enter on a state to change it:

- **Enter a hex color** writes `agentFrame.colors.<state>`, previewing as you type.
- **Choose a color from the theme** lists every color the active theme defines, again previewing as you move through them, and puts the chosen id at the front of `agentFrame.theme.<state>`.
- **Open in Settings** filters the Settings editor to Agent Frame.

Dismissing at any point restores the color the tracked agents actually call for. Changes are saved globally unless that setting already has a workspace value, in which case the workspace value is updated instead.

## Claude Code

Claude Code exposes no cross-extension API for chat state: its extension spawns the CLI itself and receives status over a private channel. Agent Frame therefore uses Claude Code's own hook system.

Run `Agent Frame: Install Claude Code Hooks` (the extension also offers this on first activation). This merges eight hooks into `~/.claude/settings.json`, leaving every other hook and setting untouched. `Agent Frame: Remove Claude Code Hooks` removes only the entries it added.

Each hook writes its payload to `~/.agent-frame/sessions/<session id>.json`, which the extension watches:

| Hook | State |
| --- | --- |
| `SessionStart` | idle |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | busy |
| `Notification`, `PermissionRequest` | waiting |
| `Stop` | idle |
| `SessionEnd` | session removed |

The tool hooks are what bring the frame back to busy after you answer a
permission prompt or a question; they write only the session id and `cwd`
rather than the full payload, which for a tool response can be megabytes.

Because the hooks live in the CLI, this covers Claude Code in the sidebar, in a terminal, and in worktrees alike. Every VS Code window watches the same directory and applies only the sessions whose `cwd` falls inside its own workspace folders, so several projects can run at once without interfering. Hooks only apply to sessions started after installation.

## Terminal agents

`agentFrame.terminal.commands` matches the executable of commands run in the integrated terminal, using VS Code's shell-integration events. This gives busy while the command runs and idle when it exits, and requires shell integration to be active.

This is a coarser signal than the Claude hooks: a long-running interactive REPL reads as busy for its whole lifetime, because VS Code only reports that the process is still running. It suits one-shot invocations such as `copilot -p "..."`.

GitHub Copilot Chat in the chat panel cannot be tracked at all. It reports session state through the `chatSessionsProvider` proposed API, which is unavailable to published extensions.

## Provider Integration

Providers can also report lifecycle changes directly:

```ts
await vscode.commands.executeCommand('vscode-agent-frame.setAgentState', {
	provider: 'github-copilot',
	id: 'chat-session-id',
	state: 'busy'
});

await vscode.commands.executeCommand(
	'vscode-agent-frame.clearAgentState',
	'github-copilot',
	'chat-session-id'
);
```

The `provider` and `id` pair identifies one agent, allowing simultaneous Claude and GitHub Copilot sessions in the same workspace. `Agent Frame: Reset Agent States` clears every tracked agent.

The input accepts `busy`, `running`, `working`, `waiting`, `idle`, and `completed`. `running` and `working` map to the busy color; `completed` maps to idle.
