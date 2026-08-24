import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { execSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PtyManager } from './ptyManager'
import type { ForgeTermConfig, RecentProject, Workspace, WorkspaceTheme, ImportResult, FavoriteTheme, DetectedEditor, UpdateInfo, SessionTemplate, SessionStatusReport, SavedSession, SavedWindowState, SessionContext, SessionActivityStatus, HistoricalSession, SessionHistoryFilter, DashboardState, DashboardProject, DashboardSession, DashboardWorkspace, TranscriptSearchTarget } from '../shared/types'
import { searchTranscripts } from './claudeTranscript'
import crypto from 'node:crypto'
import { UpdateManager } from './updater'
import { NotificationServer, getSocketPath, type CommandHandler } from './notificationServer'
import { isFinderIntegrationInstalled, installFinderIntegration, uninstallFinderIntegration } from './finderIntegration'
import { RemoteServer } from './remoteServer'
import type { RemoteStatus } from './remoteServer'
import { generateWindowTheme, getTerminalTheme, PRESET_THEMES, TERMINAL_THEMES, getTerminalThemeNames } from '../src/themes'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Enable Chrome DevTools Protocol for external automation (e.g. Playwright)
app.commandLine.appendSwitch('remote-debugging-port', '9222')

process.env.APP_ROOT = path.join(__dirname, '..')

// Desktop-launched apps get a minimal PATH. Augment with common tool locations.
{
  const currentPath = process.env.PATH || ''
  if (process.platform !== 'win32') {
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
    const missing = extraPaths.filter((p) => !currentPath.split(':').includes(p))
    if (missing.length) {
      process.env.PATH = `${currentPath}:${missing.join(':')}`
    }
  }
}

// Where the `forgeterm` CLI can end up: the app installs to /usr/local/bin,
// Homebrew installs to its own prefix.
const CLI_INSTALL_PATHS = ['/usr/local/bin/forgeterm', '/opt/homebrew/bin/forgeterm']

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

interface WindowState {
  projectPath: string
  ptyManager: PtyManager
  configWatcher?: fs.FSWatcher
  activeSessionId?: string
}

const windowStates = new Map<number, WindowState>()
const updateManager = new UpdateManager()

// --- Tray & activity tracking ---
let tray: Tray | null = null

interface WindowActivityInfo {
  projectName: string
  sessions: SessionStatusReport[]
}
const windowActivities = new Map<number, WindowActivityInfo>()

/**
 * Per-session signals the Control Panel needs but that no single source owns:
 * when the status last changed (so it can say "waiting 4m") and, for a session
 * waiting on you, what it is waiting for. Every status - hook-driven or from the
 * renderer's PTY heuristic - passes through `activity:report`, so stamping the
 * change here catches both. Entries are dropped when their window closes.
 */
interface SessionSignal {
  status: SessionActivityStatus
  changedAt: number
  attentionMessage?: string
}
const sessionSignals = new Map<string, SessionSignal>()

// Record a status for a session, stamping changedAt only when it actually
// changes so "waiting 4m" measures the wait, not the last poll.
function trackSessionStatus(sessionId: string, status: SessionActivityStatus): void {
  const prev = sessionSignals.get(sessionId)
  if (prev && prev.status === status) return
  sessionSignals.set(sessionId, {
    status,
    changedAt: Date.now(),
    // The reason a session is waiting only survives while it is still waiting.
    attentionMessage: status === 'unread' ? prev?.attentionMessage : undefined,
  })
}

// Sessions requested via `ft start`, keyed by resolved project path. The renderer
// drains its window's queue on load / when opened / when flushed, so this works
// whether the target window already existed or was created to service the request.
const pendingStarts = new Map<string, import('../shared/types').PendingSessionStart[]>()

// Wrap a string as a single shell argument (POSIX single-quoting).
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function getFavoriteThemesPath(): string {
  return path.join(app.getPath('userData'), 'favorite-themes.json')
}

