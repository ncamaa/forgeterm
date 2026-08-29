# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is ForgeTerm

ForgeTerm is an Electron-based terminal emulator built with React, TypeScript, and xterm.js. It opens per-project windows with multiple terminal sessions, configurable themes, and per-project config files (`.forgeterm.json`).

## Commands

- `pnpm dev` - Start dev server with HMR (Vite + Electron)
- `pnpm build` - TypeScript check, Vite build, and electron-builder package
- `pnpm rebuild` - Rebuild native node-pty module for Electron

No test runner or linter is configured.

## Architecture

Three-layer Electron app: main process, preload bridge, renderer (React).

### Main process (`electron/`)
- `main.ts` - App lifecycle, window management, IPC handlers, config file loading/watching. Each window gets its own `PtyManager` instance scoped to a project directory.
- `preload.ts` - Exposes `window.forgeterm` API via contextBridge. All IPC goes through this typed interface.
- `ptyManager.ts` - Manages node-pty sessions (create, write, resize, kill, restart). One instance per window.

### Renderer (`src/`)
- `App.tsx` - Root component. Initializes sessions from config, handles keyboard shortcuts (Cmd+T new session, Cmd+K clear, Cmd+1-9 switch).
- `store/sessionStore.ts` - Zustand store for session state (list, active session, running status).
- `components/` - Sidebar, TerminalView (xterm.js wrapper), NewSessionModal, ThemeEditor.
- `themes.ts` - Built-in theme presets.

### Shared (`shared/`)
- `types.ts` - `ForgeTermConfig`, `SessionInfo`, and `ForgeTermAPI` interface shared between main and renderer.

### Config
Per-project `.forgeterm.json` files configure theme colors, font, window chrome, and predefined sessions. The main process watches this file and pushes changes to the renderer.

## Path alias
`@shared` maps to the `shared/` directory (configured in `vite.config.ts`).

## Key dependencies
- `node-pty` - Native PTY for terminal sessions (requires rebuild for Electron via `@electron/rebuild`)
- `@xterm/xterm` + `@xterm/addon-fit` - Terminal rendering
- `zustand` - State management
- `vite-plugin-electron` - Vite integration for Electron main/preload builds

## CLI entry
`bin/forgeterm.cjs` is the CLI entry point. The app accepts a directory path argument to open a project window.


<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **forgeterm** (2122 symbols, 4493 relationships, 159 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/forgeterm/context` | Codebase overview, check index freshness |
| `gitnexus://repo/forgeterm/clusters` | All functional areas |
| `gitnexus://repo/forgeterm/processes` | All execution flows |
| `gitnexus://repo/forgeterm/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
