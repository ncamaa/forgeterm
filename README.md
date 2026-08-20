# ForgeTerm

A terminal emulator built for multi-project workflows. Open an entire workspace with one click - each project gets its own themed window with pre-configured terminal sessions, automatically tiled across your screen.

![Three projects auto-arranged on one screen](public/screenshots/feature-auto-arrange.png)

## Install

**Homebrew (recommended):**

```bash
# App (macOS, Apple Silicon)
brew install --cask codama-dev/tap/forgeterm

# CLI only
brew install codama-dev/tap/forgeterm-cli
```

**Manual:** Download the DMG from the [Releases page](https://github.com/ncamaa/forgeterm/releases), drag to Applications, then run:

```
xattr -cr /Applications/ForgeTerm.app
```

## Features

### Workspaces and Auto-Arrange

Group related projects into workspaces and open them all at once. ForgeTerm tiles windows automatically - side-by-side for two, master-detail for three, 2x2 grid for four, and so on up to six per screen. Multi-monitor support lets you choose which display each workspace targets.

![Workspace management](public/screenshots/feature-workspaces.png)

### Per-Project Theming

Every project gets its own color theme so you can tell windows apart at a glance. 10 built-in window presets, 8 terminal color themes (dark, light, midnight, ocean, forest, warm, nord, rose), a hex color generator, Peacock sync for VS Code users, and 43 project emojis.

![Theme editor](public/screenshots/feature-themes.png)

### Automatic Sessions

Define named terminal sessions that auto-launch when you open a project. Dev server, test watcher, and shell - all running in one window without manual setup.

![Multiple sessions](public/screenshots/feature-sessions.png)

### Session State Persistence

When you close a window, ForgeTerm saves the state of all sessions - names, commands, running status, and Claude Code conversation IDs. When you reopen the project, everything restarts exactly where it was, including resuming Claude Code sessions.

### CLI Tool (`ft`)

![CLI Connected](public/screenshots/feature-cli.png)

ForgeTerm ships with a CLI that communicates with the running app over a Unix socket. Install it from the app menu or via Homebrew.

```bash
# Direct commands
ft notify "Build complete"              # Native notification
ft rename "Refactoring auth"            # Rename current session
ft info --title "..." --summary "..."   # Update session info card
ft open ~/projects/my-app               # Open a project
ft list                                 # List recent projects

# Manage projects, sessions, workspaces, config, themes
ft project list | open | remove
ft session list | add | remove
ft workspace list | create | delete | rename | open | update
ft config get [key] [--project <path>]
ft config set <key> <value>
ft theme list | set | terminal | favorites
```

### Claude Code Integration

![Claude connection banner](public/screenshots/feature-claude-banner.png)

ForgeTerm detects Claude Code sessions and auto-resumes them on restart. A one-click connection system keeps Claude's instructions in sync with the latest CLI commands - ForgeTerm shows a banner when setup is needed, and clicking it copies the setup prompt to your clipboard.

Extra CLI args for Claude resume (like `--dangerously-skip-permissions`) can be configured per project via `claudeResumeArgs` in `.forgeterm.json`.

### Import from VS Code Project Manager

Already using the Project Manager extension? Import your projects and tags in one click. Works with VS Code, Cursor, Windsurf, and other forks. Tags with 2+ projects become workspaces automatically.

![Import from editors](public/screenshots/feature-import.png)

### Sidebar Modes

Cycle between full, compact, and hidden sidebar with Cmd+B. Full mode shows session names and controls. Compact shows dot indicators. Hidden gives you maximum terminal space.

### Per-Project Config

Drop a `.forgeterm.json` in any project to define startup sessions, themes, and window settings. The config travels with your repo.

```json
{
  "projectName": "My App",
  "sessions": [
    { "name": "Dev Server", "command": "pnpm dev", "autoStart": true },
    { "name": "Tests", "command": "pnpm test --watch" },
    { "name": "Shell" }
  ],
  "window": {
    "emoji": "rocket",
    "themeName": "ocean"
  },
  "terminalTheme": "nord",
  "claudeResumeArgs": ["--dangerously-skip-permissions"]
}
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Cmd+N | New session (defaults to Claude) |
| Cmd+T | New session + search recent sessions |
| Cmd+1-9 | Switch to session |
| Cmd+W | Close session |
| Cmd+F | Find in terminal |
| Cmd+K | Clear terminal |
| Cmd+P | Project switcher |
| Cmd+O | Open folder |
| Cmd+B | Toggle sidebar |
| Cmd+, | Project settings |
| Cmd+Shift+T | Theme editor |
| Cmd+Shift+= / - | Lighten / darken theme |

## Build from Source

```bash
git clone https://github.com/ncamaa/forgeterm.git
cd forgeterm
pnpm install

# Dev mode
pnpm dev

# Package for your OS
pnpm build
```

`pnpm build` uses electron-builder which automatically targets your current platform. The packaged app will appear in the `release/` directory.

## Architecture

Three-layer Electron app:

- **Main process** (`electron/`) - App lifecycle, window management, PTY sessions via node-pty, CLI socket server
- **Preload bridge** (`electron/preload.ts`) - Typed IPC interface exposed as `window.forgeterm`
- **Renderer** (`src/`) - React + Zustand + xterm.js

## Tech Stack

- Electron
- React 18
- TypeScript
- xterm.js + node-pty
- Zustand
- Vite

## Contributing

ForgeTerm is open source and actively looking for contributors. Whether it's a bug fix, a new feature, better docs, or just a suggestion - all contributions are welcome.

- **Found a bug?** [Open an issue](https://github.com/ncamaa/forgeterm/issues) with steps to reproduce
- **Have an idea?** [Start a discussion](https://github.com/ncamaa/forgeterm/issues) or open a feature request
- **Want to contribute code?** Fork the repo, create a branch, and open a PR - no issue required for small fixes
- **Not a developer?** Testing, reporting bugs, and suggesting improvements are just as valuable

Check the [open issues](https://github.com/ncamaa/forgeterm/issues) for things to work on. Issues labeled `good first issue` are a great starting point.

## License

[MIT](LICENSE)

## Sponsors

ForgeTerm is proudly sponsored by **[Codama](https://codama.dev)** - a software development agency building tools for developers.

---

Created by [Nadav Cohen](https://github.com/ncamaa) | Licensed under [MIT](LICENSE)