// Deep get/set for dot-notation keys (e.g. "window.emoji")
function deepGet(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function deepSet(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {}
    }
    current = current[parts[i]] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function buildCliHandlers(): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>()

  // --- Existing commands ---

  handlers.set('notify', (p) => {
    notificationServer.showNotification(p as unknown as import('../shared/types').ForgeTermNotification)
    return { ok: true }
  })

  handlers.set('dashboard', () => {
    createDashboardWindow()
    return { ok: true }
  })

  handlers.set('open', (p) => {
    const projectPath = p.path as string
    if (!projectPath) return { ok: false, error: 'Missing path' }
    const resolved = path.resolve(projectPath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` }
    }
    focusOrCreateWindow(resolved)
    return { ok: true }
  })

  handlers.set('list', (p) => {
    const projects = loadRecentProjects()
    return { ok: true, data: projects }
  })

  handlers.set('rename', (p) => {
    const projectPath = p.projectPath as string
    const sessionId = p.sessionId as string
    const name = p.name as string
    if (!projectPath || !sessionId || !name) return { ok: false, error: 'Missing projectPath, sessionId, or name' }
    const win = findWindowForProject(projectPath)
    if (win && !win.isDestroyed()) {
      const state = windowStates.get(win.id)
      // Respect a manual rename: once the user names a session, CLI/Claude
      // renames are ignored (reported as ok so Claude doesn't retry/error).
      if (state?.ptyManager.isNameLocked(sessionId)) {
        return { ok: true }
      }
      state?.ptyManager.rename(sessionId, name)
      win.webContents.send('session:renamed', sessionId, name)
      schedulePersist(win.id)
    }
    return { ok: true }
  })

  handlers.set('close', (p) => {
    const projectPath = p.projectPath as string
    const sessionId = p.sessionId as string
    if (!projectPath || !sessionId) return { ok: false, error: 'Missing projectPath or sessionId' }
    const win = findWindowForProject(projectPath)
    if (win && !win.isDestroyed()) {
      // Defer the teardown a beat: the caller is usually the `ft` process running
      // inside the very session being closed, so killing its PTY synchronously
      // could race the socket response. Let `ft` read its reply and exit first.
      setTimeout(() => {
        if (win.isDestroyed()) return
        const state = windowStates.get(win.id)
        state?.ptyManager.removeSession(sessionId)
        win.webContents.send('session:closed', sessionId)
        schedulePersist(win.id)
      }, 150)
    }
    return { ok: true }
  })

  handlers.set('info', (p) => {
    const projectPath = p.projectPath as string
    const sessionId = p.sessionId as string
    const title = p.title as string
    const summary = p.summary as string
    const lastAction = p.lastAction as string
    const actionItem = p.actionItem as string | undefined
    if (!projectPath || !sessionId || !title || !summary || !lastAction) {
      return { ok: false, error: 'Missing required fields (projectPath, sessionId, title, summary, lastAction)' }
    }
    const win = findWindowForProject(projectPath)
    if (win && !win.isDestroyed()) {
      const state = windowStates.get(win.id)
      const existing = state?.ptyManager.getSession(sessionId)
      const existingTimeline = existing?.info?.timeline ?? []
      const existingContextPercent = existing?.info?.contextPercent
      const newEntry = { title, summary, lastAction, actionItem: actionItem || undefined, timestamp: Date.now(), contextPercent: existingContextPercent }
      // Cap timeline at 50 entries
      const timeline = [...existingTimeline, newEntry].slice(-50)
      const info: SessionContext = { title, summary, lastAction, actionItem: actionItem || undefined, updatedAt: Date.now(), contextPercent: existingContextPercent, timeline }
      state?.ptyManager.setSessionInfo(sessionId, info)
      win.webContents.send('session:info-updated', sessionId, info)
      schedulePersist(win.id)
    }
    return { ok: true }
  })

  handlers.set('context', (p) => {
    const projectPath = p.projectPath as string
    const sessionId = p.sessionId as string
    const percent = Number(p.percent)
    if (!projectPath || !sessionId || isNaN(percent)) return { ok: false, error: 'Missing projectPath, sessionId, or percent' }
    const clamped = Math.max(0, Math.min(100, percent))
    const win = findWindowForProject(projectPath)
    if (win && !win.isDestroyed()) {
      // Persist onto the session too: the renderer store is per-window, so the
      // Control Panel (its own window) can only read what the PTY session holds.
      const state = windowStates.get(win.id)
      const existing = state?.ptyManager.getSession(sessionId)
      if (existing?.info) {
        state?.ptyManager.setSessionInfo(sessionId, { ...existing.info, contextPercent: clamped })
      }
      win.webContents.send('session:context-updated', sessionId, clamped)
    }
    pushDashboardState()
    return { ok: true }
  })

  handlers.set('conversation', (p) => {
    const projectPath = p.projectPath as string
    const sessionId = p.sessionId as string
    const conversationId = p.conversationId as string
    if (!projectPath || !sessionId || !conversationId) {
      return { ok: false, error: 'Missing projectPath, sessionId, or conversationId' }
    }
    const win = findWindowForProject(projectPath)
    if (win && !win.isDestroyed()) {
      const state = windowStates.get(win.id)
      state?.ptyManager.setConversationId(sessionId, conversationId)
      win.webContents.send('session:conversation-updated', sessionId, conversationId)
      schedulePersist(win.id)
    }
    return { ok: true }
  })

  handlers.set('activity', (p) => {
    const projectPath = p.projectPath as string
    const sessionId = p.sessionId as string
    const status = p.status as string
    const message = typeof p.message === 'string' ? p.message.trim() : ''
    const valid = ['working', 'done', 'attention', 'idle']
    if (!projectPath || !sessionId || !valid.includes(status)) {
      return { ok: false, error: 'Missing projectPath/sessionId or invalid status' }
    }
    // Remember why this session wants you before the renderer maps the signal
    // to a status; `attention` is the only signal that carries a reason.
    if (status === 'attention') {
      const prev = sessionSignals.get(sessionId)
      sessionSignals.set(sessionId, {
        status: 'unread',
        changedAt: prev?.status === 'unread' ? prev.changedAt : Date.now(),
        attentionMessage: message || undefined,
      })
    } else if (message) {
      const prev = sessionSignals.get(sessionId)
      if (prev) sessionSignals.set(sessionId, { ...prev, attentionMessage: undefined })
    }
    const win = findWindowForProject(projectPath)
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:activity-updated', sessionId, status)
    }
    pushDashboardState()
    return { ok: true }
  })

  handlers.set('open-workspace', (p) => {
    const parentPath = p.path as string
    if (!parentPath) return { ok: false, error: 'Missing path' }
    const resolved = path.resolve(parentPath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` }
    }
    openFolderAsWorkspace(resolved)
    return { ok: true }
  })

  // Start a new LIVE session in a project (opening/focusing its window first).
  // Unlike `session-add` (which only edits saved config), this spawns a running
  // terminal now. With `claude`/`prompt` it launches the project's resolved
  // Claude CLI, optionally seeded with an initial prompt.
  handlers.set('start-session', (p) => {
    const projectPath = p.projectPath as string
    if (!projectPath) return { ok: false, error: 'Missing projectPath' }
    const resolved = path.resolve(projectPath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` }
    }

    const prompt = typeof p.prompt === 'string' && p.prompt ? p.prompt : undefined
    const useClaude = p.claude === true || prompt !== undefined
    // `runCommand`, not `command`: the socket envelope already uses `command`
    // for the RPC verb, so a second `command` key would clobber it on parse.
    let command = (p.runCommand as string | undefined) || undefined
    if (useClaude) {
      const launch = resolveClaudeLaunch(resolved)
      const parts = [launch.cliName, ...launch.resumeArgs]
      if (prompt) parts.push(shellSingleQuote(prompt))
      command = parts.join(' ')
    }

    const name =
      (p.name as string) ||
      (useClaude ? 'Claude' : command ? command.trim().split(/\s+/)[0] : 'shell')
    const idle = p.idle === true

    const existed = !!findWindowForProject(resolved)
    const queue = pendingStarts.get(resolved) ?? []
    queue.push({ name, command, idle })
    pendingStarts.set(resolved, queue)

    const win = focusOrCreateWindow(resolved)
    // A pre-existing window already ran its init, so nudge it to drain the queue.
    // A freshly created one drains it as part of its own initialization.
    if (existed && win && !win.isDestroyed()) {
      win.webContents.send('cli:flush-pending-starts')
    }
    return { ok: true, data: { name } }
  })

  // --- Project commands ---

  handlers.set('project-list', (p) => {
    const projects = loadRecentProjects()
    return { ok: true, data: projects }
  })

  handlers.set('project-open', handlers.get('open')!)

  handlers.set('project-remove', (p) => {
    const projectPath = p.path as string
    if (!projectPath) return { ok: false, error: 'Missing path' }
    const resolved = path.resolve(projectPath)
    const projects = loadRecentProjects().filter((pr) => pr.path !== resolved)
    fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
    removeProjectFromWorkspace(resolved)
    return { ok: true }
  })

  // --- Session commands ---

  handlers.set('session-list', (p) => {
    const projectPath = p.projectPath as string
    if (!projectPath) return { ok: false, error: 'Missing projectPath' }
    const resolved = path.resolve(projectPath)
    // Try live sessions first
    const win = findWindowForProject(resolved)
    if (win && !win.isDestroyed()) {
      const state = windowStates.get(win.id)
      if (state) {
        const sessions = state.ptyManager.getAllSessions()
        return { ok: true, data: sessions.map(s => ({ id: s.id, name: s.name, command: s.command, running: s.running })) }
      }
    }
    // Fall back to config sessions
    const config = loadConfig(resolved)
    return { ok: true, data: config?.sessions || [] }
  })

  handlers.set('session-add', (p) => {
    const projectPath = p.projectPath as string
    const name = p.name as string
    // `runCommand`: the envelope's `command` field is the RPC verb (see start-session).
    const command = p.runCommand as string | undefined
    const autoStart = p.autoStart as boolean | undefined
    if (!projectPath || !name) return { ok: false, error: 'Missing projectPath or name' }
    const resolved = path.resolve(projectPath)
    const config = loadConfig(resolved) || {}
    if (!config.sessions) config.sessions = []
    if (config.sessions.find(s => s.name === name)) {
      return { ok: false, error: `Session "${name}" already exists` }
    }
    config.sessions.push({ name, command, autoStart })
    saveConfig(resolved, config)
    notifyConfigChanged(resolved)
    return { ok: true }
  })

  handlers.set('session-remove', (p) => {
    const projectPath = p.projectPath as string
    const name = p.name as string
    if (!projectPath || !name) return { ok: false, error: 'Missing projectPath or name' }
    const resolved = path.resolve(projectPath)
    const config = loadConfig(resolved)
    if (!config?.sessions) return { ok: false, error: 'No sessions configured' }
    config.sessions = config.sessions.filter(s => s.name !== name)
    saveConfig(resolved, config)
    notifyConfigChanged(resolved)
    return { ok: true }
  })

  handlers.set('session-rename', (p) => {
    const projectPath = p.projectPath as string
    const oldName = p.oldName as string
    const newName = p.newName as string
    if (!projectPath || !oldName || !newName) return { ok: false, error: 'Missing projectPath, oldName, or newName' }
    const resolved = path.resolve(projectPath)
    const config = loadConfig(resolved)
    if (!config?.sessions) return { ok: false, error: 'No sessions configured' }
    const session = config.sessions.find(s => s.name === oldName)
    if (!session) return { ok: false, error: `Session "${oldName}" not found` }
    session.name = newName
    saveConfig(resolved, config)
    notifyConfigChanged(resolved)
    return { ok: true }
  })

  // --- Workspace commands ---

  handlers.set('workspace-list', () => {
    return { ok: true, data: loadWorkspaces() }
  })

  handlers.set('workspace-create', (p) => {
    const name = p.name as string
    if (!name) return { ok: false, error: 'Missing name' }
    const workspaces = loadWorkspaces()
    if (workspaces.find(w => w.name === name)) {
      return { ok: false, error: `Workspace "${name}" already exists` }
    }
    workspaces.push({ name, projects: [] })
    saveWorkspaces(workspaces)
    return { ok: true }
  })

  handlers.set('workspace-delete', (p) => {
    const name = p.name as string
    if (!name) return { ok: false, error: 'Missing name' }
    const workspaces = loadWorkspaces().filter(w => w.name !== name)
    saveWorkspaces(workspaces)
    return { ok: true }
  })

  handlers.set('workspace-rename', (p) => {
    const oldName = p.oldName as string
    const newName = p.newName as string
    if (!oldName || !newName) return { ok: false, error: 'Missing oldName or newName' }
    const workspaces = loadWorkspaces()
    const ws = workspaces.find(w => w.name === oldName)
    if (!ws) return { ok: false, error: `Workspace "${oldName}" not found` }
    ws.name = newName
    saveWorkspaces(workspaces)
    // Update references in recent projects
    const projects = loadRecentProjects().map(pr => pr.workspace === oldName ? { ...pr, workspace: newName } : pr)
    fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
    return { ok: true }
  })

  handlers.set('workspace-add-project', (p) => {
    const workspaceName = p.name as string
    const projectPath = p.projectPath as string
    if (!workspaceName || !projectPath) return { ok: false, error: 'Missing name or projectPath' }
    setProjectWorkspace(path.resolve(projectPath), workspaceName)
    return { ok: true }
  })

  handlers.set('workspace-remove-project', (p) => {
    const workspaceName = p.name as string
    const projectPath = p.projectPath as string
    if (!workspaceName || !projectPath) return { ok: false, error: 'Missing name or projectPath' }
    const resolved = path.resolve(projectPath)
    const workspaces = loadWorkspaces()
    const ws = workspaces.find(w => w.name === workspaceName)
    if (ws) {
      ws.projects = ws.projects.filter(pr => pr !== resolved)
      const cleaned = workspaces.filter(w => w.projects.length > 0)
      saveWorkspaces(cleaned)
    }
    return { ok: true }
  })

  handlers.set('workspace-open', (p) => {
    const name = p.name as string
    if (!name) return { ok: false, error: 'Missing name' }
    const workspaces = loadWorkspaces()
    const ws = workspaces.find(w => w.name === name)
    if (!ws) return { ok: false, error: `Workspace "${name}" not found` }
    const enabled = ws.projects.filter(pr => !(ws.disabledProjects || []).includes(pr))
    for (const projectPath of enabled) {
      focusOrCreateWindow(projectPath)
    }
    return { ok: true }
  })

  handlers.set('workspace-update', (p) => {
    const name = p.name as string
    if (!name) return { ok: false, error: 'Missing name' }
    const workspaces = loadWorkspaces()
    const ws = workspaces.find(w => w.name === name)
    if (!ws) return { ok: false, error: `Workspace "${name}" not found` }
    if (p.emoji !== undefined) ws.emoji = p.emoji as string
    if (p.description !== undefined) ws.description = p.description as string
    if (p.defaultCommand !== undefined) ws.defaultCommand = p.defaultCommand as string
    if (p.claudeCliName !== undefined) ws.claudeCliName = (p.claudeCliName as string) || undefined
    if (p.dangerouslySkipPermissions !== undefined) ws.dangerouslySkipPermissions = p.dangerouslySkipPermissions as boolean
    // Theming: a preset name wins, otherwise a bare accent regenerates the chrome.
    if (p.theme !== undefined) {
      const wanted = String(p.theme)
      const preset = PRESET_THEMES.find(t => t.id === wanted || t.name.toLowerCase() === wanted.toLowerCase())
      if (!preset) return { ok: false, error: `Theme "${wanted}" not found. Use theme-list to see available themes.` }
      ws.theme = presetToWorkspaceTheme(preset)
      ws.accentColor = preset.window.accentColor
    } else if (p.accentColor !== undefined && p.accentColor !== ws.accentColor) {
      ws.accentColor = (p.accentColor as string) || undefined
      ws.theme = ws.accentColor ? accentToWorkspaceTheme(ws.accentColor) : undefined
    }
    saveWorkspaces(workspaces)
    if (ws.theme) propagateWorkspaceTheme(ws)
    return { ok: true }
  })

  // --- Config commands ---

  handlers.set('config-get', (p) => {
    const projectPath = p.projectPath as string
    if (!projectPath) return { ok: false, error: 'Missing projectPath' }
    const resolved = path.resolve(projectPath)
    const config = loadConfig(resolved)
    if (!config) return { ok: true, data: {} }
    const key = p.key as string | undefined
    if (key) {
      return { ok: true, data: deepGet(config as unknown as Record<string, unknown>, key) }
    }
    return { ok: true, data: config }
  })

  handlers.set('config-set', (p) => {
    const projectPath = p.projectPath as string
    const key = p.key as string
    const rawValue = p.value
    if (!projectPath || !key) return { ok: false, error: 'Missing projectPath or key' }
    const resolved = path.resolve(projectPath)
    const config = (loadConfig(resolved) || {}) as Record<string, unknown>
    // Parse value: try JSON, fall back to string
    let value: unknown = rawValue
    if (typeof rawValue === 'string') {
      try { value = JSON.parse(rawValue) } catch { value = rawValue }
    }
    deepSet(config, key, value)
    saveConfig(resolved, config as ForgeTermConfig)
    notifyConfigChanged(resolved)
    return { ok: true }
  })

  // --- Theme commands ---

  handlers.set('theme-list', () => {
    const presets = PRESET_THEMES.map(t => ({ id: t.id, name: t.name }))
    const terminal = getTerminalThemeNames()
    return { ok: true, data: { presets, terminalThemes: terminal } }
  })

  handlers.set('theme-set', (p) => {
    const projectPath = p.projectPath as string
    const themeName = p.name as string
    if (!projectPath || !themeName) return { ok: false, error: 'Missing projectPath or name' }
    const resolved = path.resolve(projectPath)
    const preset = PRESET_THEMES.find(t => t.id === themeName || t.name.toLowerCase() === themeName.toLowerCase())
    if (!preset) return { ok: false, error: `Theme "${themeName}" not found. Use theme-list to see available themes.` }
    // A themed workspace owns the look, so retarget the whole workspace rather
    // than writing a project theme that would be overridden on next load.
    const ws = findWorkspaceForProject(resolved)
    if (ws?.theme) {
      setWorkspaceTheme(ws.name, presetToWorkspaceTheme(preset))
      return { ok: true, data: { appliedTo: `workspace "${ws.name}" (${ws.projects.length} projects)` } }
    }
    const config = (loadConfig(resolved) || {}) as ForgeTermConfig
    config.window = { ...preset.window, themeName: preset.id }
    config.theme = { ...preset.terminal, cursor: preset.window.accentColor }
    config.terminalTheme = preset.terminalMode
    saveConfig(resolved, config)
    notifyConfigChanged(resolved)
    return { ok: true }
  })

  handlers.set('terminal-theme-set', (p) => {
    const projectPath = p.projectPath as string
    const themeName = p.name as string
    if (!projectPath || !themeName) return { ok: false, error: 'Missing projectPath or name' }
    if (!TERMINAL_THEMES[themeName]) return { ok: false, error: `Terminal theme "${themeName}" not found. Available: ${getTerminalThemeNames().join(', ')}` }
    const resolved = path.resolve(projectPath)
    const ws = findWorkspaceForProject(resolved)
    if (ws?.theme) {
      setWorkspaceTheme(ws.name, { ...ws.theme, terminalTheme: themeName, theme: getTerminalTheme(themeName) })
      return { ok: true, data: { appliedTo: `workspace "${ws.name}" (${ws.projects.length} projects)` } }
    }
    const config = (loadConfig(resolved) || {}) as ForgeTermConfig
    const terminal = getTerminalTheme(themeName)
    config.terminalTheme = themeName
    // The renderer paints from `config.theme`, so the palette has to be
    // materialized here or setting the name alone changes nothing on screen.
    config.theme = { ...terminal, cursor: config.window?.accentColor ?? terminal.cursor }
    saveConfig(resolved, config)
    notifyConfigChanged(resolved)
    return { ok: true }
  })

  handlers.set('theme-favorites', () => {
    try {
      const raw = fs.readFileSync(getFavoriteThemesPath(), 'utf-8')
      return { ok: true, data: JSON.parse(raw) as FavoriteTheme[] }
    } catch {
      return { ok: true, data: [] }
    }
  })

  return handlers
}

function notifyConfigChanged(projectPath: string) {
  const win = findWindowForProject(projectPath)
  if (win && !win.isDestroyed()) {
    win.webContents.send('config:changed')
  }
}

const notificationServer = new NotificationServer({
  handlers: buildCliHandlers(),
  findWindowForProject,
  getProjectDisplayName: (projectPath: string) => {
    if (!projectPath) return null
    const config = loadConfig(projectPath)
    return config?.projectName || path.basename(projectPath)
  },
})

const remoteServer = new RemoteServer({
  windowStates,
  loadWorkspaces: () => loadWorkspaces(),
  loadConfig: (projectPath: string) => loadConfig(projectPath),
})

// --- Recent projects ---

function getRecentProjectsPath(): string {
  return path.join(app.getPath('userData'), 'recent-projects.json')
}

function loadRecentProjects(): RecentProject[] {
  try {
    const raw = fs.readFileSync(getRecentProjectsPath(), 'utf-8')
    return JSON.parse(raw) as RecentProject[]
  } catch {
    return []
  }
}

function saveRecentProject(projectPath: string) {
  const projects = loadRecentProjects()
  const config = loadConfig(projectPath)
  const name = config?.projectName || path.basename(projectPath)
  const workspace = getWorkspaceForProject(projectPath)
  const existing = projects.find((p) => p.path === projectPath)
  const filtered = projects.filter((p) => p.path !== projectPath)
  filtered.unshift({ ...existing, path: projectPath, name, lastOpened: Date.now(), workspace })
  fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(filtered, null, 2), 'utf-8')
}

// --- Session History ---

function getHistoryDir(): string {
  const dir = path.join(app.getPath('userData'), 'session-history')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getHistoryPath(projectPath: string): string {
  const hash = crypto.createHash('md5').update(projectPath).digest('hex')
  return path.join(getHistoryDir(), `${hash}.json`)
}

function loadHistory(projectPath: string): HistoricalSession[] {
  try {
    const raw = fs.readFileSync(getHistoryPath(projectPath), 'utf-8')
    return JSON.parse(raw) as HistoricalSession[]
  } catch {
    return []
  }
}

function saveHistory(projectPath: string, sessions: HistoricalSession[]) {
  fs.writeFileSync(getHistoryPath(projectPath), JSON.stringify(sessions, null, 2), 'utf-8')
}

function appendToHistory(projectPath: string, session: HistoricalSession) {
  const history = loadHistory(projectPath)
  const existing = history.findIndex(h => h.id === session.id)
  if (existing >= 0) {
    history[existing] = session
  } else {
    history.push(session)
  }
  saveHistory(projectPath, history)
}

function cleanupOldHistory(maxAgeDays: number): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const dir = getHistoryDir()
  let removed = 0
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(dir, file)
      const sessions: HistoricalSession[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const filtered = sessions.filter(s => (s.endedAt ?? s.createdAt) > cutoff)
      removed += sessions.length - filtered.length
      if (filtered.length === 0) {
        fs.unlinkSync(filePath)
      } else if (filtered.length < sessions.length) {
        fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8')
      }
    }
  } catch { /* ignore */ }
  return removed
}

function searchHistory(filter: SessionHistoryFilter): HistoricalSession[] {
  const dir = getHistoryDir()
  const results: HistoricalSession[] = []
  const cutoff = filter.maxAgeDays ? Date.now() - filter.maxAgeDays * 24 * 60 * 60 * 1000 : 0
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(dir, file)
      const sessions: HistoricalSession[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      for (const s of sessions) {
        if (filter.projectPath && s.projectPath !== filter.projectPath) continue
        if (filter.workspace && s.workspace !== filter.workspace) continue
        if (cutoff && (s.endedAt ?? s.createdAt) < cutoff) continue
        if (filter.query) {
          const q = filter.query.toLowerCase()
          const matches = s.name.toLowerCase().includes(q) ||
            s.info?.title?.toLowerCase().includes(q) ||
            s.info?.summary?.toLowerCase().includes(q) ||
            s.info?.timeline?.some(e => e.lastAction.toLowerCase().includes(q))
          if (!matches) continue
        }
        results.push(s)
      }
    }
  } catch { /* ignore */ }
  return results.sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
}

function getDashboardState(): DashboardState {
  const workspaces = loadWorkspaces()
  const recentProjects = loadRecentProjects()

  // Build a map of open windows: projectPath -> session statuses
  const openWindows = new Map<string, { sessions: SessionStatusReport[]; ptyManager: PtyManager; activeSessionId?: string }>()
  for (const [winId, state] of windowStates) {
    const activity = windowActivities.get(winId)
    openWindows.set(state.projectPath, {
      sessions: activity?.sessions ?? [],
      ptyManager: state.ptyManager,
      activeSessionId: state.activeSessionId,
    })
  }

  // Helper to build DashboardProject
  const buildProject = (projectPath: string, workspace?: string): DashboardProject => {
    const recent = recentProjects.find(p => p.path === projectPath)
    const openWin = openWindows.get(projectPath)
    const sessions: DashboardSession[] = (openWin?.sessions ?? []).map(s => {
      const ptySession = openWin?.ptyManager.getSession(s.sessionId)
      const signal = sessionSignals.get(s.sessionId)
      return {
        id: s.sessionId,
        name: s.sessionName,
        // The status report carries no run state, so read the PTY itself -
        // a stopped session is exactly what you want to spot on this board.
        running: ptySession?.running ?? true,
        activityStatus: s.status,
        contextPercent: ptySession?.info?.contextPercent,
        info: ptySession?.info,
        conversationId: ptySession?.conversationId,
        statusChangedAt: s.statusChangedAt ?? signal?.changedAt,
        attentionMessage: s.status === 'unread' ? signal?.attentionMessage : undefined,
        isActive: openWin?.activeSessionId === s.sessionId,
      }
    })
    return {
      path: projectPath,
      name: recent?.name || path.basename(projectPath),
      isOpen: openWindows.has(projectPath),
      emoji: recent?.emoji,
      accentColor: recent?.accentColor,
      sessions,
      workspace,
      lastOpened: recent?.lastOpened,
    }
  }

  // Build workspace cards
  const workspaceProjectPaths = new Set<string>()
  const dashWorkspaces: DashboardWorkspace[] = workspaces.map(ws => {
    ws.projects.forEach(p => workspaceProjectPaths.add(p))
    return {
      name: ws.name,
      emoji: ws.emoji,
      accentColor: ws.accentColor,
      description: ws.description,
      projects: ws.projects.map((p) => buildProject(p, ws.name)),
    }
  })

  // Standalone projects: open ones first, plus recent-but-closed ones so the
  // panel can offer every project you actually use, not only what is open now.
  const standaloneProjects: DashboardProject[] = []
  const seen = new Set<string>()
  for (const [projectPath] of openWindows) {
    if (!workspaceProjectPaths.has(projectPath) && projectPath) {
      standaloneProjects.push(buildProject(projectPath))
      seen.add(projectPath)
    }
  }
  for (const recent of recentProjects) {
    if (workspaceProjectPaths.has(recent.path) || seen.has(recent.path)) continue
    standaloneProjects.push(buildProject(recent.path))
    seen.add(recent.path)
  }

  return { workspaces: dashWorkspaces, standaloneProjects, generatedAt: Date.now() }
}

// --- Workspaces ---

// --- App-wide UI preferences (not per project) ---

function getUiPrefsPath(): string {
  return path.join(app.getPath('userData'), 'ui-prefs.json')
}

function loadUiPrefs(): import('../shared/types').UiPrefs {
  try {
    return JSON.parse(fs.readFileSync(getUiPrefsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function saveUiPrefs(prefs: import('../shared/types').UiPrefs): void {
  try {
    fs.writeFileSync(getUiPrefsPath(), JSON.stringify(prefs, null, 2), 'utf-8')
  } catch {
    // A lost preference is not worth failing a click over.
  }
}

function getWorkspacesPath(): string {
  return path.join(app.getPath('userData'), 'workspaces.json')
}

function loadWorkspaces(): Workspace[] {
  try {
    const raw = fs.readFileSync(getWorkspacesPath(), 'utf-8')
    return JSON.parse(raw) as Workspace[]
  } catch {
    return []
  }
}

function saveWorkspaces(workspaces: Workspace[]) {
  fs.writeFileSync(getWorkspacesPath(), JSON.stringify(workspaces, null, 2), 'utf-8')
}

function openFolderAsWorkspace(parentPath: string) {
  const folderName = path.basename(parentPath)
  const children = fs.readdirSync(parentPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => path.join(parentPath, d.name))

  if (children.length === 0) {
    // No child dirs - just open the folder itself
    focusOrCreateWindow(parentPath)
    return
  }

  // Create or update workspace
  const workspaces = loadWorkspaces()
  const existing = workspaces.find(w => w.name === folderName)
  if (existing) {
    existing.projects = children
  } else {
    workspaces.push({ name: folderName, projects: children })
  }
  saveWorkspaces(workspaces)

  // Open all child projects
  for (const childPath of children) {
    focusOrCreateWindow(childPath)
  }
}

function setProjectWorkspace(projectPath: string, workspaceName: string) {
  const workspaces = loadWorkspaces()
  // Remove project from any existing workspace
  for (const ws of workspaces) {
    ws.projects = ws.projects.filter((p) => p !== projectPath)
  }
  // Add to target workspace (create if needed)
  let target = workspaces.find((ws) => ws.name === workspaceName)
  if (!target) {
    target = { name: workspaceName, projects: [] }
    workspaces.push(target)
  }
  target.projects.push(projectPath)
  // Remove empty workspaces
  const cleaned = workspaces.filter((ws) => ws.projects.length > 0)
  saveWorkspaces(cleaned)
  // Joining a themed workspace adopts its theme immediately.
  if (target.theme) {
    stampWorkspaceTheme(projectPath, target)
    notifyConfigChanged(projectPath)
  }
}

// --- Workspace theming ---
//
// A workspace owns the theme for every project inside it, so all projects in a
// workspace look identical and different workspaces are told apart at a glance.
// The workspace theme always wins over the project's own `.forgeterm.json`.

/** The workspace that owns this project's theme, if any. */
function findWorkspaceForProject(projectPath: string): Workspace | null {
  if (!projectPath) return null
  const resolved = path.resolve(projectPath)
  return loadWorkspaces().find((ws) => ws.projects.includes(resolved)) || null
}

/** Overlay a workspace theme onto a project config, keeping the project's emoji. */
function withWorkspaceTheme(config: ForgeTermConfig | null, ws: Workspace | null): ForgeTermConfig {
  const base = config || {}
  if (!ws?.theme) return base
  const emoji = base.window?.emoji
  return {
    ...base,
    window: { ...ws.theme.window, ...(emoji ? { emoji } : {}) },
    theme: { ...ws.theme.theme },
    terminalTheme: ws.theme.terminalTheme,
  }
}

/** Config as the renderer should see it: project file with the workspace theme applied. */
function loadEffectiveConfig(projectPath: string): ForgeTermConfig | null {
  const config = loadConfig(projectPath)
  const ws = findWorkspaceForProject(projectPath)
  if (!ws?.theme) return config
  return withWorkspaceTheme(config, ws)
}

/** Stamp a workspace's theme into one project's config file. */
function stampWorkspaceTheme(projectPath: string, ws: Workspace) {
  if (!ws.theme || !fs.existsSync(projectPath)) return
  saveConfig(projectPath, withWorkspaceTheme(loadConfig(projectPath), ws))
}

/** Stamp a workspace's theme into every member project and repaint open windows. */
function propagateWorkspaceTheme(ws: Workspace) {
  if (!ws.theme) return
  for (const projectPath of ws.projects) {
    stampWorkspaceTheme(projectPath, ws)
    notifyConfigChanged(projectPath)
  }
}

function presetToWorkspaceTheme(preset: (typeof PRESET_THEMES)[number]): WorkspaceTheme {
  return {
    window: { ...preset.window, themeName: preset.id },
    theme: { ...preset.terminal, cursor: preset.window.accentColor },
    terminalTheme: preset.terminalMode,
  }
}

/** Build a workspace theme from a bare accent hex (used by the color field). */
function accentToWorkspaceTheme(accent: string): WorkspaceTheme {
  const terminal = getTerminalTheme('dark')
  terminal.cursor = accent
  return { window: generateWindowTheme(accent), theme: terminal, terminalTheme: 'dark' }
}

/** Pull the theme portion out of a project config, ignoring the per-project emoji. */
function extractTheme(config: ForgeTermConfig): WorkspaceTheme | null {
  if (!config.window?.accentColor || !config.theme) return null
  const { emoji: _emoji, ...window } = config.window
  return { window, theme: config.theme, terminalTheme: config.terminalTheme || 'dark' }
}

/** Key-order-insensitive compare, so a renderer round-trip isn't seen as an edit. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  )
}

function setWorkspaceTheme(name: string, theme: WorkspaceTheme) {
  const workspaces = loadWorkspaces()
  const ws = workspaces.find((w) => w.name === name)
  if (!ws) return
  ws.theme = theme
  ws.accentColor = theme.window.accentColor
  saveWorkspaces(workspaces)
  propagateWorkspaceTheme(ws)
}

function removeProjectFromWorkspace(projectPath: string) {
  const workspaces = loadWorkspaces()
  for (const ws of workspaces) {
    ws.projects = ws.projects.filter((p) => p !== projectPath)
  }
  const cleaned = workspaces.filter((ws) => ws.projects.length > 0)
  saveWorkspaces(cleaned)
}

function getWorkspaceForProject(projectPath: string): string | undefined {
  const workspaces = loadWorkspaces()
  return workspaces.find((ws) => ws.projects.includes(projectPath))?.name
}

// Resolve the Claude CLI name + resume args for a project.
// Precedence: project config -> its workspace -> defaults ("claude", skip-permissions on).
function resolveClaudeLaunch(projectPath?: string): import('../shared/types').ClaudeLaunch {
  const config = projectPath ? loadConfig(projectPath) : null
  const ws = projectPath
    ? loadWorkspaces().find((w) => w.projects.includes(projectPath))
    : undefined
  const cliName = config?.claudeCliName || ws?.claudeCliName || 'claude'
  const skip = config?.dangerouslySkipPermissions ?? ws?.dangerouslySkipPermissions ?? true
  const resumeArgs = config?.claudeResumeArgs && config.claudeResumeArgs.length > 0
    ? config.claudeResumeArgs
    : (skip ? ['--dangerously-skip-permissions'] : [])
  return { cliName, resumeArgs }
}

// --- Claude Code connection check ---

interface ClaudeConnectionStatus {
  connected: boolean
  currentVersion: string
  promptedVersion: string | null
  needsUpdate: boolean
}

function checkClaudeConnection(): ClaudeConnectionStatus {
  const currentVersion = app.getVersion()
  const claudeMdPath = path.join(app.getPath('home'), '.claude', 'CLAUDE.md')

  try {
    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    const match = content.match(/<!-- forgeterm:v:(\S+) -->/)
    if (match) {
      const promptedVersion = match[1]
      return {
        connected: true,
        currentVersion,
        promptedVersion,
        needsUpdate: promptedVersion !== currentVersion,
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return { connected: false, currentVersion, promptedVersion: null, needsUpdate: true }
}

function getClaudeSetupPrompt(): string {
  const version = app.getVersion()
  return `I use ForgeTerm as my terminal for Claude Code. Please update my global Claude Code instructions (~/.claude/CLAUDE.md) to include the ForgeTerm integration section below.

IMPORTANT: If there's already a "ForgeTerm Integration" section in ~/.claude/CLAUDE.md, replace it entirely with the new version below. If not, add it.

The section MUST end with this exact comment (it's how ForgeTerm detects the connection):
<!-- forgeterm:v:${version} -->

Here is the section to add/replace:

---

## ForgeTerm Integration

Nadav uses ForgeTerm as his only terminal for Claude Code. ForgeTerm exposes a CLI (\`ft\`, also available as \`forgeterm\`) that communicates with the running app over a Unix socket. Use these commands proactively to keep the ForgeTerm UI informative.

### Session Rename
When the user gives their first real task in a conversation, rename the session to reflect the work:
\`\`\`bash
ft rename "Refactoring auth middleware"
\`\`\`
- Keep it short (2-5 words), descriptive of the task
- Update it if the task changes significantly mid-conversation
- Only works inside a ForgeTerm session (env vars \`FORGETERM_SESSION_ID\` and \`FORGETERM_PROJECT_PATH\` are set automatically)

### Session Info Card
Update the sidebar info card at key milestones so the user can glance at what's happening:
\`\`\`bash
ft info \\
  --title "Refactoring auth middleware" \\
  --summary "Splitting auth.ts into JWT and session modules. 3 files changed so far." \\
  --last "Extracted JWT validation into jwt.ts"
\`\`\`
- \`--title\`: One-line description of the current task
- \`--summary\`: 1-2 sentences on current state/progress
- \`--last\`: What was just completed
- \`--action "Review the PR"\`: (Optional) When something needs the user's attention
- Update info after completing a significant step, not after every small edit
- Good moments to update: after finishing a subtask, before/after a build, when blocked or waiting for input

### Context Usage
Report your context window usage so the sidebar shows a visual ring indicator per session:
\`\`\`bash
ft context 42   # 42% of context used
\`\`\`
- Report context usage after each significant interaction (every few messages)
- The number is 0-100 representing the percentage of your context window consumed
- ForgeTerm shows this as a ring around the session indicator dot in the sidebar
- When context gets high (>80%), the ring turns red as a visual warning
- If you know your approximate context usage, report it periodically

### Notifications
Send native macOS notifications for events the user should see even if they're not looking at the terminal:
\`\`\`bash
ft notify "Done"
ft notify "Build failed" --title "CI"
\`\`\`
- After completing a task: \`ft notify "Done"\` (or a short relevant message)
- After long-running commands: \`command && ft notify "Success" || ft notify "Failed"\`
- When blocked and needing human input: \`ft notify "Need your input"\`
- Clicking the notification focuses the correct ForgeTerm window and session

### Full CLI Reference
\`\`\`
ft notify "msg"                        # Send notification
ft rename "name"                       # Rename current session
ft close                               # Close (delete) the current session, like Cmd+W
ft info --title ... --summary ...      # Update session info card
ft context <0-100>                     # Report context window usage %
ft open <path>                         # Open a project
ft list                                # List recent projects

ft project list|open|remove            # Manage projects
ft session list|add|remove             # Manage sessions (--project <path>)
ft workspace list|create|delete|rename # Manage workspaces
ft workspace add-project|remove-project|open|update
ft config get [key] [--project <path>] # Read project config
ft config set <key> <value>            # Write project config
ft theme list|set|terminal|favorites   # Manage themes
\`\`\`

### Typical Flow
1. User gives a task -> \`ft rename "Fix login bug"\`
2. Start working -> \`ft info --title "Fix login bug" --summary "Investigating auth flow" --last "Reading auth middleware"\`
3. Make progress -> update info with \`--last "Found root cause in session.ts"\` and \`ft context 35\`
4. Finish -> \`ft info ... --last "Fixed and tested"\` then \`ft notify "Done"\`

<!-- forgeterm:v:${version} -->

---

After updating CLAUDE.md, confirm the change was made.`
}

// --- Session state persistence ---

function getSavedSessionsPath(): string {
  return path.join(app.getPath('userData'), 'saved-sessions.json')
}

function loadSavedSessions(): SavedWindowState[] {
  try {
    return JSON.parse(fs.readFileSync(getSavedSessionsPath(), 'utf-8')) as SavedWindowState[]
  } catch {
    return []
  }
}

function saveSavedSessions(states: SavedWindowState[]) {
  fs.writeFileSync(getSavedSessionsPath(), JSON.stringify(states, null, 2), 'utf-8')
}

const execFileAsync = promisify(execFile)

// Build a pid -> child-pids map from a single `ps` snapshot. This replaces a
// recursive, synchronous `pgrep -P` spawn per process in every session tree
// (which blocked the main event loop for seconds on busy machines) with one
// async spawn for the whole app.
async function snapshotProcessTree(): Promise<Map<number, number[]>> {
  const children = new Map<number, number[]>()
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], { timeout: 4000 })
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!m) continue
      const pid = Number(m[1])
      const ppid = Number(m[2])
      const arr = children.get(ppid)
      if (arr) arr.push(pid)
      else children.set(ppid, [pid])
    }
  } catch { /* `ps` unavailable; caller treats an empty tree as "nothing found" */ }
  return children
}

