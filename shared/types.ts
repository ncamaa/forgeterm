export interface ForgeTermConfig {
  theme?: {
    background?: string
    foreground?: string
    cursor?: string
    selection?: string
    black?: string
    red?: string
    green?: string
    yellow?: string
    blue?: string
    magenta?: string
    cyan?: string
    white?: string
  }
  terminalTheme?: string
  font?: {
    family?: string
    size?: number
  }
  window?: {
    accentColor?: string
    titlebarBackground?: string
    titlebarBackgroundEnd?: string
    titlebarForeground?: string
    sidebarBackground?: string
    sidebarForeground?: string
    buttonBackground?: string
    gradientAngle?: number
    emoji?: string
    themeName?: string
  }
  projectName?: string
  sessions?: Array<{
    name: string
    command?: string
    autoStart?: boolean
  }>
  dragDropBehavior?: 'ask' | 'path' | 'content' | 'copy'
  claudeResumeArgs?: string[]
  // Custom Claude CLI command name (default "claude"), e.g. "claude-hsp".
  claudeCliName?: string
  // Whether ForgeTerm-built Claude resume/restore commands include
  // --dangerously-skip-permissions (default true).
  dangerouslySkipPermissions?: boolean
}

export interface SessionInfo {
  id: string
  name: string
  command?: string
  running: boolean
}

export interface RecentProject {
  path: string
  name: string
  lastOpened: number
  workspace?: string
  sidebarMode?: 'full' | 'compact' | 'hidden'
  sidebarWidth?: number
  accentColor?: string
  emoji?: string
  isOpen?: boolean
}

/**
 * A theme owned by a workspace. Overlaid onto every member project's config so
 * all projects in a workspace share one identity - `window.emoji` stays
 * per-project so siblings remain individually recognizable.
 */
export interface WorkspaceTheme {
  window: NonNullable<ForgeTermConfig['window']>
  theme: NonNullable<ForgeTermConfig['theme']>
  terminalTheme: string
}

export interface Workspace {
  name: string
  projects: string[] // project paths
  arrange?: boolean // tile windows on open (default true)
  disabledProjects?: string[] // paths to skip when opening
  screenPrefs?: Record<string, number[]> // key = display count, value = display indices to use
  emoji?: string
  description?: string
  // Shared theme for every project in this workspace. Overrides per-project
  // `.forgeterm.json` window/terminal colors.
  theme?: WorkspaceTheme
  accentColor?: string
  defaultCommand?: string
  // Custom Claude CLI command name for projects in this workspace (e.g. "claude-hsp").
  claudeCliName?: string
  // Whether automatic Claude resumes include --dangerously-skip-permissions.
  dangerouslySkipPermissions?: boolean
}

export interface DisplayInfo {
  id: number
  index: number
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  isPrimary: boolean
}

export interface ImportResult {
  projectsAdded: number
  workspacesCreated: string[]
  workspacesUpdated: string[]
}

export interface DetectedEditor {
  name: string
  path: string
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion?: string
  releaseUrl?: string
  releaseNotes?: string
  dmgUrl?: string
  supportsAutoInstall?: boolean
}

export interface FavoriteTheme {
  name: string
  window: {
    accentColor: string
    titlebarBackground: string
    titlebarBackgroundEnd: string
    titlebarForeground: string
    sidebarBackground: string
    sidebarForeground: string
    buttonBackground: string
    gradientAngle?: number
  }
  terminalMode: string
}

export interface SessionTemplate {
  name: string
  command?: string
  projectName: string
  projectPath: string
}

export interface SessionTimelineEntry {
  title: string
  summary: string
  lastAction: string
  actionItem?: string
  timestamp: number
  contextPercent?: number
}

export interface SessionContext {
  title: string
  summary: string
  lastAction: string
  actionItem?: string
  updatedAt: number
  contextPercent?: number
  timeline?: SessionTimelineEntry[]
}

export interface SavedSession {
  name: string
  command?: string
  wasRunning: boolean
  claudeSessionId?: string
  info?: SessionContext
  order: number
  // True if the user renamed this session manually; persists the rename lock
  // so a CLI/Claude `ft rename` won't override it after restore.
  nameLocked?: boolean
}

// Resolved Claude launch settings for a project (precedence: project -> workspace -> default).
export interface ClaudeLaunch {
  cliName: string
  resumeArgs: string[]
}

export interface SavedWindowState {
  projectPath: string
  sessions: SavedSession[]
  activeSessionName?: string
  savedAt: number
}

export interface HistoricalSession {
  id: string
  name: string
  command?: string
  projectPath: string
  workspace?: string
  createdAt: number
  endedAt?: number
  info?: SessionContext
  /** Claude conversation id, when the session ran Claude - enables resume on reopen. */
  conversationId?: string
}

export interface SessionHistoryFilter {
  workspace?: string
  projectPath?: string
  query?: string
  maxAgeDays?: number
}

// --- Claude transcript search ---------------------------------------------

