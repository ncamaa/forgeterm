# ForgeTerm

A terminal emulator built for multi-project workflows. Open an entire workspace with one click - each project gets its own themed window with pre-configured terminal sessions, automatically tiled across your screen.

![Three projects auto-arranged on one screen](screenshots/feature-auto-arrange.png)

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| ⌘N | New session (defaults to a Claude session) |
| ⌘T | New session, focused on the recent-sessions search |
| ⌘⇧T | Reopen last closed session |
| ⌘⇧D | Control Panel (all projects + sessions) |
| ⌘⇧Y | Theme editor |
| ⌘, | Project settings |
| ⌘P | Switch project |
| ⌘O | Open folder |
| ⌘B | Toggle sidebar |
| ⌘F | Find in session (Claude: full transcript) |
| ⌘⇧F | Search all open sessions |
| ⌘⇧H | Session history (reopen closed sessions) |
| ⌘K | Clear terminal |
| ⌘↓ | Scroll to bottom |
| ⌘↑ | Scroll to top |
| ⌘1-9 | Switch to session |
| ⌘⇧= | Lighten theme |
| ⌘⇧- | Darken theme |
| ⌘R | Rename active session |
| ⌘W | Close session |
| ⌘⇧W | Close project window |

## Features

### Workspaces and Auto-Arrange

Group related projects into workspaces. Hit the play button to open all projects at once - ForgeTerm tiles the windows automatically so they fill your screen without overlapping.

The tiling adapts to the number of projects: two get a side-by-side split, three get a master-detail layout, four snap into a 2x2 grid, and so on up to six projects per screen.

If you have multiple monitors, choose which screen each workspace targets using the screen selector buttons. Spread projects across two or three displays, or keep everything on one - each screen tiles independently.

Click the pencil icon on any workspace to open the Edit Workspace modal, where you can:
- **Rename** the workspace
- **Set an emoji** that shows next to the workspace name
- **Set an accent color** for the workspace open button
- **Add a description** shown under the workspace name
- **Add or remove projects** from the workspace
- **Set a default command** (e.g. `git pull`) that runs in each project's first session when the workspace opens

![Workspace management with screen selectors](screenshots/feature-workspaces.png)

### Drag & Drop

Drag files onto any terminal session to choose what happens:

- **Paste path** - Inserts the full file path in double quotes: `"/Users/x/file.txt"`
- **Paste content** - Reads the file and writes its text content into the terminal. Binary files (images, etc.) fall back to paste path
- **Copy to project** - Copies the file to your project root and pastes the new relative path in double quotes

By default, a menu appears each time so you can choose. To skip the menu, set a default behavior in Project Settings (Cmd+,) under "Drag & Drop":
- Ask every time (default)
- Always paste path
- Always paste content
- Always copy to project

You can also set `dragDropBehavior` in `.forgeterm.json`:
```json
{ "dragDropBehavior": "path" }
```

### Per-Project Theming

Every project gets its own color theme so you can tell windows apart at a glance. Choose from 10 built-in window presets (Midnight, Ocean, Forest, Sunset, Lavender, Rose, Ember, Mint, Graphite, Gold), and 8 terminal color themes (Dark, Light, Midnight, Ocean, Forest, Warm, Nord, Rose). Generate a theme from any hex color, or save favorites for reuse.

Already using Peacock in VS Code? ForgeTerm reads your `peacock.color` on first open. If no theme exists, one is picked at random so every project looks different from the start. Fine-tune brightness anytime with ⌘⇧= and ⌘⇧-.

Pick a project emoji from 43 icons to make each titlebar instantly recognizable.

![Theme editor with presets, emoji picker, and color generator](screenshots/feature-themes.png)

### Automatic Sessions

Define named terminal sessions in Project Settings (⌘,) that auto-launch when you open a project. Each session runs its own startup command - dev server, test watcher, and shell side by side without manual setup every time.

Sessions are saved in `.forgeterm.json` so they travel with your repo. Toggle auto-start per session, reorder them, or add new ones on the fly.

![Multiple named sessions with auto-start commands](screenshots/feature-sessions.png)

### Session State Persistence

When you close a window or quit ForgeTerm, the state of all sessions is saved - names, commands, running status, and Claude Code conversation IDs. When you reopen the project, everything restarts exactly where it was.