// Walk a shell's process subtree in memory (no spawning) looking for a child
// Claude process that has recorded ~/.claude/sessions/{pid}.json, and return its
// sessionId.
function findClaudeSessionIdInTree(shellPid: number, childMap: Map<number, number[]>): string | null {
  const claudeSessionsDir = path.join(app.getPath('home'), '.claude', 'sessions')
  const stack = [...(childMap.get(shellPid) ?? [])]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    try {
      const data = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir, `${pid}.json`), 'utf-8'))
      if (data.sessionId) return data.sessionId as string
    } catch { /* not a Claude session */ }
    const kids = childMap.get(pid)
    if (kids) stack.push(...kids)
  }
  return null
}

function saveWindowSessionState(state: WindowState) {
  if (!state.projectPath) return
  const sessions = state.ptyManager.getAllSessions()
  const allSaved = loadSavedSessions()
  const filtered = allSaved.filter(s => s.projectPath !== state.projectPath)

  // No sessions left: drop the saved entry so reopening doesn't restore ghosts.
  if (sessions.length === 0) {
    saveSavedSessions(filtered)
    return
  }

  const savedSessions: SavedSession[] = sessions.map((s, index) => ({
    name: s.name,
    command: s.command,
    wasRunning: s.running,
    // Conversation id is kept current by the periodic poller and the SessionStart
    // hook; never do a blocking process scan here (this runs on a debounce and at quit).
    claudeSessionId: s.conversationId,
    info: s.info,
    order: index,
    nameLocked: s.nameLocked,
  }))

  const activeSession = sessions.find(s => s.id === state.activeSessionId)
  filtered.push({
    projectPath: state.projectPath,
    sessions: savedSessions,
    activeSessionName: activeSession?.name,
    savedAt: Date.now(),
  })
  saveSavedSessions(filtered)
}