/** One conversation to search on disk (open session or a closed/historical one). */
export interface TranscriptSearchTarget {
  /** Session id (open) or historical-session id - echoed back to group results. */
  id: string
  conversationId: string
  projectPath: string
}

/** A single match within a Claude transcript (a message/tool segment). */
export interface TranscriptMatch {
  role: 'user' | 'assistant'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  /** Single-line preview windowed around the match. */
  preview: string
  /** Match offset within `preview`. */
  col: number
  /**
   * Length of the matched text at `col`. Equals the query length for a phrase
   * match; for a multi-term query it is the length of the term that matched.
   */
  matchLength: number
  /** Line index in the JSONL transcript (ordering / identity). */
  msgIndex: number
  timestamp?: number
}

export interface TranscriptSearchResult {
  id: string
  matches: TranscriptMatch[]
}

export interface DashboardSession {
  id: string
  name: string
  running: boolean
  activityStatus: SessionActivityStatus
  contextPercent?: number
  info?: SessionContext
}

export interface DashboardProject {
  path: string
  name: string
  isOpen: boolean
  emoji?: string
  accentColor?: string
  sessions: DashboardSession[]
}

export interface DashboardWorkspace {
  name: string
  emoji?: string
  accentColor?: string
  description?: string
  projects: DashboardProject[]
}

export interface DashboardState {
  workspaces: DashboardWorkspace[]
  standaloneProjects: DashboardProject[]
}

export interface ForgeTermNotification {
  message: string
  title?: string
  sound?: boolean
  projectPath?: string
  sessionId?: string
  sessionName?: string
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  tunnelUrl: string | null
  pin: string | null
  sessionPath: string | null
  tunnelError: string | null
  tunnelLogs: string[]
}

export type CliStatus = 'not-setup' | 'connected' | 'error'

export interface ClaudeConnectionStatus {
  connected: boolean
  currentVersion: string
  promptedVersion: string | null
  needsUpdate: boolean
}

export type SessionActivityStatus = 'idle' | 'working' | 'unread'

// Signals reported by the CLI / Claude hooks. Mapped to SessionActivityStatus
// in the renderer: 'done' clears to idle if the session is being viewed,
// otherwise becomes 'unread'; 'attention' always becomes 'unread'.
export type SessionActivitySignal = 'working' | 'done' | 'attention' | 'idle'

export interface SessionStatusReport {
  sessionId: string
  sessionName: string
  status: SessionActivityStatus
}

// A live session requested via the `ft start` CLI command, queued by the main
// process until the target window's renderer picks it up.
export interface PendingSessionStart {
  name: string
  command?: string
  idle?: boolean
}