Claude Code sessions are automatically resumed with `claude -r {sessionId}`. You can configure extra args per project (like `--dangerously-skip-permissions`) by setting `claudeResumeArgs` in `.forgeterm.json` or via Project Settings.

### Search & Session History

Search any session with ⌘F, or every open session at once with ⌘⇧F. Claude Code renders full-screen (so its scrollback never reaches the terminal), so ForgeTerm searches the conversation's on-disk transcript instead - you get the complete history, including what scrolled past. Other shells search their live scrollback as before.

Press ⌘⇧H to browse this project's closed sessions. Filter by name or search inside past conversations, then Resume a Claude session (or Reopen any shell) in one click.

A new session starts Claude by default: the modal comes prefilled with this project's Claude CLI and its permission flags (so an HSP project gets `claude-hsp`), and the newly created session is focused right away. Clear the command field if you just want a plain shell.

Opening a new session with ⌘T also lists this project's recent closed sessions right in the modal, sorted by when they closed or opened - click any one to reopen it, or ⌘⇧T to reopen the most recent. The search box above the list matches session names and titles *and* searches inside each closed Claude conversation, showing the matching lines under each result. Multi-word queries are tried as a phrase first, then as "every word appears somewhere in this conversation". Arrow keys move through the results, Enter reopens the highlighted one.

### Control Panel

One board for every project and every session, for when a dozen agents are running at once. Open it with **⌘⇧D**, from **File > Control Panel**, from the menu-bar icon, from the sidebar button, or with `ft dashboard`.

Two layouts, switched with the List / Cards toggle in the title bar and remembered between launches. **List** is the dense one: projects are rows you can collapse, their sessions nested underneath. **Cards** gives each project its own tile with its sessions inside, which reads better on a wide screen. Both are ordered the same way and both support every filter and action.

In list view, projects are rows you can collapse; their sessions nest underneath. Everything is ordered by how much it wants from you - sessions waiting on a response first, then working, then idle - and the menu-bar icon carries the same "waiting on you" count, so you can see it without raising a single window.

Each session row shows its state, how long it has been in that state, what it is doing (or, when it is waiting, the actual question or permission Claude is asking for), and its context usage. Click a row to jump straight to that session in its window. The `waiting` / `working` counters at the top double as filters, and the box next to them filters by name or by what a session is doing.

Per-row controls: stop or restart a session, start a new Claude session in any project, and close a project window. Closed projects are listed at the bottom - click one to open it.

### Session Activity Indicators

Each session shows its live state at a glance in the sidebar. A spinner appears while Claude Code is working, and a colored dot flags a session that needs your attention or finished while you were looking elsewhere. Visiting the session clears the dot, so you always know which windows are waiting on you across a busy multi-project workspace.

### Import from Project Manager

Already using the VS Code Project Manager extension? Import all your projects in one click. ForgeTerm auto-detects installed editors (VS Code, Cursor, Windsurf, VSCodium) and reads their Project Manager data directly.

Tags with 2 or more projects are automatically converted into workspaces. You can also import from a JSON file if you use a custom setup.

![Import panel with auto-detected editors](screenshots/feature-import.png)

### Sidebar Modes

Cycle between three sidebar modes with ⌘B:

- **Full** - Session names, status indicators, play/stop controls, and action buttons
- **Compact** - Colored dot indicators and a 2x2 button grid, just enough to navigate
- **Hidden** - Maximum terminal space, zero chrome

![Full sidebar](screenshots/feature-sidebar-full.png)

![Compact sidebar](screenshots/feature-sidebar-compact.png)

![Hidden sidebar](screenshots/feature-sidebar-hidden.png)

### Project Settings

Configure everything per-project with ⌘,. Set the project name, assign it to a workspace, manage startup sessions, set drag & drop behavior, and configure Claude Code resume args - all saved to `.forgeterm.json` in your project root.

![Project settings with session configuration](screenshots/feature-project-settings.png)

### CLI Tool (`ft`)

![CLI Connected modal](screenshots/feature-cli.png)

ForgeTerm ships with a command-line tool that communicates with the running app over a Unix socket. Install it from the sidebar's CLI button (>_) or via Homebrew (`brew install codama-dev/tap/forgeterm-cli`). The `ft` alias is installed automatically alongside `forgeterm`.