// Debounced persistence: save a window's session state shortly after any change
// (create / delete / rename / info / conversation update) so a crash or force-quit
// never loses more than the debounce window.
const persistTimers = new Map<number, NodeJS.Timeout>()
function schedulePersist(winId: number) {
  const existing = persistTimers.get(winId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    persistTimers.delete(winId)
    const state = windowStates.get(winId)
    if (state) saveWindowSessionState(state)
  }, 800)
  timer.unref?.()
  persistTimers.set(winId, timer)
}

// Periodically reconcile each running session's Claude conversation id from the
// live ~/.claude/sessions/{pid}.json files. This is the always-on fallback that
// works even without the SessionStart hook installed.
//
// Performance: only sessions whose id we don't yet know are scanned (a Claude
// session id is stable for the life of its process, and the SessionStart hook
// reports restarts authoritatively), and the whole reconcile uses a single async
// `ps` snapshot rather than a recursive synchronous `pgrep` walk per session, so
// it never blocks the main process event loop.
let detectingConversationIds = false
async function detectConversationIds() {
  if (detectingConversationIds) return

  // Gather running sessions that still need an id; skip ones we already know.
  const pending: Array<{ winId: number; win: BrowserWindow; sessionId: string; shellPid: number }> = []
  for (const [winId, state] of windowStates) {
    const win = BrowserWindow.fromId(winId)
    if (!win || win.isDestroyed()) continue
    for (const s of state.ptyManager.getAllSessions()) {
      if (!s.running || !s.pid || s.conversationId) continue
      pending.push({ winId, win, sessionId: s.id, shellPid: s.pid })
    }
  }
  if (pending.length === 0) return

  detectingConversationIds = true
  try {
    const childMap = await snapshotProcessTree()
    const changedWins = new Set<number>()
    for (const { winId, win, sessionId, shellPid } of pending) {
      if (win.isDestroyed()) continue
      const state = windowStates.get(winId)
      if (!state) continue
      const detected = findClaudeSessionIdInTree(shellPid, childMap)
      if (detected) {
        state.ptyManager.setConversationId(sessionId, detected)
        win.webContents.send('session:conversation-updated', sessionId, detected)
        changedWins.add(winId)
      }
    }
    for (const winId of changedWins) schedulePersist(winId)
  } finally {
    detectingConversationIds = false
  }
}
const conversationDetectInterval = setInterval(() => { void detectConversationIds() }, 15_000)
conversationDetectInterval.unref?.()

// --- Window tiling ---

function calculateTilePositions(count: number, workArea: Electron.Rectangle): Electron.Rectangle[] {
  const { x, y, width, height } = workArea
  const gap = 0

  if (count <= 0) return []
  if (count === 1) return [{ x, y, width, height }]

  if (count === 2) {
    const w = Math.floor(width / 2)
    return [
      { x, y, width: w, height },
      { x: x + w + gap, y, width: width - w - gap, height },
    ]
  }

  if (count === 3) {
    // Master left, two stacked right
    const masterW = Math.floor(width / 2)
    const stackW = width - masterW - gap
    const halfH = Math.floor(height / 2)
    return [
      { x, y, width: masterW, height },
      { x: x + masterW + gap, y, width: stackW, height: halfH },
      { x: x + masterW + gap, y: y + halfH + gap, width: stackW, height: height - halfH - gap },
    ]
  }

  if (count === 4) {
    // 2x2 grid
    const w = Math.floor(width / 2)
    const h = Math.floor(height / 2)
    return [
      { x, y, width: w, height: h },
      { x: x + w + gap, y, width: width - w - gap, height: h },
      { x, y: y + h + gap, width: w, height: height - h - gap },
      { x: x + w + gap, y: y + h + gap, width: width - w - gap, height: height - h - gap },
    ]
  }

  if (count === 5) {
    // Top row: 3, bottom row: 2
    const h = Math.floor(height / 2)
    const topW = Math.floor(width / 3)
    const botW = Math.floor(width / 2)
    return [
      { x, y, width: topW, height: h },
      { x: x + topW + gap, y, width: topW, height: h },
      { x: x + topW * 2 + gap * 2, y, width: width - topW * 2 - gap * 2, height: h },
      { x, y: y + h + gap, width: botW, height: height - h - gap },
      { x: x + botW + gap, y: y + h + gap, width: width - botW - gap, height: height - h - gap },
    ]
  }

  // 6: 2x3 grid (2 rows, 3 columns)
  const colW = Math.floor(width / 3)
  const rowH = Math.floor(height / 2)
  const positions: Electron.Rectangle[] = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const isLastCol = col === 2
      const isLastRow = row === 1
      positions.push({
        x: x + col * (colW + gap),
        y: y + row * (rowH + gap),
        width: isLastCol ? width - colW * 2 - gap * 2 : colW,
        height: isLastRow ? height - rowH - gap : rowH,
      })
    }
  }
  return positions.slice(0, count)
}

function tileWindows(windows: BrowserWindow[], displayIndices?: number[]) {
  if (windows.length === 0) return

  const allDisplays = screen.getAllDisplays()

  // Determine which displays to use
  let targetDisplays: Electron.Display[]
  if (displayIndices && displayIndices.length > 0) {
    targetDisplays = displayIndices
      .filter((i) => i >= 0 && i < allDisplays.length)
      .map((i) => allDisplays[i])
    if (targetDisplays.length === 0) targetDisplays = [allDisplays[0]]
  } else {
    targetDisplays = [screen.getDisplayMatching(windows[0].getBounds())]
  }

  // Distribute windows across selected displays as evenly as possible
  const screenCount = targetDisplays.length
  const base = Math.floor(windows.length / screenCount)
  const extra = windows.length % screenCount

  const allTiles: Electron.Rectangle[] = []
  let windowIdx = 0
  for (let s = 0; s < screenCount; s++) {
    const count = base + (s < extra ? 1 : 0)
    if (count === 0) continue
    const tiles = calculateTilePositions(count, targetDisplays[s].workArea)
    allTiles.push(...tiles)
    windowIdx += count
  }

  windows.forEach((win, i) => {
    if (allTiles[i]) {
      win.setBounds(allTiles[i], true)
    }
  })
}

const DEFAULT_CONFIG: ForgeTermConfig = {
  theme: {
    background: '#0f172a',
    foreground: '#e2e8f0',
    cursor: '#38bdf8',
    selection: 'rgba(56, 189, 248, 0.3)',
    black: '#1e293b',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#f1f5f9',
  },
  font: {
    family: 'JetBrains Mono, Menlo, Monaco, monospace',
    size: 13,
  },
  terminalTheme: 'dark' as const,
  window: {
    accentColor: '#38bdf8',
    titlebarBackground: '#0f1a2e',
    titlebarBackgroundEnd: '#162640',
    titlebarForeground: '#8faabe',
    sidebarBackground: '#111b2e',
    sidebarForeground: '#8faabe',
    buttonBackground: '#1c2d4d',
    themeName: 'midnight',
  },
  sessions: [],
}

// --- Peacock sync ---

function readPeacockColor(projectPath: string): string | null {
  const settingsPath = path.join(projectPath, '.vscode', 'settings.json')
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const settings = JSON.parse(raw)
    const color = settings['peacock.color']
    if (typeof color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(color.trim())) {
      return color.startsWith('#') ? color.trim() : `#${color.trim()}`
    }
    return null
  } catch {
    return null
  }
}

function autoAssignThemeIfNeeded(projectPath: string) {
  // A themed workspace owns the look: keep the project file in sync and skip
  // Peacock / random assignment entirely.
  const ws = findWorkspaceForProject(projectPath)
  if (ws?.theme) {
    stampWorkspaceTheme(projectPath, ws)
    return
  }

  const config = loadConfig(projectPath)
  // Only apply if no existing window theme
  if (config?.window?.accentColor) return

  // Try Peacock color first
  const peacockColor = readPeacockColor(projectPath)
  if (peacockColor) {
    const windowTheme = generateWindowTheme(peacockColor)
    const terminalColors = getTerminalTheme('dark')
    const newConfig: ForgeTermConfig = {
      ...config,
      window: { ...windowTheme, themeName: 'peacock' },
      theme: terminalColors,
      terminalTheme: 'dark',
    }
    saveConfig(projectPath, newConfig)
    return
  }

  // "Surprise me" - assign a random preset theme
  const preset = PRESET_THEMES[Math.floor(Math.random() * PRESET_THEMES.length)]
  const terminalColors = getTerminalTheme('dark')
  const newConfig: ForgeTermConfig = {
    ...config,
    window: { ...preset.window, themeName: preset.id },
    theme: terminalColors,
    terminalTheme: 'dark',
  }
  saveConfig(projectPath, newConfig)
}

function loadConfig(projectPath: string): ForgeTermConfig | null {
  const configPath = path.join(projectPath, '.forgeterm.json')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as ForgeTermConfig
  } catch {
    return null
  }
}

function saveConfig(projectPath: string, config: ForgeTermConfig) {
  const configPath = path.join(projectPath, '.forgeterm.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function watchConfig(win: BrowserWindow, projectPath: string) {
  const configPath = path.join(projectPath, '.forgeterm.json')
  try {
    const watcher = fs.watch(configPath, () => {
      if (!win.isDestroyed()) {
        win.webContents.send('config:changed')
      }
    })
    return watcher
  } catch {
    // File doesn't exist yet - watch the directory instead
    try {
      const watcher = fs.watch(projectPath, (_, filename) => {
        if (filename === '.forgeterm.json' && !win.isDestroyed()) {
          win.webContents.send('config:changed')
        }
      })
      return watcher
    } catch {
      return undefined
    }
  }
}

function findWindowForProject(projectPath: string): BrowserWindow | null {
  for (const [winId, state] of windowStates) {
    if (state.projectPath === projectPath) {
      const win = BrowserWindow.fromId(winId)
      if (win && !win.isDestroyed()) return win
    }
  }
  return null
}

function focusOrCreateWindow(projectPath: string): BrowserWindow {
  const existing = findWindowForProject(projectPath)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    // macOS won't raise a background app from BrowserWindow.focus() alone
    // (Electron calls activateIgnoringOtherApps:NO, and focus() no-ops on a
    // window that isn't visible), so bring the app forward first.
    if (process.platform === 'darwin') app.focus({ steal: true })
    existing.show()
    existing.focus()
    return existing
  }
  return createProjectWindow(projectPath)
}

let dashboardWindow: BrowserWindow | null = null
let dashboardUpdateInterval: ReturnType<typeof setInterval> | null = null
let dashboardPushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Push a fresh snapshot to the Control Panel, coalescing bursts into one send
 * on the next tick. Called from every source that changes what the panel shows
 * (activity reports, `ft activity`, `ft context`, window open/close), so the
 * board reacts immediately instead of waiting out the safety-net poll.
 */