export interface ForgeTermAPI {
  createSession: (name: string, command?: string, idle?: boolean, nameLocked?: boolean) => Promise<string>
  killSession: (id: string) => Promise<void>
  restartSession: (id: string) => Promise<string>
  writeToSession: (id: string, data: string) => void
  resizeSession: (id: string, cols: number, rows: number) => void
  onSessionData: (callback: (id: string, data: string) => void) => () => void
  onSessionExit: (callback: (id: string, exitCode: number) => void) => () => void
  getProjectConfig: () => Promise<ForgeTermConfig | null>
  getProjectPath: () => Promise<string | null>
  hasProject: () => Promise<boolean>
  onProjectOpened: (callback: () => void) => () => void
  onConfigChanged: (callback: () => void) => () => void
  openFolder: () => Promise<string | null>
  renameSession: (id: string, name: string) => Promise<void>
  onMenuNewSession: (callback: () => void) => () => void
  createAndOpenConfig: () => Promise<void>
  saveConfig: (config: ForgeTermConfig) => Promise<void>
  onOpenThemeEditor: (callback: () => void) => () => void
  onOpenProjectSettings: (callback: () => void) => () => void
  onOpenProjectSwitcher: (callback: () => void) => () => void
  onReopenLastClosed: (callback: () => void) => () => void
  getRecentProjects: () => Promise<RecentProject[]>
  openProject: (projectPath: string) => Promise<void>
  getWorkspaces: () => Promise<Workspace[]>
  /** The workspace owning this window's project theme, if any. */
  getProjectWorkspace: () => Promise<{ name: string; projectCount: number } | null>
  setProjectWorkspace: (projectPath: string, workspaceName: string) => Promise<void>
  removeProjectFromWorkspace: (projectPath: string) => Promise<void>
  openWorkspace: (workspaceName: string, arrange: boolean) => Promise<void>
  setWorkspaceArrange: (workspaceName: string, arrange: boolean) => Promise<void>
  setWorkspaceScreenPrefs: (workspaceName: string, displayCount: number, indices: number[]) => Promise<void>
  getDisplays: () => Promise<DisplayInfo[]>
  highlightDisplay: (displayIndex: number, color: string) => Promise<void>
  clearHighlightDisplay: (displayIndex: number) => Promise<void>
  toggleWorkspaceProject: (workspaceName: string, projectPath: string) => Promise<void>
  reorderWorkspaceProjects: (workspaceName: string, newOrder: string[]) => Promise<void>
  getSidebarMode: () => Promise<'full' | 'compact' | 'hidden' | undefined>
  saveSidebarMode: (mode: 'full' | 'compact' | 'hidden') => Promise<void>
  getSidebarWidth: () => Promise<number | undefined>
  saveSidebarWidth: (width: number) => Promise<void>
  importVSCodeProjects: () => Promise<ImportResult | null>
  removeRecentProject: (projectPath: string) => Promise<void>
  getSessionHistory: (projectPath?: string) => Promise<HistoricalSession[]>
  searchSessionHistory: (filter: SessionHistoryFilter) => Promise<HistoricalSession[]>
  deleteOldSessions: (maxAgeDays: number) => Promise<number>
  searchTranscripts: (targets: TranscriptSearchTarget[], query: string, perTargetLimit?: number) => Promise<TranscriptSearchResult[]>
  getDashboardState: () => Promise<DashboardState>
  onDashboardStateChanged: (callback: (state: DashboardState) => void) => () => void
  deleteWorkspace: (workspaceName: string) => Promise<void>
  openDataFile: (which: 'workspaces' | 'recent-projects') => Promise<void>
  revealInFinder: () => Promise<void>
  getRepoUrl: () => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  detectProjectManagerFiles: () => Promise<DetectedEditor[]>
  importFromPath: (filePath: string) => Promise<ImportResult | null>
  dismissImportSuggestion: () => Promise<void>
  shouldShowImportSuggestion: () => Promise<boolean>
  isCliInstalled: () => Promise<boolean>
  installCli: () => Promise<{ success: boolean; error?: string }>
  dismissCliPrompt: () => Promise<void>
  shouldShowCliPrompt: () => Promise<boolean>
  getCliStatus: () => Promise<CliStatus>
  restartCliServer: () => Promise<boolean>
  isFinderIntegrationInstalled: () => Promise<boolean>
  installFinderIntegration: () => Promise<{ success: boolean; error?: string }>
  uninstallFinderIntegration: () => Promise<{ success: boolean; error?: string }>
  checkForUpdate: () => Promise<UpdateInfo>
  getLastUpdateCheck: () => Promise<UpdateInfo | null>
  applyUpdate: () => Promise<void>
  downloadUpdate: () => Promise<void>
  onDownloadProgress: (callback: (progress: { progress: number; receivedBytes: number; totalBytes: number }) => void) => () => void
  installUpdate: () => Promise<void>
  getUpdateCommand: () => Promise<string | null>
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void
  onUpdateCheckResult: (callback: (info: UpdateInfo) => void) => () => void
  getFavoriteThemes: () => Promise<FavoriteTheme[]>
  saveFavoriteTheme: (theme: FavoriteTheme) => Promise<void>
  deleteFavoriteTheme: (name: string) => Promise<void>
  getAllSessionTemplates: () => Promise<SessionTemplate[]>
  onFocusSession: (callback: (sessionId: string) => void) => () => void
  readFileContent: (filePath: string) => Promise<{ content: string; isBinary: boolean }>
  copyFileToProject: (filePath: string) => Promise<{ newPath: string; relativePath: string }>
  renameWorkspace: (oldName: string, newName: string) => Promise<void>
  updateWorkspace: (name: string, updates: Partial<Workspace>) => Promise<void>
  addProjectToWorkspace: (workspaceName: string, projectPath: string) => Promise<void>
  startRemoteAccess: () => Promise<RemoteStatus>
  stopRemoteAccess: () => Promise<RemoteStatus>
  getRemoteStatus: () => Promise<RemoteStatus>
  onRemoteStatusChanged: (callback: (status: RemoteStatus) => void) => () => void
  reportSessionStatuses: (statuses: SessionStatusReport[], activeSessionId: string | null) => void
  onSessionRenamed: (callback: (sessionId: string, name: string) => void) => () => void
  onSessionClosed: (callback: (sessionId: string) => void) => () => void
  onSessionInfoUpdated: (callback: (sessionId: string, info: SessionContext) => void) => () => void
  onContextUpdated: (callback: (sessionId: string, percent: number) => void) => () => void
  onConversationUpdated: (callback: (sessionId: string, conversationId: string) => void) => () => void
  onSessionActivityUpdated: (callback: (sessionId: string, signal: SessionActivitySignal) => void) => () => void
  installClaudeHooks: () => Promise<{ success: boolean; error?: string }>
  areClaudeHooksInstalled: () => Promise<boolean>
  getSavedSessions: () => Promise<SavedWindowState | null>
  clearSavedSessions: () => Promise<void>
  deleteSession: (id: string) => Promise<void>
  checkClaudeConnection: () => Promise<ClaudeConnectionStatus>
  getClaudeSetupPrompt: () => Promise<string>
  getClaudeLaunch: () => Promise<ClaudeLaunch>
  closeWindow: () => void
  takePendingStarts: () => Promise<PendingSessionStart[]>
  onFlushPendingStarts: (callback: () => void) => () => void
}