**Direct commands (work from any terminal):**

```bash
ft notify "Build complete"              # Native macOS notification
ft rename "Refactoring auth"            # Rename current session
ft close                                # Close the current session (like ⌘W)
ft start "fix login" -p "Fix auth bug"  # Start a session (Claude with a prompt)
ft info --title "..." --summary "..."   # Update session info card
ft open ~/projects/my-app               # Open a project
ft list                                 # List recent projects
ft open-workspace ~/projects            # Open folder as workspace
```

**Start a session with `ft start`:**

`ft start` launches a new live session in a project, opening its window if needed. Great for spinning up a Claude Code task from anywhere:

```bash
ft start "dev" --command "npm run dev"   # Named session running a command
ft start --claude                        # New Claude Code session
ft start "fix login" -p "Fix the auth bug in login.ts"   # Claude with an initial prompt
ft start review -p "Review the diff" --project ~/code/app  # Target another project
```

It resolves the project's configured Claude CLI (name and skip-permissions setting). Add `--idle` to create the session without starting it.

**Full command reference:**

```bash
ft project list                         # List recent projects
ft project open <path>                  # Open/focus a project
ft project remove <path>               # Remove from recent list

ft session list [--project <path>]      # List sessions
ft session add <name> [--command ".."]  # Add to project config
ft session remove <name>               # Remove from config

ft workspace list                       # List workspaces
ft workspace create <name>              # Create workspace
ft workspace delete <name>              # Delete workspace
ft workspace rename <old> <new>         # Rename workspace
ft workspace add-project <ws> <path>    # Add project
ft workspace remove-project <ws> <path> # Remove project
ft workspace open <name>                # Open all projects
ft workspace update <name> [options]    # Update metadata

ft config get [key] [--project <path>]  # Read config
ft config set <key> <value>             # Set config value

ft theme list                           # List available themes
ft theme set <name>                     # Apply window theme
ft theme terminal <name>                # Set terminal theme
ft theme favorites                      # List saved favorites
```

When run inside a ForgeTerm session, commands automatically detect the current project and session via environment variables (`FORGETERM_PROJECT_PATH`, `FORGETERM_SESSION_ID`). Clicking a notification focuses the correct window and session.

### Claude Code Integration

![Claude connection banner](screenshots/feature-claude-banner.png)

ForgeTerm has built-in support for Claude Code:

- **Auto-resume** - Claude Code sessions are detected and resumed when you reopen a project
- **Extra args** - Configure per-project args (like `--dangerously-skip-permissions`) via `claudeResumeArgs` in `.forgeterm.json`
- **Connection sync** - ForgeTerm detects if Claude Code has been configured with the latest CLI commands. A banner appears when setup is needed - click it to copy the setup prompt to your clipboard, then paste it to Claude Code
- **Session info** - Claude Code can use `ft rename`, `ft info`, and `ft notify` to keep you informed about what it's doing

### Notifications

Get notified when long-running commands finish - builds, deploys, test suites, AI agents. Notifications are native macOS alerts that show up even when ForgeTerm is in the background. Clicking a notification focuses the right window and session.

**Usage:**

```bash
# Send a notification
ft notify "Build complete"
ft notify "All 47 tests passed" --title "Test Suite"
ft notify "Deploy done" --no-sound

# Chain with any command
pnpm build && ft notify "Done" || ft notify "Failed"
```

**With AI agents (Claude Code, etc.):**

Click the Claude connection banner in ForgeTerm to copy the setup prompt. Paste it to Claude Code - it will configure itself to use `ft rename`, `ft info`, and `ft notify` throughout your sessions. ForgeTerm re-checks on every update, so Claude always has the latest commands.

**How it works:**

ForgeTerm runs a local socket server. The `ft` CLI communicates with the running app through this socket. No network, no external services - everything stays local.

### Cross-Platform

Pre-built downloads are available for macOS Apple Silicon via Homebrew or the Releases page. Running Windows, Linux, or an Intel Mac? Just clone the repo and run `pnpm build` - Electron supports all platforms natively.

---

Sponsored by [Codama](https://codama.dev)