function pushDashboardState(): void {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return
  if (dashboardPushTimer) return
  dashboardPushTimer = setTimeout(() => {
    dashboardPushTimer = null
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('dashboard:state-changed', getDashboardState())
    }
  }, 120)
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore()
    // Raising a window from a tray click or global shortcut needs the app
    // itself brought forward on macOS, otherwise it stays behind everything.
    if (process.platform === 'darwin') app.focus({ steal: true })
    dashboardWindow.show()
    dashboardWindow.focus()
    return dashboardWindow
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  dashboardWindow = new BrowserWindow({
    width: Math.min(1180, width),
    height: Math.min(860, height),
    minWidth: 620,
    minHeight: 420,
    title: 'ForgeTerm Control Panel',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  dashboardWindow.on('closed', () => {
    dashboardWindow = null
    if (dashboardUpdateInterval) {
      clearInterval(dashboardUpdateInterval)
      dashboardUpdateInterval = null
    }
    if (dashboardPushTimer) {
      clearTimeout(dashboardPushTimer)
      dashboardPushTimer = null
    }
  })

  dashboardWindow.once('ready-to-show', () => {
    if (process.platform === 'darwin') app.focus({ steal: true })
    dashboardWindow?.show()
    dashboardWindow?.focus()
  })

  const url = VITE_DEV_SERVER_URL
    ? `${VITE_DEV_SERVER_URL}?mode=dashboard`
    : `file://${path.join(RENDERER_DIST, 'index.html')}?mode=dashboard`

  if (VITE_DEV_SERVER_URL) {
    dashboardWindow.loadURL(url)
  } else {
    dashboardWindow.loadFile(path.join(RENDERER_DIST, 'index.html'), { query: { mode: 'dashboard' } })
  }

  // Safety net behind pushDashboardState(): keeps elapsed times honest and
  // covers any state change that forgets to push.
  dashboardUpdateInterval = setInterval(() => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('dashboard:state-changed', getDashboardState())
    }
  }, 5000)

  return dashboardWindow
}

function createProjectWindow(projectPath: string | null) {
  if (projectPath) {
    autoAssignThemeIfNeeded(projectPath)
    saveRecentProject(projectPath)
  }
  const folderName = projectPath ? path.basename(projectPath) : 'ForgeTerm'

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: folderName,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const ptyManager = new PtyManager()
  const configWatcher = projectPath ? watchConfig(win, projectPath) : undefined

  windowStates.set(win.id, {
    projectPath: projectPath ?? '',
    ptyManager,
    configWatcher,
  })

  win.on('closed', () => {
    const state = windowStates.get(win.id)
    if (state) {
      // Save to session history before killing
      if (state.projectPath) {
        const workspace = getWorkspaceForProject(state.projectPath)
        for (const session of state.ptyManager.getAllSessions()) {
          appendToHistory(state.projectPath, {
            id: session.id,
            name: session.name,
            command: session.command,
            projectPath: state.projectPath,
            workspace,
            createdAt: session.createdAt,
            endedAt: Date.now(),
            info: session.info,
            conversationId: session.conversationId,
          })
        }
      }
      saveWindowSessionState(state)
      state.ptyManager.killAll()
      state.configWatcher?.close()
      windowStates.delete(win.id)
    }
    windowActivities.delete(win.id)
    updateTrayMenu()
    updateDockBadge()
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  return win
}

function getStateForEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null
  return windowStates.get(win.id) ?? null
}

// --- Editor detection for Project Manager import ---

function getEditorCandidates(): { name: string; path: string }[] {
  const home = app.getPath('home')
  const pmSuffix = 'User/globalStorage/alefragnani.project-manager/projects.json'

  const macEditors = [
    { name: 'VS Code', dir: 'Code' },
    { name: 'Cursor', dir: 'Cursor' },
    { name: 'Windsurf', dir: 'Windsurf' },
    { name: 'VSCodium', dir: 'VSCodium' },
    { name: 'VS Code Insiders', dir: 'Code - Insiders' },
  ]

  const candidates: { name: string; path: string }[] = []

  // macOS paths
  for (const editor of macEditors) {
    candidates.push({
      name: editor.name,
      path: path.join(home, 'Library/Application Support', editor.dir, pmSuffix),
    })
  }

  // Linux paths
  for (const editor of macEditors) {
    candidates.push({
      name: editor.name,
      path: path.join(home, '.config', editor.dir, pmSuffix),
    })
  }

  // Windows paths
  const appData = process.env.APPDATA
  if (appData) {
    for (const editor of macEditors) {
      candidates.push({
        name: editor.name,
        path: path.join(appData, editor.dir, pmSuffix),
      })
    }
  }

  return candidates
}

function detectProjectManagerFiles(): DetectedEditor[] {
  return getEditorCandidates()
    .filter((c) => fs.existsSync(c.path))
    .map((c) => ({ name: c.name, path: c.path }))
}

function getImportDismissedPath(): string {
  return path.join(app.getPath('userData'), 'import-dismissed.json')
}

function isImportDismissed(): boolean {
  try {
    return fs.existsSync(getImportDismissedPath())
  } catch {
    return false
  }
}

function importProjectsFromFile(filePath: string): ImportResult | null {
  interface VSCodeProject {
    name: string
    rootPath: string
    tags: string[]
    enabled: boolean
    workspace?: string
  }

  let vsProjects: VSCodeProject[]
  try {
    vsProjects = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }

  const enabledProjects = vsProjects.filter((p) => p.enabled && p.rootPath)

  const existingRecent = loadRecentProjects()
  const existingPaths = new Set(existingRecent.map((p) => p.path))
  const existingWorkspaces = loadWorkspaces()
  const existingWsNames = new Set(existingWorkspaces.map((ws) => ws.name))

  const wsMap = new Map<string, Set<string>>()
  for (const ws of existingWorkspaces) {
    wsMap.set(ws.name, new Set(ws.projects))
  }

  const tagProjects = new Map<string, string[]>()
  for (const p of enabledProjects) {
    if (p.tags && p.tags.length > 0) {
      for (const tag of p.tags) {
        if (!tagProjects.has(tag)) tagProjects.set(tag, [])
        tagProjects.get(tag)!.push(p.rootPath)
      }
    }
  }

  const tagWorkspaces = new Map<string, string[]>()
  for (const [tag, paths] of tagProjects) {
    if (paths.length >= 2) {
      tagWorkspaces.set(tag, paths)
    }
  }

  let projectsAdded = 0
  const workspacesCreated: string[] = []
  const workspacesUpdated = new Set<string>()

  const newRecent = [...existingRecent]
  for (const p of enabledProjects) {
    if (!existingPaths.has(p.rootPath)) {
      newRecent.push({
        path: p.rootPath,
        name: p.name,
        lastOpened: 0,
        workspace: p.workspace || undefined,
      })
      existingPaths.add(p.rootPath)
      projectsAdded++
    } else if (p.workspace) {
      const existing = newRecent.find((r) => r.path === p.rootPath)
      if (existing && existing.workspace !== p.workspace) {
        existing.workspace = p.workspace
      }
    }

    if (p.workspace) {
      if (!wsMap.has(p.workspace)) {
        wsMap.set(p.workspace, new Set())
      }
      const ws = wsMap.get(p.workspace)!
      if (!ws.has(p.rootPath)) {
        ws.add(p.rootPath)
        if (existingWsNames.has(p.workspace)) {
          workspacesUpdated.add(p.workspace)
        }
      }
    }
  }

  const projectsWithExplicitWs = new Set(
    enabledProjects.filter((p) => p.workspace).map((p) => p.rootPath),
  )
  for (const [tag, paths] of tagWorkspaces) {
    const unassigned = paths.filter((p) => !projectsWithExplicitWs.has(p))
    if (unassigned.length >= 2) {
      if (!wsMap.has(tag)) {
        wsMap.set(tag, new Set())
      }
      const ws = wsMap.get(tag)!
      for (const p of unassigned) {
        ws.add(p)
      }
      for (const rp of newRecent) {
        if (unassigned.includes(rp.path) && !rp.workspace) {
          rp.workspace = tag
        }
      }
    }
  }

  for (const [name] of wsMap) {
    if (!existingWsNames.has(name)) {
      workspacesCreated.push(name)
    }
  }

  fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(newRecent, null, 2), 'utf-8')

  const finalWorkspaces: Workspace[] = []
  for (const [name, paths] of wsMap) {
    if (paths.size === 0) continue
    const existing = existingWorkspaces.find((ws) => ws.name === name)
    finalWorkspaces.push({
      name,
      projects: Array.from(paths),
      arrange: existing?.arrange ?? true,
    })
  }
  saveWorkspaces(finalWorkspaces)

  return {
    projectsAdded,
    workspacesCreated,
    workspacesUpdated: Array.from(workspacesUpdated),
  }
}

// --- Tray menu & dock badge ---

function createTray() {
  // Create a 18x18 monochrome terminal icon as a template image
  // Using a simple >_ prompt icon drawn as raw pixel data
  const size = 32
  const buf = Buffer.alloc(size * size * 4, 0)
  function setPixel(x: number, y: number) {
    if (x < 0 || x >= size || y < 0 || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255
  }
  function line(x0: number, y0: number, x1: number, y1: number, thickness = 2) {
    const dx = x1 - x0, dy = y1 - y0
    const steps = Math.max(Math.abs(dx), Math.abs(dy))
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + (dx * s) / steps)
      const y = Math.round(y0 + (dy * s) / steps)
      for (let t = 0; t < thickness; t++) {
        setPixel(x, y + t)
        setPixel(x + t, y)
      }
    }
  }
  // Draw > arrow (chevron)
  line(6, 8, 14, 16, 2)
  line(14, 16, 6, 24, 2)
  // Draw _ underscore
  line(17, 24, 26, 24, 2)
  line(17, 25, 26, 25, 1)

  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 2 })
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('ForgeTerm')
  updateTrayMenu()
}

// Raise a window so the user really sees it. macOS needs the app activated
// first; focus() alone leaves it behind whatever is frontmost.
function raiseWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.show()
  win.focus()
}

function updateTrayMenu() {
  if (!tray) return

  const menuItems: Electron.MenuItemConstructorOptions[] = []

  // Control Panel at top
  menuItems.push({
    label: 'Control Panel',
    accelerator: 'CmdOrCtrl+Shift+D',
    click: () => createDashboardWindow(),
  })
  menuItems.push({ type: 'separator' })

  const workspaces = loadWorkspaces()

  // Map project paths to their first workspace
  const pathToWorkspace = new Map<string, Workspace>()
  for (const ws of workspaces) {
    for (const p of ws.projects) {
      if (!pathToWorkspace.has(p)) pathToWorkspace.set(p, ws)
    }
  }

  // Group open windows by workspace vs standalone
  const workspaceWindowMap = new Map<string, number[]>()
  const standaloneWindows: number[] = []

  for (const [winId] of windowStates) {
    const win = BrowserWindow.fromId(winId)
    if (!win || win.isDestroyed()) continue
    const state = windowStates.get(winId)!
    const ws = pathToWorkspace.get(state.projectPath)
    if (ws) {
      const list = workspaceWindowMap.get(ws.name) || []
      list.push(winId)
      workspaceWindowMap.set(ws.name, list)
    } else {
      standaloneWindows.push(winId)
    }
  }

  // Helper: add project + session items for one window
  const addProjectItems = (winId: number, indent: string) => {
    const win = BrowserWindow.fromId(winId)
    if (!win || win.isDestroyed()) return
    const state = windowStates.get(winId)
    const activity = windowActivities.get(winId)

    if (activity) {
      const hasWorking = activity.sessions.some((s) => s.status === 'working')
      const hasUnread = activity.sessions.some((s) => s.status === 'unread')
      const statusPrefix = hasWorking ? '\u{1F7E2} ' : hasUnread ? '\u{1F7E1} ' : ''
      menuItems.push({
        label: `${indent}${statusPrefix}${activity.projectName}`,
        click: () => raiseWindow(win),
      })
      for (const session of activity.sessions) {
        const dot = session.status === 'working' ? '\u25CF' :
                    session.status === 'unread' ? '\u25C9' : '\u25CB'
        menuItems.push({
          label: `${indent}  ${dot} ${session.sessionName}`,
          click: () => {
            raiseWindow(win)
            win.webContents.send('notification:focus-session', session.sessionId)
          },
        })
      }
    } else if (state) {
      const config = loadConfig(state.projectPath)
      const name = config?.projectName || path.basename(state.projectPath) || 'ForgeTerm'
      menuItems.push({
        label: `${indent}${name}`,
        click: () => raiseWindow(win),
      })
    }
  }

  // 1. Workspaces with open windows
  for (const [wsName, winIds] of workspaceWindowMap) {
    const ws = workspaces.find((w) => w.name === wsName)!
    const prefix = ws.emoji ? `${ws.emoji} ` : ''
    menuItems.push({
      label: `${prefix}${wsName}`,
      click: () => openWorkspaceFromTray(ws),
    })
    for (const winId of winIds) {
      addProjectItems(winId, '  ')
    }
    menuItems.push({ type: 'separator' })
  }

  // 2. Standalone projects (not in any workspace)
  for (const winId of standaloneWindows) {
    addProjectItems(winId, '')
    menuItems.push({ type: 'separator' })
  }

  // 3. Closed workspaces (no open windows) - clickable to launch
  const closedWorkspaces = workspaces.filter((ws) => !workspaceWindowMap.has(ws.name))
  for (const ws of closedWorkspaces) {
    const prefix = ws.emoji ? `${ws.emoji} ` : ''
    menuItems.push({
      label: `${prefix}${ws.name}`,
      click: () => openWorkspaceFromTray(ws),
    })
  }
  if (closedWorkspaces.length > 0) menuItems.push({ type: 'separator' })

  // 4. Actions
  menuItems.push({
    label: 'New Window...',
    click: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        focusOrCreateWindow(result.filePaths[0])
      }
    },
  })
  menuItems.push({ type: 'separator' })
  menuItems.push({ label: 'Quit ForgeTerm', click: () => app.quit() })

  tray.setContextMenu(Menu.buildFromTemplate(menuItems))
}

