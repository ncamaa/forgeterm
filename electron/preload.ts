import { ipcRenderer, contextBridge } from 'electron'
import type { ForgeTermAPI, CliStatus, UpdateInfo, RemoteStatus, SessionContext, DashboardState } from '../shared/types'

const api: ForgeTermAPI = {
  createSession: (name: string, command?: string, idle?: boolean, nameLocked?: boolean) =>
    ipcRenderer.invoke('session:create', name, command, idle, nameLocked),

  killSession: (id: string) =>
    ipcRenderer.invoke('session:kill', id),

  restartSession: (id: string) =>
    ipcRenderer.invoke('session:restart', id),

  writeToSession: (id: string, data: string) =>
    ipcRenderer.send('session:write', id, data),

  resizeSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('session:resize', id, cols, rows),

  onSessionData: (callback: (id: string, data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, data: string) =>
      callback(id, data)
    ipcRenderer.on('session:data', handler)
    return () => { ipcRenderer.removeListener('session:data', handler) }
  },

  onSessionExit: (callback: (id: string, exitCode: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) =>
      callback(id, exitCode)
    ipcRenderer.on('session:exit', handler)
    return () => { ipcRenderer.removeListener('session:exit', handler) }
  },

  getProjectConfig: () =>
    ipcRenderer.invoke('config:get'),

  getProjectPath: () =>
    ipcRenderer.invoke('project:get-path'),

  hasProject: () =>
    ipcRenderer.invoke('project:has-project'),

  onProjectOpened: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('project:opened', handler)
    return () => { ipcRenderer.removeListener('project:opened', handler) }
  },

  onConfigChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('config:changed', handler)
    return () => { ipcRenderer.removeListener('config:changed', handler) }
  },

  openFolder: () =>
    ipcRenderer.invoke('dialog:open-folder'),

  renameSession: (id: string, name: string) =>
    ipcRenderer.invoke('session:rename', id, name),

  onMenuNewSession: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu:new-session', handler)
    return () => { ipcRenderer.removeListener('menu:new-session', handler) }
  },

  createAndOpenConfig: () =>
    ipcRenderer.invoke('config:create-and-open'),

  saveConfig: (config) =>
    ipcRenderer.invoke('config:save', JSON.parse(JSON.stringify(config))),

  onOpenThemeEditor: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu:open-theme-editor', handler)
    return () => { ipcRenderer.removeListener('menu:open-theme-editor', handler) }
  },

  onOpenProjectSettings: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu:open-project-settings', handler)
    return () => { ipcRenderer.removeListener('menu:open-project-settings', handler) }
  },

  onOpenProjectSwitcher: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu:open-project-switcher', handler)
    return () => { ipcRenderer.removeListener('menu:open-project-switcher', handler) }
  },

  onReopenLastClosed: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu:reopen-last-closed', handler)
    return () => { ipcRenderer.removeListener('menu:reopen-last-closed', handler) }
  },

  getRecentProjects: () =>
    ipcRenderer.invoke('projects:get-recent'),

  openProject: (projectPath: string) =>
    ipcRenderer.invoke('projects:open', projectPath),

  getWorkspaces: () =>
    ipcRenderer.invoke('workspaces:get'),

  getProjectWorkspace: () =>
    ipcRenderer.invoke('workspaces:for-project'),

  setProjectWorkspace: (projectPath: string, workspaceName: string) =>
    ipcRenderer.invoke('workspaces:set-project', projectPath, workspaceName),

  removeProjectFromWorkspace: (projectPath: string) =>
    ipcRenderer.invoke('workspaces:remove-project', projectPath),

  openWorkspace: (workspaceName: string, arrange: boolean) =>
    ipcRenderer.invoke('workspaces:open', workspaceName, arrange),

  setWorkspaceArrange: (workspaceName: string, arrange: boolean) =>
    ipcRenderer.invoke('workspaces:set-arrange', workspaceName, arrange),

  setWorkspaceScreenPrefs: (workspaceName: string, displayCount: number, indices: number[]) =>
    ipcRenderer.invoke('workspaces:set-screen-prefs', workspaceName, displayCount, indices),

  getDisplays: () =>
    ipcRenderer.invoke('displays:get'),

  highlightDisplay: (displayIndex: number, color: string) =>
    ipcRenderer.invoke('displays:highlight', displayIndex, color),

  clearHighlightDisplay: (displayIndex: number) =>
    ipcRenderer.invoke('displays:clear-highlight', displayIndex),

  toggleWorkspaceProject: (workspaceName: string, projectPath: string) =>
    ipcRenderer.invoke('workspaces:toggle-project', workspaceName, projectPath),

  reorderWorkspaceProjects: (workspaceName: string, newOrder: string[]) =>
    ipcRenderer.invoke('workspaces:reorder-projects', workspaceName, newOrder),

  getSidebarMode: () =>
    ipcRenderer.invoke('project:get-sidebar-mode'),

  saveSidebarMode: (mode: string) =>
    ipcRenderer.invoke('project:save-sidebar-mode', mode),

  getSidebarWidth: () =>
    ipcRenderer.invoke('project:get-sidebar-width') as Promise<number | undefined>,

  saveSidebarWidth: (width: number) =>
    ipcRenderer.invoke('project:save-sidebar-width', width),

  getSessionHistory: (projectPath?: string) =>
    ipcRenderer.invoke('session-history:get', projectPath),

  searchSessionHistory: (filter: { workspace?: string; projectPath?: string; query?: string; maxAgeDays?: number }) =>
    ipcRenderer.invoke('session-history:search', filter),

  deleteOldSessions: (maxAgeDays: number) =>
    ipcRenderer.invoke('session-history:delete-old', maxAgeDays),

  searchTranscripts: (targets: { id: string; conversationId: string; projectPath: string }[], query: string, perTargetLimit?: number) =>
    ipcRenderer.invoke('transcript:search', targets, query, perTargetLimit),

  getDashboardState: () =>
    ipcRenderer.invoke('dashboard:get-state'),

  openDashboard: () =>
    ipcRenderer.invoke('dashboard:open'),

  getUiPrefs: () =>
    ipcRenderer.invoke('ui-prefs:get'),

  setUiPrefs: (patch: Partial<import('../shared/types').UiPrefs>) =>
    ipcRenderer.invoke('ui-prefs:set', patch),

  focusSessionInProject: (projectPath: string, sessionId: string) =>
    ipcRenderer.invoke('dashboard:focus-session', projectPath, sessionId),

  sessionAction: (projectPath: string, sessionId: string, action: 'stop' | 'restart') =>
    ipcRenderer.invoke('dashboard:session-action', projectPath, sessionId, action),

  newSessionInProject: (projectPath: string) =>
    ipcRenderer.invoke('dashboard:new-session', projectPath),

  closeProjectWindow: (projectPath: string) =>
    ipcRenderer.invoke('dashboard:close-project', projectPath),

  onDashboardStateChanged: (callback: (state: DashboardState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DashboardState) => callback(state)
    ipcRenderer.on('dashboard:state-changed', handler)
    return () => { ipcRenderer.removeListener('dashboard:state-changed', handler) }
  },

  importVSCodeProjects: () =>
    ipcRenderer.invoke('import:vscode-projects'),

  detectProjectManagerFiles: () =>
    ipcRenderer.invoke('import:detect-editors'),

  importFromPath: (filePath: string) =>
    ipcRenderer.invoke('import:from-path', filePath),

  shouldShowImportSuggestion: () =>
    ipcRenderer.invoke('import:should-show-suggestion'),

  dismissImportSuggestion: () =>
    ipcRenderer.invoke('import:dismiss-suggestion'),

  removeRecentProject: (projectPath: string) =>
    ipcRenderer.invoke('projects:remove-recent', projectPath),

  deleteWorkspace: (workspaceName: string) =>
    ipcRenderer.invoke('workspaces:delete', workspaceName),

  openDataFile: (which: 'workspaces' | 'recent-projects') =>
    ipcRenderer.invoke('config:open-data-file', which),

  revealInFinder: () =>
    ipcRenderer.invoke('project:reveal-in-finder'),

  getRepoUrl: () =>
    ipcRenderer.invoke('project:get-repo-url'),

  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url),

  isCliInstalled: () =>
    ipcRenderer.invoke('cli:is-installed'),

  installCli: () =>
    ipcRenderer.invoke('cli:install'),

  installClaudeHooks: () =>
    ipcRenderer.invoke('claude-hooks:install'),

  areClaudeHooksInstalled: () =>
    ipcRenderer.invoke('claude-hooks:installed'),

  dismissCliPrompt: () =>
    ipcRenderer.invoke('cli:dismiss-prompt'),

  shouldShowCliPrompt: () =>
    ipcRenderer.invoke('cli:should-show-prompt'),

  getCliStatus: () =>
    ipcRenderer.invoke('cli:get-status') as Promise<CliStatus>,

  restartCliServer: () =>
    ipcRenderer.invoke('cli:restart-server'),

  isFinderIntegrationInstalled: () =>
    ipcRenderer.invoke('finder:is-installed'),

  installFinderIntegration: () =>
    ipcRenderer.invoke('finder:install'),

  uninstallFinderIntegration: () =>
    ipcRenderer.invoke('finder:uninstall'),

  checkForUpdate: () =>
    ipcRenderer.invoke('update:check'),

  getLastUpdateCheck: () =>
    ipcRenderer.invoke('update:get-last-check'),

  applyUpdate: () =>
    ipcRenderer.invoke('update:apply'),

  downloadUpdate: () =>
    ipcRenderer.invoke('update:download'),

  onDownloadProgress: (callback: (progress: { progress: number; receivedBytes: number; totalBytes: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { progress: number; receivedBytes: number; totalBytes: number }) =>
      callback(data)
    ipcRenderer.on('update:download-progress', handler)
    return () => { ipcRenderer.removeListener('update:download-progress', handler) }
  },

  installUpdate: () =>
    ipcRenderer.invoke('update:install'),

  getUpdateCommand: () =>
    ipcRenderer.invoke('update:get-command'),

  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: UpdateInfo) => callback(info)
    ipcRenderer.on('update:available', handler)
    return () => { ipcRenderer.removeListener('update:available', handler) }
  },

  onUpdateCheckResult: (callback: (info: UpdateInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: UpdateInfo) => callback(info)
    ipcRenderer.on('update:check-result', handler)
    return () => { ipcRenderer.removeListener('update:check-result', handler) }
  },

  getFavoriteThemes: () =>
    ipcRenderer.invoke('themes:get-favorites'),

  saveFavoriteTheme: (theme) =>
    ipcRenderer.invoke('themes:save-favorite', JSON.parse(JSON.stringify(theme))),

  deleteFavoriteTheme: (name: string) =>
    ipcRenderer.invoke('themes:delete-favorite', name),

  getAllSessionTemplates: () =>
    ipcRenderer.invoke('sessions:get-all-templates'),

  onFocusSession: (callback: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) =>
      callback(sessionId)
    ipcRenderer.on('notification:focus-session', handler)
    return () => { ipcRenderer.removeListener('notification:focus-session', handler) }
  },

  takePendingStarts: () =>
    ipcRenderer.invoke('session:take-pending-starts'),

  onFlushPendingStarts: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('cli:flush-pending-starts', handler)
    return () => { ipcRenderer.removeListener('cli:flush-pending-starts', handler) }
  },

  readFileContent: (filePath: string) =>
    ipcRenderer.invoke('file:read-content', filePath),

  copyFileToProject: (filePath: string) =>
    ipcRenderer.invoke('file:copy-to-project', filePath),

  renameWorkspace: (oldName: string, newName: string) =>
    ipcRenderer.invoke('workspaces:rename', oldName, newName),

  updateWorkspace: (name: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('workspaces:update', name, JSON.parse(JSON.stringify(updates))),

  addProjectToWorkspace: (workspaceName: string, projectPath: string) =>
    ipcRenderer.invoke('workspaces:add-project', workspaceName, projectPath),

  startRemoteAccess: () =>
    ipcRenderer.invoke('remote:start'),

  stopRemoteAccess: () =>
    ipcRenderer.invoke('remote:stop'),

  getRemoteStatus: () =>
    ipcRenderer.invoke('remote:status'),

  onRemoteStatusChanged: (callback: (status: RemoteStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: RemoteStatus) => callback(status)
    ipcRenderer.on('remote:status-changed', handler)
    return () => { ipcRenderer.removeListener('remote:status-changed', handler) }
  },

  reportSessionStatuses: (statuses, activeSessionId) =>
    ipcRenderer.send('activity:report', statuses, activeSessionId),

  onSessionRenamed: (callback: (sessionId: string, name: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, name: string) => callback(sessionId, name)
    ipcRenderer.on('session:renamed', handler)
    return () => { ipcRenderer.removeListener('session:renamed', handler) }
  },

  onSessionClosed: (callback: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('session:closed', handler)
    return () => { ipcRenderer.removeListener('session:closed', handler) }
  },

  onSessionInfoUpdated: (callback: (sessionId: string, info: SessionContext) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, info: SessionContext) => callback(sessionId, info)
    ipcRenderer.on('session:info-updated', handler)
    return () => { ipcRenderer.removeListener('session:info-updated', handler) }
  },

  onContextUpdated: (callback: (sessionId: string, percent: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, percent: number) => callback(sessionId, percent)
    ipcRenderer.on('session:context-updated', handler)
    return () => { ipcRenderer.removeListener('session:context-updated', handler) }
  },

  onConversationUpdated: (callback: (sessionId: string, conversationId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, conversationId: string) => callback(sessionId, conversationId)
    ipcRenderer.on('session:conversation-updated', handler)
    return () => { ipcRenderer.removeListener('session:conversation-updated', handler) }
  },

  onSessionActivityUpdated: (callback: (sessionId: string, signal: import('../shared/types').SessionActivitySignal) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, signal: import('../shared/types').SessionActivitySignal) => callback(sessionId, signal)
    ipcRenderer.on('session:activity-updated', handler)
    return () => { ipcRenderer.removeListener('session:activity-updated', handler) }
  },

  getSavedSessions: () =>
    ipcRenderer.invoke('sessions:get-saved'),

  clearSavedSessions: () =>
    ipcRenderer.invoke('sessions:clear-saved'),

  deleteSession: (id: string) =>
    ipcRenderer.invoke('session:delete', id),

  checkClaudeConnection: () =>
    ipcRenderer.invoke('claude:check-connection'),

  getClaudeSetupPrompt: () =>
    ipcRenderer.invoke('claude:get-setup-prompt'),

  getClaudeLaunch: () =>
    ipcRenderer.invoke('claude:get-launch'),

  closeWindow: () =>
    ipcRenderer.invoke('window:close'),
}

contextBridge.exposeInMainWorld('forgeterm', api)