function openWorkspaceFromTray(ws: Workspace) {
  const disabled = new Set(ws.disabledProjects || [])
  const enabledPaths = ws.projects.filter((p) => !disabled.has(p))
  const windows: BrowserWindow[] = []
  for (const projectPath of enabledPaths) {
    windows.push(focusOrCreateWindow(projectPath))
  }
  if (ws.arrange !== false) {
    const displayCount = screen.getAllDisplays().length
    const key = String(displayCount)
    const indices = ws.screenPrefs?.[key]
    tileWindows(windows, indices)
  }
  if (ws.defaultCommand) {
    const cmd = ws.defaultCommand
    setTimeout(() => {
      for (const win of windows) {
        const state = windowStates.get(win.id)
        if (state) {
          const firstSession = state.ptyManager.getFirstSessionId()
          if (firstSession) state.ptyManager.write(firstSession, cmd + '\n')
        }
      }
    }, 1500)
  }
}

function updateDockBadge() {
  if (process.platform !== 'darwin') return
  let totalUnread = 0
  let totalWorking = 0
  for (const [, info] of windowActivities) {
    totalUnread += info.sessions.filter((s) => s.status === 'unread').length
    totalWorking += info.sessions.filter((s) => s.status === 'working').length
  }
  app.dock.setBadge(totalUnread > 0 ? String(totalUnread) : '')

  // The menu-bar icon carries the same headline, so the count is visible even
  // when every ForgeTerm window (and the Dock) is buried.
  if (tray && !tray.isDestroyed()) {
    tray.setTitle(totalUnread > 0 ? ` ${totalUnread}` : '')
    const parts: string[] = []
    if (totalUnread > 0) parts.push(`${totalUnread} waiting on you`)
    if (totalWorking > 0) parts.push(`${totalWorking} working`)
    tray.setToolTip(parts.length ? `ForgeTerm - ${parts.join(', ')}` : 'ForgeTerm')
  }
}

function setupIpcHandlers() {
  ipcMain.handle('session:create', (event, name: string, command?: string, idle?: boolean, nameLocked?: boolean) => {
    const state = getStateForEvent(event)
    if (!state) return null

    const win = BrowserWindow.fromWebContents(event.sender)!
    const id = state.ptyManager.createSession({
      name,
      command,
      idle,
      nameLocked,
      cwd: state.projectPath,
      socketPath: getSocketPath(),
      onData: (sessionId, data) => {
        if (!win.isDestroyed()) {
          win.webContents.send('session:data', sessionId, data)
        }
      },
      onExit: (sessionId, exitCode) => {
        if (!win.isDestroyed()) {
          win.webContents.send('session:exit', sessionId, exitCode)
        }
      },
    })
    schedulePersist(win.id)
    return id
  })

  ipcMain.handle('session:take-pending-starts', (event) => {
    const state = getStateForEvent(event)
    if (!state?.projectPath) return []
    const queue = pendingStarts.get(state.projectPath) ?? []
    pendingStarts.delete(state.projectPath)
    return queue
  })

  ipcMain.handle('session:kill', (event, id: string) => {
    getStateForEvent(event)?.ptyManager.kill(id)
  })

  ipcMain.handle('session:restart', (event, id: string) => {
    const state = getStateForEvent(event)
    if (!state) return null

    const win = BrowserWindow.fromWebContents(event.sender)!
    return state.ptyManager.restart(
      id,
      (sessionId, data) => {
        if (!win.isDestroyed()) {
          win.webContents.send('session:data', sessionId, data)
        }
      },
      (sessionId, exitCode) => {
        if (!win.isDestroyed()) {
          win.webContents.send('session:exit', sessionId, exitCode)
        }
      },
    )
  })

  ipcMain.on('session:write', (event, id: string, data: string) => {
    getStateForEvent(event)?.ptyManager.write(id, data)
  })

  ipcMain.on('session:resize', (event, id: string, cols: number, rows: number) => {
    getStateForEvent(event)?.ptyManager.resize(id, cols, rows)
  })

  ipcMain.handle('session:rename', (event, id: string, name: string) => {
    // User-initiated rename locks the name against later CLI/Claude renames.
    getStateForEvent(event)?.ptyManager.rename(id, name, true)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) schedulePersist(win.id)
  })

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.close()
  })

  ipcMain.handle('claude:get-launch', (event): import('../shared/types').ClaudeLaunch => {
    const state = getStateForEvent(event)
    return resolveClaudeLaunch(state?.projectPath)
  })

  ipcMain.handle('config:get', (event) => {
    const state = getStateForEvent(event)
    if (!state) return null
    return loadEffectiveConfig(state.projectPath)
  })

  ipcMain.handle('workspaces:for-project', (event) => {
    const state = getStateForEvent(event)
    const ws = state ? findWorkspaceForProject(state.projectPath) : null
    return ws ? { name: ws.name, projectCount: ws.projects.length } : null
  })

  ipcMain.handle('project:get-path', (event) => {
    const state = getStateForEvent(event)
    return state?.projectPath || null
  })

  ipcMain.handle('project:has-project', (event) => {
    const state = getStateForEvent(event)
    return !!(state?.projectPath)
  })

  ipcMain.handle('config:create-and-open', async (event) => {
    const state = getStateForEvent(event)
    if (!state) return
    const configPath = path.join(state.projectPath, '.forgeterm.json')
    if (!fs.existsSync(configPath)) {
      saveConfig(state.projectPath, DEFAULT_CONFIG)
    }
    await shell.openPath(configPath)
  })

  ipcMain.handle('config:save', (event, config: ForgeTermConfig) => {
    const state = getStateForEvent(event)
    if (!state) return
    saveConfig(state.projectPath, config)
    // The theme belongs to the workspace, so a theme edit made from one project
    // retargets the whole workspace and repaints every sibling.
    const ws = findWorkspaceForProject(state.projectPath)
    if (!ws?.theme) return
    const edited = extractTheme(config)
    if (edited && canonical(edited) !== canonical(ws.theme)) {
      setWorkspaceTheme(ws.name, edited)
    }
  })

  ipcMain.handle('dialog:open-folder', async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]

    // If the current window has no project (welcome state), reuse it
    const state = getStateForEvent(event)
    if (state && !state.projectPath) {
      const win = BrowserWindow.fromWebContents(event.sender)!
      autoAssignThemeIfNeeded(folderPath)
      saveRecentProject(folderPath)
      state.projectPath = folderPath
      state.configWatcher = watchConfig(win, folderPath)
      win.setTitle(path.basename(folderPath))
      win.webContents.send('config:changed')
      win.webContents.send('project:opened')
      return folderPath
    }

    focusOrCreateWindow(folderPath)
    return folderPath
  })

  ipcMain.handle('projects:get-recent', () => {
    const projects = loadRecentProjects()
    const openPaths = new Set(
      Array.from(windowStates.values()).map((s) => s.projectPath),
    )
    return projects
      .map((p) => {
        const config = loadConfig(p.path)
        return {
          ...p,
          accentColor: config?.window?.accentColor,
          emoji: config?.window?.emoji,
          isOpen: openPaths.has(p.path),
        }
      })
      .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))
  })

  ipcMain.handle('projects:open', (event, projectPath: string) => {
    const sourceWin = BrowserWindow.fromWebContents(event.sender)
    const targetWin = focusOrCreateWindow(projectPath)
    // Ensure new window gets focus after the source window's modal dismissal
    if (sourceWin && targetWin !== sourceWin) {
      setTimeout(() => targetWin.focus(), 100)
    }
  })

  // --- Control Panel actions -------------------------------------------------
  // The panel lives in its own window, so every one of these has to reach ACROSS
  // to a project window rather than acting on the caller's own state.

  ipcMain.handle('dashboard:open', () => {
    createDashboardWindow()
  })

  ipcMain.handle('ui-prefs:get', () => loadUiPrefs())

  ipcMain.handle('ui-prefs:set', (_event, patch: Partial<import('../shared/types').UiPrefs>) => {
    const next = { ...loadUiPrefs(), ...patch }
    saveUiPrefs(next)
    return next
  })

  // Raise a project window AND activate one specific session inside it. Both
  // halves already existed (focusOrCreateWindow + the notification click path);
  // this is what lets a panel row jump straight to the agent you clicked.
  ipcMain.handle('dashboard:focus-session', (_event, projectPath: string, sessionId: string) => {
    const win = focusOrCreateWindow(projectPath)
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.show()
    win.focus()
    // A window created just now is still loading; wait for its renderer before
    // asking it to switch sessions, otherwise the message lands nowhere.
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('notification:focus-session', sessionId)
      })
    } else {
      win.webContents.send('notification:focus-session', sessionId)
    }
    return true
  })

  ipcMain.handle('dashboard:session-action', (_event, projectPath: string, sessionId: string, action: 'stop' | 'restart') => {
    const win = findWindowForProject(projectPath)
    if (!win || win.isDestroyed()) return false
    const state = windowStates.get(win.id)
    if (!state) return false
    if (action === 'stop') {
      // onExit fires session:exit, which flips the session to stopped in the
      // project window's store - no extra channel needed.
      state.ptyManager.kill(sessionId)
    } else {
      state.ptyManager.restart(
        sessionId,
        (id, data) => { if (!win.isDestroyed()) win.webContents.send('session:data', id, data) },
        (id, exitCode) => { if (!win.isDestroyed()) win.webContents.send('session:exit', id, exitCode) },
      )
      win.webContents.send('session:restarted', sessionId)
    }
    schedulePersist(win.id)
    pushDashboardState()
    return true
  })

  // Start a Claude session in any project, reusing the `ft start` queue so it
  // works whether that project's window already exists or has to be created.
  ipcMain.handle('dashboard:new-session', (_event, projectPath: string) => {
    const launch = resolveClaudeLaunch(projectPath)
    const command = [launch.cliName, ...launch.resumeArgs].join(' ')
    const existed = !!findWindowForProject(projectPath)
    const queue = pendingStarts.get(projectPath) ?? []
    queue.push({ name: 'Claude', command, idle: false })
    pendingStarts.set(projectPath, queue)
    const win = focusOrCreateWindow(projectPath)
    if (existed && win && !win.isDestroyed()) {
      win.webContents.send('cli:flush-pending-starts')
    }
    if (process.platform === 'darwin') app.focus({ steal: true })
    return true
  })

  ipcMain.handle('dashboard:close-project', (_event, projectPath: string) => {
    const win = findWindowForProject(projectPath)
    if (!win || win.isDestroyed()) return false
    win.close()
    pushDashboardState()
    return true
  })

  ipcMain.handle('workspaces:get', () => {
    return loadWorkspaces()
  })

  ipcMain.handle('workspaces:set-project', (_event, projectPath: string, workspaceName: string) => {
    setProjectWorkspace(projectPath, workspaceName)
  })

  ipcMain.handle('workspaces:remove-project', (_event, projectPath: string) => {
    removeProjectFromWorkspace(projectPath)
  })

  ipcMain.handle('workspaces:open', (event, workspaceName: string, arrange: boolean) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === workspaceName)
    if (ws) {
      const sourceWin = BrowserWindow.fromWebContents(event.sender)
      const disabled = new Set(ws.disabledProjects || [])
      const enabledPaths = ws.projects.filter((p) => !disabled.has(p))
      const windows: BrowserWindow[] = []
      for (const projectPath of enabledPaths) {
        windows.push(focusOrCreateWindow(projectPath))
      }
      if (arrange) {
        // Look up screen preferences for current display count
        const displayCount = screen.getAllDisplays().length
        const key = String(displayCount)
        const indices = ws.screenPrefs?.[key]
        tileWindows(windows, indices)
      }
      // Ensure opened windows get focus instead of the source window
      const lastNew = windows[windows.length - 1]
      if (sourceWin && lastNew && lastNew !== sourceWin) {
        setTimeout(() => lastNew.focus(), 100)
      }
      // Send default command to each window's first session after a short delay
      if (ws.defaultCommand) {
        const cmd = ws.defaultCommand
        setTimeout(() => {
          for (const win of windows) {
            const state = windowStates.get(win.id)
            if (state) {
              const firstSession = state.ptyManager.getFirstSessionId()
              if (firstSession) {
                state.ptyManager.write(firstSession, cmd + '\n')
              }
            }
          }
        }, 1500)
      }
    }
  })

  ipcMain.handle('workspaces:set-arrange', (_event, workspaceName: string, arrange: boolean) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === workspaceName)
    if (ws) {
      ws.arrange = arrange
      saveWorkspaces(workspaces)
    }
  })

  ipcMain.handle('workspaces:set-screen-prefs', (_event, workspaceName: string, displayCount: number, indices: number[]) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === workspaceName)
    if (ws) {
      if (!ws.screenPrefs) ws.screenPrefs = {}
      ws.screenPrefs[String(displayCount)] = indices
      saveWorkspaces(workspaces)
    }
  })

  ipcMain.handle('displays:get', () => {
    const allDisplays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    return allDisplays.map((d, i) => ({
      id: d.id,
      index: i,
      bounds: d.bounds,
      workArea: d.workArea,
      isPrimary: d.id === primary.id,
    }))
  })

  // Track active highlight windows to clean up
  const highlightWindows = new Map<number, BrowserWindow>()

  ipcMain.handle('displays:highlight', (_event, displayIndex: number, color: string) => {
    const allDisplays = screen.getAllDisplays()
    if (displayIndex < 0 || displayIndex >= allDisplays.length) return

    // Clean up existing highlight for this display
    const existing = highlightWindows.get(displayIndex)
    if (existing && !existing.isDestroyed()) existing.close()

    const display = allDisplays[displayIndex]
    const { x, y, width, height } = display.bounds
    const borderWidth = 6
    const labelSize = 80

    const win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      type: 'panel',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    win.setIgnoreMouseEvents(true)
    highlightWindows.set(displayIndex, win)

    win.loadURL(`data:text/html,<!DOCTYPE html><html><head><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:transparent;overflow:hidden}
      .border{position:fixed;inset:0;border:${borderWidth}px solid ${color};border-radius:8px;pointer-events:none;animation:fadeIn 0.15s ease-out}
      .label{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:${labelSize}px;height:${labelSize}px;border-radius:50%;background:${color}33;border:3px solid ${color};display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;font-size:36px;font-weight:700;color:${color};animation:fadeIn 0.15s ease-out}
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    </style></head><body><div class="border"></div><div class="label">${displayIndex + 1}</div></body></html>`)

    setTimeout(() => {
      if (!win.isDestroyed()) win.close()
      highlightWindows.delete(displayIndex)
    }, 1200)
  })

  ipcMain.handle('displays:clear-highlight', (_event, displayIndex: number) => {
    const existing = highlightWindows.get(displayIndex)
    if (existing && !existing.isDestroyed()) existing.close()
    highlightWindows.delete(displayIndex)
  })

  ipcMain.handle('workspaces:reorder-projects', (_event, workspaceName: string, newOrder: string[]) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === workspaceName)
    if (ws) {
      ws.projects = newOrder
      saveWorkspaces(workspaces)
    }
  })

  ipcMain.handle('workspaces:toggle-project', (_event, workspaceName: string, projectPath: string) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === workspaceName)
    if (ws) {
      const disabled = new Set(ws.disabledProjects || [])
      if (disabled.has(projectPath)) {
        disabled.delete(projectPath)
      } else {
        disabled.add(projectPath)
      }
      ws.disabledProjects = disabled.size > 0 ? Array.from(disabled) : undefined
      saveWorkspaces(workspaces)
    }
  })

  ipcMain.handle('project:get-sidebar-mode', (event) => {
    const state = getStateForEvent(event)
    if (!state) return undefined
    const projects = loadRecentProjects()
    const project = projects.find((p) => p.path === state.projectPath)
    return project?.sidebarMode
  })

  ipcMain.handle('project:save-sidebar-mode', (event, mode: string) => {
    const state = getStateForEvent(event)
    if (!state) return
    const projects = loadRecentProjects()
    const project = projects.find((p) => p.path === state.projectPath)
    if (project) {
      project.sidebarMode = mode as 'full' | 'compact' | 'hidden'
      fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
    }
  })

  ipcMain.handle('project:get-sidebar-width', (event) => {
    const state = getStateForEvent(event)
    if (!state) return undefined
    const projects = loadRecentProjects()
    const project = projects.find((p) => p.path === state.projectPath)
    return project?.sidebarWidth
  })

  ipcMain.handle('project:save-sidebar-width', (event, width: number) => {
    const state = getStateForEvent(event)
    if (!state) return
    const projects = loadRecentProjects()
    const project = projects.find((p) => p.path === state.projectPath)
    if (project) {
      project.sidebarWidth = width
      fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
    }
  })

  ipcMain.handle('dashboard:get-state', () => {
    return getDashboardState()
  })

  ipcMain.handle('session-history:get', (_event, projectPath?: string) => {
    if (projectPath) return loadHistory(projectPath)
    // Load all history
    const dir = getHistoryDir()
    const all: HistoricalSession[] = []
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        const sessions: HistoricalSession[] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
        all.push(...sessions)
      }
    } catch { /* ignore */ }
    return all.sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
  })

  ipcMain.handle('session-history:search', (_event, filter: SessionHistoryFilter) => {
    return searchHistory(filter)
  })

  ipcMain.handle('session-history:delete-old', (_event, maxAgeDays: number) => {
    return cleanupOldHistory(maxAgeDays)
  })

  ipcMain.handle('transcript:search', (_event, targets: TranscriptSearchTarget[], query: string, perTargetLimit?: number) => {
    return searchTranscripts(targets ?? [], query ?? '', perTargetLimit)
  })

  ipcMain.handle('import:vscode-projects', async () => {
    const detected = detectProjectManagerFiles()
    let defaultPath: string | undefined
    if (detected.length > 0) {
      defaultPath = path.dirname(detected[0].path)
    }

    const dialogResult = await dialog.showOpenDialog({
      title: 'Select projects JSON file to import',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return null
    return importProjectsFromFile(dialogResult.filePaths[0])
  })

  ipcMain.handle('import:from-path', (_event, filePath: string) => {
    return importProjectsFromFile(filePath)
  })

  ipcMain.handle('import:detect-editors', () => {
    return detectProjectManagerFiles()
  })

  ipcMain.handle('import:should-show-suggestion', () => {
    if (isImportDismissed()) return false
    const detected = detectProjectManagerFiles()
    const recentProjects = loadRecentProjects()
    // Only show suggestion if we found editors AND user has few projects (first-time feel)
    return detected.length > 0 && recentProjects.length <= 1
  })

  ipcMain.handle('import:dismiss-suggestion', () => {
    fs.writeFileSync(getImportDismissedPath(), JSON.stringify({ dismissed: true }), 'utf-8')
  })

  ipcMain.handle('projects:remove-recent', (_event, projectPath: string) => {
    const projects = loadRecentProjects().filter((p) => p.path !== projectPath)
    fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
    // Also remove from any workspace
    removeProjectFromWorkspace(projectPath)
  })

  ipcMain.handle('workspaces:delete', (_event, workspaceName: string) => {
    const workspaces = loadWorkspaces().filter((ws) => ws.name !== workspaceName)
    saveWorkspaces(workspaces)
    // Clear workspace field from recent projects
    const projects = loadRecentProjects().map((p) =>
      p.workspace === workspaceName ? { ...p, workspace: undefined } : p,
    )
    fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
  })

  ipcMain.handle('file:read-content', async (_event, filePath: string) => {
    try {
      const stats = fs.statSync(filePath)
      if (stats.size > 1024 * 1024) {
        return { content: '', isBinary: true }
      }
      const buf = Buffer.alloc(Math.min(8192, stats.size))
      const fd = fs.openSync(filePath, 'r')
      fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      if (buf.includes(0)) {
        return { content: '', isBinary: true }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      return { content, isBinary: false }
    } catch {
      return { content: '', isBinary: true }
    }
  })

  ipcMain.handle('file:copy-to-project', (event, filePath: string) => {
    const state = getStateForEvent(event)
    if (!state) throw new Error('No project path')
    const fileName = path.basename(filePath)
    const newPath = path.join(state.projectPath, fileName)
    fs.copyFileSync(filePath, newPath)
    return { newPath, relativePath: fileName }
  })

  ipcMain.handle('workspaces:rename', (_event, oldName: string, newName: string) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === oldName)
    if (ws) {
      ws.name = newName
      saveWorkspaces(workspaces)
      const projects = loadRecentProjects().map((p) =>
        p.workspace === oldName ? { ...p, workspace: newName } : p,
      )
      fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
    }
  })

  ipcMain.handle('workspaces:update', (_event, name: string, updates: Partial<Workspace>) => {
    const workspaces = loadWorkspaces()
    const ws = workspaces.find((w) => w.name === name)
    if (ws) {
      if (updates.emoji !== undefined) ws.emoji = updates.emoji || undefined
      if (updates.description !== undefined) ws.description = updates.description || undefined
      if (updates.defaultCommand !== undefined) ws.defaultCommand = updates.defaultCommand || undefined
      if (updates.claudeCliName !== undefined) ws.claudeCliName = updates.claudeCliName || undefined
      if (updates.dangerouslySkipPermissions !== undefined) ws.dangerouslySkipPermissions = updates.dangerouslySkipPermissions
      // A full theme wins; a bare accent color regenerates the chrome from it.
      if (updates.theme !== undefined) {
        ws.theme = updates.theme || undefined
        ws.accentColor = ws.theme?.window.accentColor
      } else if (updates.accentColor !== undefined && updates.accentColor !== ws.accentColor) {
        ws.accentColor = updates.accentColor || undefined
        ws.theme = ws.accentColor ? accentToWorkspaceTheme(ws.accentColor) : undefined
      }
      saveWorkspaces(workspaces)
      if (ws.theme) propagateWorkspaceTheme(ws)
    }
  })

  ipcMain.handle('workspaces:add-project', (_event, workspaceName: string, projectPath: string) => {
    setProjectWorkspace(projectPath, workspaceName)
  })

  ipcMain.handle('config:open-data-file', async (_event, which: string) => {
    const filePath = which === 'workspaces' ? getWorkspacesPath() : getRecentProjectsPath()
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf-8')
    }
    await shell.openPath(filePath)
  })

  ipcMain.handle('project:reveal-in-finder', (event) => {
    const state = getStateForEvent(event)
    if (state) {
      shell.showItemInFolder(state.projectPath)
    }
  })

  ipcMain.handle('project:get-repo-url', (event) => {
    const state = getStateForEvent(event)
    if (!state) return null
    try {
      const raw = execSync('git remote get-url origin', {
        cwd: state.projectPath,
        encoding: 'utf-8',
        timeout: 3000,
      }).trim()
      // Convert SSH URL to HTTPS
      const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
      if (sshMatch) {
        return `https://${sshMatch[1]}/${sshMatch[2]}`
      }
      // Already HTTPS - strip .git suffix
      return raw.replace(/\.git$/, '')
    } catch {
      return null
    }
  })

  ipcMain.handle('shell:open-external', (_event, url: string) => {
    shell.openExternal(url)
  })

  // --- Favorite themes ---

  ipcMain.handle('themes:get-favorites', () => {
    try {
      const raw = fs.readFileSync(getFavoriteThemesPath(), 'utf-8')
      return JSON.parse(raw) as FavoriteTheme[]
    } catch {
      return []
    }
  })

  ipcMain.handle('themes:save-favorite', (_event, theme: FavoriteTheme) => {
    let favorites: FavoriteTheme[] = []
    try {
      favorites = JSON.parse(fs.readFileSync(getFavoriteThemesPath(), 'utf-8'))
    } catch { /* empty */ }
    // Replace if same name exists
    favorites = favorites.filter((f) => f.name !== theme.name)
    favorites.push(theme)
    fs.writeFileSync(getFavoriteThemesPath(), JSON.stringify(favorites, null, 2), 'utf-8')
  })

  ipcMain.handle('themes:delete-favorite', (_event, name: string) => {
    let favorites: FavoriteTheme[] = []
    try {
      favorites = JSON.parse(fs.readFileSync(getFavoriteThemesPath(), 'utf-8'))
    } catch { /* empty */ }
    favorites = favorites.filter((f) => f.name !== name)
    fs.writeFileSync(getFavoriteThemesPath(), JSON.stringify(favorites, null, 2), 'utf-8')
  })

  // --- Session templates from all projects ---

  ipcMain.handle('sessions:get-all-templates', (): SessionTemplate[] => {
    const projects = loadRecentProjects()
    const templates: SessionTemplate[] = []
    for (const project of projects) {
      const config = loadConfig(project.path)
      if (config?.sessions?.length) {
        const projectName = config.projectName || path.basename(project.path)
        for (const s of config.sessions) {
          templates.push({
            name: s.name,
            command: s.command,
            projectName,
            projectPath: project.path,
          })
        }
      }
    }
    return templates
  })

  // --- CLI install ---

  function getCliDismissedPath(): string {
    return path.join(app.getPath('userData'), 'cli-prompt-dismissed.json')
  }

  function getCliSourcePath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'bin', 'forgeterm-cli.sh')
    }
    return path.join(__dirname, '..', 'bin', 'forgeterm-cli.sh')
  }

  function isCliInstalled(): boolean {
    return CLI_INSTALL_PATHS.some((p) => fs.existsSync(p))
  }

  ipcMain.handle('cli:is-installed', () => {
    return isCliInstalled()
  })

  ipcMain.handle('cli:get-status', (): string => {
    if (!isCliInstalled()) return 'not-setup'
    if (notificationServer.isListening()) return 'connected'
    return 'error'
  })

  ipcMain.handle('cli:restart-server', async (): Promise<boolean> => {
    try {
      notificationServer.stop()
      await notificationServer.start()
      return notificationServer.isListening()
    } catch {
      return false
    }
  })

  ipcMain.handle('finder:is-installed', () => {
    if (process.platform !== 'darwin') return false
    return isFinderIntegrationInstalled()
  })

  ipcMain.handle('finder:install', () => {
    if (process.platform !== 'darwin') return { success: false, error: 'Only available on macOS' }
    return installFinderIntegration()
  })

  ipcMain.handle('finder:uninstall', () => {
    if (process.platform !== 'darwin') return { success: false, error: 'Only available on macOS' }
    return uninstallFinderIntegration()
  })

  ipcMain.handle('cli:should-show-prompt', () => {
    if (isCliInstalled()) return false
    try {
      const data = JSON.parse(fs.readFileSync(getCliDismissedPath(), 'utf-8'))
      return !data.dismissed
    } catch {
      return true
    }
  })

  ipcMain.handle('cli:dismiss-prompt', () => {
    fs.writeFileSync(getCliDismissedPath(), JSON.stringify({ dismissed: true }), 'utf-8')
  })

  ipcMain.handle('cli:install', (): { success: boolean; error?: string } => {
    const targetPath = '/usr/local/bin/forgeterm'
    const sourcePath = getCliSourcePath()

    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: `CLI script not found at ${sourcePath}` }
    }

    try {
      // Try direct copy first
      try {
        fs.copyFileSync(sourcePath, targetPath)
        fs.chmodSync(targetPath, 0o755)
      } catch {
        // Need elevated permissions
        const script = `do shell script "cp '${sourcePath}' '${targetPath}' && chmod 755 '${targetPath}'" with administrator privileges`
        execSync(`osascript -e '${script}'`)
      }
      // Create ft alias symlink
      const ftPath = '/usr/local/bin/ft'
      try {
        try {
          const existing = fs.readlinkSync(ftPath)
          if (existing !== targetPath) {
            fs.unlinkSync(ftPath)
            fs.symlinkSync(targetPath, ftPath)
          }
        } catch {
          // Not a symlink or doesn't exist - create it
          try { fs.unlinkSync(ftPath) } catch { /* ignore */ }
          fs.symlinkSync(targetPath, ftPath)
        }
      } catch {
        // If direct symlink fails, use elevated permissions
        try {
          const script = `do shell script "ln -sf '${targetPath}' '${ftPath}'" with administrator privileges`
          execSync(`osascript -e '${script}'`)
        } catch { /* non-critical, forgeterm still works */ }
      }
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('User canceled')) {
        return { success: false, error: 'cancelled' }
      }
      return { success: false, error: msg }
    }
  })

  // --- Claude activity hooks ---
  ipcMain.handle('claude-hooks:installed', (): boolean => areClaudeActivityHooksInstalled())
  ipcMain.handle('claude-hooks:install', (): { success: boolean; error?: string } => installClaudeActivityHooks())

  // --- Update checks ---

  ipcMain.handle('update:check', async (): Promise<UpdateInfo> => {
    const info = await updateManager.checkNow()
    return { ...info, supportsAutoInstall: updateManager.supportsAutoInstall }
  })

  ipcMain.handle('update:get-last-check', (): UpdateInfo | null => {
    const info = updateManager.getLastCheck()
    if (!info) return null
    return { ...info, supportsAutoInstall: updateManager.supportsAutoInstall }
  })

  ipcMain.handle('update:apply', async () => {
    await updateManager.applyUpdate()
  })

  ipcMain.handle('update:download', async () => {
    const info = updateManager.getLastCheck()
    if (!info?.dmgUrl) throw new Error('No DMG URL available')
    await updateManager.downloadDmg(info.dmgUrl)
  })

  ipcMain.handle('update:install', () => {
    const info = updateManager.getLastCheck()
    if (!info?.dmgUrl) throw new Error('No DMG URL available')
    updateManager.installViaScript(info.dmgUrl)
  })

  ipcMain.handle('update:get-command', (): string | null => {
    const info = updateManager.getLastCheck()
    if (!info?.dmgUrl) return null
    return updateManager.buildUpdateCommand(info.dmgUrl)
  })

  // --- Remote access ---

  ipcMain.handle('remote:start', async (): Promise<RemoteStatus> => {
    await remoteServer.start()
    const tunnelUrl = await remoteServer.startTunnel()
    const status = remoteServer.getStatus()
    // Broadcast to all windows
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('remote:status-changed', status)
      }
    }
    return status
  })

  ipcMain.handle('remote:stop', (): RemoteStatus => {
    remoteServer.stop()
    const status = remoteServer.getStatus()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('remote:status-changed', status)
      }
    }
    return status
  })

  ipcMain.handle('remote:status', (): RemoteStatus => {
    return remoteServer.getStatus()
  })

  // --- Claude Code connection ---

  ipcMain.handle('claude:check-connection', (): ClaudeConnectionStatus => {
    return checkClaudeConnection()
  })

  ipcMain.handle('claude:get-setup-prompt', (): string => {
    return getClaudeSetupPrompt()
  })

  // Session activity tracking for tray menu and dock badge
  ipcMain.on('activity:report', (event, statuses: SessionStatusReport[], activeSessionId: string | null) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const state = windowStates.get(win.id)
    if (!state?.projectPath) return

    if (activeSessionId) state.activeSessionId = activeSessionId

    const config = loadConfig(state.projectPath)
    const projectName = config?.projectName || path.basename(state.projectPath)

    for (const s of statuses) trackSessionStatus(s.sessionId, s.status)
    windowActivities.set(win.id, { projectName, sessions: statuses })
    updateTrayMenu()
    updateDockBadge()
    pushDashboardState()
  })

  ipcMain.handle('sessions:get-saved', (event) => {
    const state = getStateForEvent(event)
    if (!state?.projectPath) return null
    const allSaved = loadSavedSessions()
    return allSaved.find(s => s.projectPath === state.projectPath) ?? null
  })

  ipcMain.handle('sessions:clear-saved', (event) => {
    const state = getStateForEvent(event)
    if (!state?.projectPath) return
    const allSaved = loadSavedSessions()
    const filtered = allSaved.filter(s => s.projectPath !== state.projectPath)
    saveSavedSessions(filtered)
  })

  ipcMain.handle('session:delete', (event, id: string) => {
    const state = getStateForEvent(event)
    // Save to history before killing, so a closed session can be reopened/resumed.
    if (state?.projectPath) {
      const session = state.ptyManager.getSession(id)
      if (session) {
        appendToHistory(state.projectPath, {
          id: session.id,
          name: session.name,
          command: session.command,
          projectPath: state.projectPath,
          workspace: getWorkspaceForProject(state.projectPath),
          createdAt: session.createdAt,
          endedAt: Date.now(),
          info: session.info,
          conversationId: session.conversationId,
        })
      }
    }
    state?.ptyManager.removeSession(id)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) schedulePersist(win.id)
  })
}

async function installCli() {
  const targetPath = '/usr/local/bin/forgeterm'
  let sourcePath: string

  if (app.isPackaged) {
    // In packaged app, the CLI is in the Resources directory
    sourcePath = path.join(process.resourcesPath, 'bin', 'forgeterm-cli.sh')
  } else {
    // In dev, it's in the project bin directory
    sourcePath = path.join(__dirname, '..', 'bin', 'forgeterm-cli.sh')
  }

  if (!fs.existsSync(sourcePath)) {
    dialog.showErrorBox('Install Failed', `CLI script not found at ${sourcePath}`)
    return
  }

  try {
    // Check if already installed and up to date
    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf-8')
      const source = fs.readFileSync(sourcePath, 'utf-8')
      if (existing === source) {
        dialog.showMessageBox({
          type: 'info',
          message: 'Command line tool already installed',
          detail: `The 'forgeterm' command is available at ${targetPath}`,
        })
        return
      }
    }

    // Try direct copy first (works if /usr/local/bin is writable)
    try {
      fs.copyFileSync(sourcePath, targetPath)
      fs.chmodSync(targetPath, 0o755)
    } catch {
      // Need elevated permissions - use osascript to prompt for admin
      const script = `do shell script "cp '${sourcePath}' '${targetPath}' && chmod 755 '${targetPath}'" with administrator privileges`
      execSync(`osascript -e '${script}'`)
    }

    dialog.showMessageBox({
      type: 'info',
      message: 'Command line tool installed',
      detail: `You can now use 'forgeterm' from any terminal.\n\nTry: forgeterm notify "Hello!"`,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('User canceled')) {
      dialog.showErrorBox('Install Failed', msg)
    }
  }
}

// --- Claude activity hooks ---
// Install Claude Code hooks that report each session's working state via
// `forgeterm activity`, so ForgeTerm can show precise loading / needs-attention
// indicators. Mirrors the existing conversation-id SessionStart hook.

const CLAUDE_ACTIVITY_HOOKS = [
  { event: 'UserPromptSubmit', status: 'working' },
  { event: 'Stop', status: 'done' },
  { event: 'Notification', status: 'attention' },
]

function getActivityHookSourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'hooks', 'report-activity.cjs')
  }
  return path.join(__dirname, '..', 'bin', 'hooks', 'report-activity.cjs')
}
function activityHookScriptDest(): string {
  return path.join(app.getPath('home'), '.claude', 'hooks', 'forgeterm', 'report-activity.cjs')
}
function claudeSettingsPath(): string {
  return path.join(app.getPath('home'), '.claude', 'settings.json')
}
// True if any entry in this event's hook array references the activity script.
function hasActivityHook(arr: unknown): boolean {
  if (!Array.isArray(arr)) return false
  return arr.some((entry) =>
    Array.isArray((entry as { hooks?: unknown }).hooks) &&
    (entry as { hooks: Array<{ command?: unknown }> }).hooks.some(
      (h) => typeof h.command === 'string' && h.command.includes('report-activity.cjs'),
    ),
  )
}

function areClaudeActivityHooksInstalled(): boolean {
  try {
    if (!fs.existsSync(activityHookScriptDest())) return false
    const settingsPath = claudeSettingsPath()
    if (!fs.existsSync(settingsPath)) return false
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const hooks = (settings?.hooks ?? {}) as Record<string, unknown>
    return CLAUDE_ACTIVITY_HOOKS.every(({ event }) => hasActivityHook(hooks[event]))
  } catch {
    return false
  }
}

/**
 * Keep an already-installed hook script in step with the app. The installer only
 * ever runs once, so without this an upgrade would leave the old script in
 * ~/.claude/hooks/forgeterm/ and newer features (like the attention message the
 * Control Panel shows) would never arrive.
 */
function refreshClaudeActivityHookScript(): void {
  try {
    const dest = activityHookScriptDest()
    if (!fs.existsSync(dest)) return
    const source = getActivityHookSourcePath()
    if (!fs.existsSync(source)) return
    if (fs.readFileSync(source, 'utf-8') === fs.readFileSync(dest, 'utf-8')) return
    fs.copyFileSync(source, dest)
    fs.chmodSync(dest, 0o755)
  } catch {
    // A stale hook is harmless; never block startup over it.
  }
}

function installClaudeActivityHooks(): { success: boolean; error?: string } {
  try {
    const source = getActivityHookSourcePath()
    if (!fs.existsSync(source)) {
      return { success: false, error: `Hook script not found at ${source}` }
    }
    // 1. Copy the hook script into ~/.claude/hooks/forgeterm/
    const scriptDest = activityHookScriptDest()
    fs.mkdirSync(path.dirname(scriptDest), { recursive: true })
    fs.copyFileSync(source, scriptDest)
    fs.chmodSync(scriptDest, 0o755)

    // 2. Register the three hooks in ~/.claude/settings.json (idempotent)
    const settingsPath = claudeSettingsPath()
    let settings: { hooks?: Record<string, Array<unknown>> } = {}
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      try {
        settings = JSON.parse(raw)
      } catch {
        return { success: false, error: 'Could not parse ~/.claude/settings.json' }
      }
      // Back up before modifying
      fs.writeFileSync(settingsPath + '.bak-forgeterm-activity', raw, 'utf-8')
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    }
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

    let changed = false
    for (const { event, status } of CLAUDE_ACTIVITY_HOOKS) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
      if (hasActivityHook(settings.hooks[event])) continue
      settings.hooks[event].push({
        matcher: '',
        hooks: [{ type: 'command', command: `node "${scriptDest}" ${status}`, timeout: 3000 }],
      })
      changed = true
    }
    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    }
    return { success: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: async () => {
            const info = await updateManager.checkNow()
            const win = BrowserWindow.getFocusedWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send('update:check-result', {
                ...info,
                supportsAutoInstall: updateManager.supportsAutoInstall,
              })
            }
          },
        },
        {
          label: 'Install Command Line Tool...',
          click: async () => {
            await installCli()
          },
        },
        {
          label: 'Install Claude Activity Hooks...',
          click: () => {
            const result = installClaudeActivityHooks()
            if (result.success) {
              dialog.showMessageBox({
                type: 'info',
                message: 'Claude activity hooks installed',
                detail: 'ForgeTerm sessions will now show a loading indicator while Claude works and a glowing dot when it finishes.\n\nApplies to Claude sessions started from now on.',
              })
            } else {
              dialog.showErrorBox('Install Failed', result.error || 'Unknown error')
            }
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Control Panel',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => createDashboardWindow(),
        },
        { type: 'separator' },
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) win.webContents.send('menu:new-session')
          },
        },
        {
          label: 'Reopen Closed Session',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) win.webContents.send('menu:reopen-last-closed')
          },
        },
        { type: 'separator' },
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog({
              properties: ['openDirectory'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
              focusOrCreateWindow(result.filePaths[0])
            }
          },
        },
        {
          label: 'Switch Project...',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) win.webContents.send('menu:open-project-switcher')
          },
        },
        { type: 'separator' },
        {
          label: 'Project Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) win.webContents.send('menu:open-project-settings')
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme Editor...',
          accelerator: 'CmdOrCtrl+Shift+Y',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) win.webContents.send('menu:open-theme-editor')
          },
        },
        { type: 'separator' },
        {
          label: 'Edit Config JSON...',
          click: async () => {
            const win = BrowserWindow.getFocusedWindow()
            if (!win) return
            const state = windowStates.get(win.id)
            if (!state) return
            const configPath = path.join(state.projectPath, '.forgeterm.json')
            if (!fs.existsSync(configPath)) {
              saveConfig(state.projectPath, DEFAULT_CONFIG)
            }
            await shell.openPath(configPath)
          },
        },
        { type: 'separator' },
        // Plain Reload (Cmd+R) is intentionally omitted so Cmd+R is free for
        // "rename active session" in the renderer. Force Reload (Cmd+Shift+R) remains.
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function isWritableDirectory(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK)
    return dirPath !== '/'
  } catch {
    return false
  }
}

function getInitialProjectPath(): string | null {
  // Check CLI args (skip electron binary and script path)
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (!arg.startsWith('-') && !arg.startsWith('.')) {
      try {
        const resolved = path.resolve(arg)
        if (fs.statSync(resolved).isDirectory() && isWritableDirectory(resolved)) return resolved
      } catch { /* ignore */ }
    }
    if (arg === '.') {
      const cwd = process.cwd()
      if (isWritableDirectory(cwd)) return cwd
    }
    if (arg.startsWith('./') || arg.startsWith('/')) {
      try {
        const resolved = path.resolve(arg)
        if (fs.statSync(resolved).isDirectory() && isWritableDirectory(resolved)) return resolved
      } catch { /* ignore */ }
    }
  }
  const cwd = process.cwd()
  return isWritableDirectory(cwd) ? cwd : null
}

// Handle macOS "Open with" / drag folder onto dock icon
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  try {
    if (!fs.statSync(filePath).isDirectory()) return
  } catch { return }

  if (app.isReady()) {
    focusOrCreateWindow(filePath)
  } else {
    // App not ready yet - store for launch
    process.argv.push(filePath)
  }
})

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'ForgeTerm',
    copyright: 'Copyright © 2026 ForgeTerm',
    credits: 'Created by Nadav Cohen\nSponsored by Codama (codama.dev)',
    website: 'https://github.com/ncamaa/forgeterm',
  })
  buildMenu()
  setupIpcHandlers()
  createTray()
  refreshClaudeActivityHookScript()
  void notificationServer.start()

  // Cleanup session history older than 60 days
  cleanupOldHistory(60)

  // Broadcast update availability to all renderer windows
  updateManager.onUpdateAvailable((info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('update:available', { ...info, supportsAutoInstall: updateManager.supportsAutoInstall })
      }
    }
  })
  updateManager.startPeriodicChecks()

  // Clean up stale saved sessions (>7 days)
  const staleThreshold = 7 * 24 * 60 * 60 * 1000
  const allSaved = loadSavedSessions()
  const fresh = allSaved.filter(s => Date.now() - s.savedAt < staleThreshold)
  if (fresh.length !== allSaved.length) saveSavedSessions(fresh)

  const projectPath = getInitialProjectPath()
  createProjectWindow(projectPath)
})

app.on('will-quit', () => {
  remoteServer.stop()
  notificationServer.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createDashboardWindow()
  }
})
