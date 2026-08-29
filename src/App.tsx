import { useEffect, useState, useCallback, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { TerminalView, clearTerminal, scrollTerminalToTop, scrollTerminalToBottom, selectAllTerminal, toggleTerminalSearch, revealTerminalMatch } from './components/TerminalView'
import { GlobalSearch } from './components/GlobalSearch'
import { ProjectHistory } from './components/ProjectHistory'
import { NewSessionModal } from './components/NewSessionModal'
import { ThemeEditor } from './components/ThemeEditor'
import { ProjectSettings } from './components/ProjectSettings'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { HelpModal } from './components/HelpModal'
import { CliInstallModal } from './components/CliInstallModal'
import { RemoteAccessModal } from './components/RemoteAccessModal'
import { SessionInfoPanel } from './components/SessionInfoPanel'
import { Dashboard } from './components/Dashboard'
import { UpdateBanner } from './components/UpdateBanner'
import { ClaudeConnectionBanner } from './components/ClaudeConnectionBanner'
import { useSessionStore } from './store/sessionStore'
import type { ForgeTermConfig, CliStatus, ClaudeLaunch, HistoricalSession } from '../shared/types'
import type { WindowTheme } from './themes'
import { generateWindowTheme, adjustAccentBrightness, getTerminalTheme, titlebarGradient, accentGlow } from './themes'
import './App.css'

type SidebarMode = 'full' | 'compact' | 'hidden'

const DEFAULT_CLAUDE_LAUNCH: ClaudeLaunch = { cliName: 'claude', resumeArgs: ['--dangerously-skip-permissions'] }

// Build the command that resumes a Claude conversation, honoring the project's
// resolved CLI name (e.g. "claude-hsp") and resume args (skip-permissions toggle).
function buildResumeCommand(conversationId: string, launch: ClaudeLaunch): string {
  return [launch.cliName, ...launch.resumeArgs, '--resume', conversationId].join(' ')
}

// What a brand-new session runs by default: this project's Claude CLI with its
// permission flags. `cliName` resolves project -> workspace -> "claude", so an
// HSP project (whose workspace sets claudeCliName) gets "claude-hsp"; the args
// carry --dangerously-skip-permissions unless the project opted out.
function buildClaudeCommand(launch: ClaudeLaunch): string {
  return [launch.cliName, ...launch.resumeArgs].join(' ')
}

const DEFAULT_SESSION_NAME = 'Claude'

const isDashboard = new URLSearchParams(window.location.search).get('mode') === 'dashboard'

function App() {
  if (isDashboard) return <Dashboard />

  const { sessions, activeSessionId, addSession, setRunning, setActive, removeSession } = useSessionStore()
  const [config, setConfig] = useState<ForgeTermConfig | null>(null)
  const [claudeLaunch, setClaudeLaunch] = useState<ClaudeLaunch>(DEFAULT_CLAUDE_LAUNCH)
  const [showModal, setShowModal] = useState(false)
  // Which field the New Session modal focuses on open: Cmd+N goes straight to the
  // name (Enter creates the default Claude session), Cmd+T lands in the search box.
  const [modalFocus, setModalFocus] = useState<'name' | 'search'>('name')
  const [showThemeEditor, setShowThemeEditor] = useState(false)
  const [showProjectSettings, setShowProjectSettings] = useState(false)
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [showCliInstall, setShowCliInstall] = useState(false)
  const [showCliPrompt, setShowCliPrompt] = useState(false)
  const [showRemoteAccess, setShowRemoteAccess] = useState(false)
  const [showGlobalSearch, setShowGlobalSearch] = useState(false)
  const [globalSearchScope, setGlobalSearchScope] = useState<'all' | string>('all')
  const [showHistory, setShowHistory] = useState(false)
  const [projectPath, setProjectPath] = useState('')
  const [infoPanelSessionId, setInfoPanelSessionId] = useState<string | null>(null)
  const [remoteRunning, setRemoteRunning] = useState(false)
  const [cliStatus, setCliStatus] = useState<CliStatus>('not-setup')
  const [folderName, setFolderName] = useState('ForgeTerm')
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('full')
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const [previewTheme, setPreviewTheme] = useState<WindowTheme | null>(null)
  const initializedRef = useRef(false)
  const sidebarWidthSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const displayName = config?.projectName || folderName
  const win = config?.window
  // Use preview theme (from hover) if available, otherwise use config
  const effectiveWin = previewTheme ?? win
  const accentColor = effectiveWin?.accentColor ?? '#38bdf8'
  const titlebarBg = titlebarGradient(effectiveWin)
  const titlebarFg = effectiveWin?.titlebarForeground ?? '#8faabe'
  const sidebarBg = effectiveWin?.sidebarBackground
  const sidebarFg = effectiveWin?.sidebarForeground
  const buttonBg = effectiveWin?.buttonBackground
  const emoji = win?.emoji
  // Default command for every newly created session (see buildClaudeCommand).
  const claudeStartCommand = buildClaudeCommand(claudeLaunch)

  const createSession = useCallback(async (name: string, command?: string, idle?: boolean, focus?: boolean) => {
    const id = await window.forgeterm.createSession(name, command, idle)
    if (id) {
      addSession({ id, name, command, running: !idle })
      // addSession only auto-activates the very first session, so an explicitly
      // created one has to be switched to on purpose.
      if (focus) setActive(id)
    }
    return id
  }, [addSession, setActive])

  // Drain any sessions queued by the `ft start` CLI for this window and focus the
  // last one. Runs after initial sessions are set up, and whenever main flushes.
  const consumePendingStarts = useCallback(async () => {
    const pending = await window.forgeterm.takePendingStarts()
    for (const req of pending) {
      const id = await window.forgeterm.createSession(req.name, req.command, req.idle)
      if (id) {
        addSession({ id, name: req.name, command: req.command, running: !req.idle })
        setActive(id)
      }
    }
  }, [addSession, setActive])

  // Initialize
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    async function init() {
      const [projectConfig, projectPath, savedSidebarMode, savedSidebarWidth, hasProject, savedState, launch] = await Promise.all([
        window.forgeterm.getProjectConfig(),
        window.forgeterm.getProjectPath(),
        window.forgeterm.getSidebarMode(),
        window.forgeterm.getSidebarWidth(),
        window.forgeterm.hasProject(),
        window.forgeterm.getSavedSessions(),
        window.forgeterm.getClaudeLaunch(),
      ])

      if (!hasProject) {
        setShowWelcome(true)
        return
      }

      setConfig(projectConfig)
      setClaudeLaunch(launch)
      if (projectPath) setProjectPath(projectPath)
      if (savedSidebarMode) setSidebarMode(savedSidebarMode)
      if (savedSidebarWidth) setSidebarWidth(savedSidebarWidth)
      const folder = projectPath?.split('/').pop() || 'ForgeTerm'
      setFolderName(folder)
      document.title = projectConfig?.projectName || folder

      // Restore from saved state if available
      if (savedState && savedState.sessions.length > 0) {
        const sorted = [...savedState.sessions].sort((a, b) => a.order - b.order)
        const results = await Promise.all(
          sorted.map(async (s) => {
            let command = s.command
            let idle = !s.wasRunning

            if (s.claudeSessionId) {
              // Don't auto-resume Claude sessions on open: come up stopped, the
              // user resumes via the play button or the info-panel Resume button.
              command = buildResumeCommand(s.claudeSessionId, launch)
              idle = true
            }

            const id = await window.forgeterm.createSession(s.name, command, idle, s.nameLocked)
            return id ? { id, name: s.name, command: s.command, running: !idle, info: s.info, conversationId: s.claudeSessionId } : null
          })
        )
        for (const r of results) {
          if (r) {
            addSession(r)
            if (r.info) {
              useSessionStore.getState().setSessionInfo(r.id, r.info)
            }
            if (r.conversationId) {
              useSessionStore.getState().setConversationId(r.id, r.conversationId)
            }
          }
        }

        if (savedState.activeSessionName) {
          const match = useSessionStore.getState().sessions.find(s => s.name === savedState.activeSessionName)
          if (match) useSessionStore.getState().setActive(match.id)
        }

        await window.forgeterm.clearSavedSessions()
        await consumePendingStarts()
        return
      }

      // Create sessions in parallel for faster startup
      if (projectConfig?.sessions?.length) {
        const results = await Promise.all(
          projectConfig.sessions.map(async (s) => {
            const idle = s.autoStart === false
            const id = await window.forgeterm.createSession(s.name, s.command, idle)
            return id ? { id, name: s.name, command: s.command, running: !idle } : null
          })
        )
        for (const r of results) {
          if (r) addSession(r)
        }
      } else {
        await createSession('shell')
      }

      await consumePendingStarts()
    }

    init()
  }, [createSession, addSession])

  // Check CLI status on mount and periodically
  const refreshCliStatus = useCallback(() => {
    window.forgeterm.getCliStatus().then((status) => {
      setCliStatus(status)
      if (status === 'not-setup') {
        window.forgeterm.shouldShowCliPrompt().then(setShowCliPrompt)
      } else {
        setShowCliPrompt(false)
      }
    })
  }, [])

  useEffect(() => {
    refreshCliStatus()
    const interval = setInterval(refreshCliStatus, 60_000)
    return () => clearInterval(interval)
  }, [refreshCliStatus])

  // Track remote access status
  useEffect(() => {
    window.forgeterm.getRemoteStatus().then(s => setRemoteRunning(s.running))
    return window.forgeterm.onRemoteStatusChanged(s => setRemoteRunning(s.running))
  }, [])

  // Report session statuses to main process for tray menu and dock badge
  useEffect(() => {
    const interval = setInterval(() => {
      const store = useSessionStore.getState()
      const statuses = store.sessions.map((s) => ({
        sessionId: s.id,
        sessionName: s.name,
        status: s.activityStatus,
      }))
      window.forgeterm.reportSessionStatuses(statuses, store.activeSessionId)
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  // Listen for CLI-driven session rename and info updates
  useEffect(() => {
    const unsubRename = window.forgeterm.onSessionRenamed((sessionId, name) => {
      useSessionStore.getState().renameSession(sessionId, name)
    })
    const unsubClosed = window.forgeterm.onSessionClosed((sessionId) => {
      useSessionStore.getState().removeSession(sessionId)
    })
    const unsubInfo = window.forgeterm.onSessionInfoUpdated((sessionId, info) => {
      useSessionStore.getState().setSessionInfo(sessionId, info)
    })
    const unsubContext = window.forgeterm.onContextUpdated((sessionId, percent) => {
      useSessionStore.getState().setContextPercent(sessionId, percent)
    })
    const unsubConversation = window.forgeterm.onConversationUpdated((sessionId, conversationId) => {
      useSessionStore.getState().setConversationId(sessionId, conversationId)
    })
    const unsubActivity = window.forgeterm.onSessionActivityUpdated((sessionId, signal) => {
      const st = useSessionStore.getState()
      const viewing = st.activeSessionId === sessionId && document.hasFocus()
      st.applyActivitySignal(sessionId, signal, viewing)
    })
    return () => { unsubRename(); unsubClosed(); unsubInfo(); unsubContext(); unsubConversation(); unsubActivity() }
  }, [])

  // Listen for session exits
  useEffect(() => {
    return window.forgeterm.onSessionExit((id, _exitCode) => {
      setRunning(id, false)
    })
  }, [setRunning])

  // Listen for config changes
  useEffect(() => {
    return window.forgeterm.onConfigChanged(async () => {
      const [newConfig, launch] = await Promise.all([
        window.forgeterm.getProjectConfig(),
        window.forgeterm.getClaudeLaunch(),
      ])
      setConfig(newConfig)
      setClaudeLaunch(launch)
      if (newConfig?.projectName) {
        document.title = newConfig.projectName
      }
    })
  }, [])

  const openNewSessionModal = useCallback((focus: 'name' | 'search' = 'name') => {
    setModalFocus(focus)
    setShowModal(true)
  }, [])

  // Listen for menu events
  useEffect(() => {
    return window.forgeterm.onMenuNewSession(() => openNewSessionModal('name'))
  }, [openNewSessionModal])

  useEffect(() => {
    return window.forgeterm.onOpenThemeEditor(() => setShowThemeEditor(true))
  }, [])

  useEffect(() => {
    return window.forgeterm.onOpenProjectSettings(() => setShowProjectSettings(true))
  }, [])

  useEffect(() => {
    return window.forgeterm.onOpenProjectSwitcher(() => setShowProjectSwitcher(true))
  }, [])

  // Focus session when notification is clicked
  useEffect(() => {
    return window.forgeterm.onFocusSession((sessionId) => {
      setActive(sessionId)
    })
  }, [setActive])

  // Start sessions requested via `ft start` while this window is already open.
  useEffect(() => {
    return window.forgeterm.onFlushPendingStarts(() => {
      consumePendingStarts()
    })
  }, [consumePendingStarts])

  // When a project is opened in a welcome window, reinitialize
  useEffect(() => {
    return window.forgeterm.onProjectOpened(async () => {
      setShowWelcome(false)
      initializedRef.current = false
      const [projectConfig, projectPath, savedSidebarMode, savedSidebarWidth, savedState, launch] = await Promise.all([
        window.forgeterm.getProjectConfig(),
        window.forgeterm.getProjectPath(),
        window.forgeterm.getSidebarMode(),
        window.forgeterm.getSidebarWidth(),
        window.forgeterm.getSavedSessions(),
        window.forgeterm.getClaudeLaunch(),
      ])
      setConfig(projectConfig)
      setClaudeLaunch(launch)
      if (projectPath) setProjectPath(projectPath)
      if (savedSidebarMode) setSidebarMode(savedSidebarMode)
      if (savedSidebarWidth) setSidebarWidth(savedSidebarWidth)
      const folder = projectPath?.split('/').pop() || 'ForgeTerm'
      setFolderName(folder)
      document.title = projectConfig?.projectName || folder

      if (savedState && savedState.sessions.length > 0) {
        const sorted = [...savedState.sessions].sort((a, b) => a.order - b.order)
        const results = await Promise.all(
          sorted.map(async (s) => {
            let command = s.command
            let idle = !s.wasRunning
            if (s.claudeSessionId) {
              command = buildResumeCommand(s.claudeSessionId, launch)
              idle = true
            }
            const id = await window.forgeterm.createSession(s.name, command, idle, s.nameLocked)
            return id ? { id, name: s.name, command: s.command, running: !idle, info: s.info, conversationId: s.claudeSessionId } : null
          })
        )
        for (const r of results) {
          if (r) {
            addSession(r)
            if (r.info) useSessionStore.getState().setSessionInfo(r.id, r.info)
            if (r.conversationId) useSessionStore.getState().setConversationId(r.id, r.conversationId)
          }
        }
        if (savedState.activeSessionName) {
          const match = useSessionStore.getState().sessions.find(s => s.name === savedState.activeSessionName)
          if (match) useSessionStore.getState().setActive(match.id)
        }
        await window.forgeterm.clearSavedSessions()
      } else if (projectConfig?.sessions?.length) {
        const results = await Promise.all(
          projectConfig.sessions.map(async (s) => {
            const idle = s.autoStart === false
            const id = await window.forgeterm.createSession(s.name, s.command, idle)
            return id ? { id, name: s.name, command: s.command, running: !idle } : null
          })
        )
        for (const r of results) {
          if (r) addSession(r)
        }
      } else {
        await createSession('shell')
      }

      await consumePendingStarts()
    })
  }, [createSession, addSession])

  const cycleSidebarMode = useCallback(() => {
    setSidebarMode((prev) => {
      const next = prev === 'full' ? 'compact' : prev === 'compact' ? 'hidden' : 'full'
      window.forgeterm.saveSidebarMode(next)
      return next
    })
  }, [])

  const handleSidebarWidthChange = useCallback((newWidth: number) => {
    setSidebarWidth(newWidth)
    if (sidebarWidthSaveRef.current) clearTimeout(sidebarWidthSaveRef.current)
    sidebarWidthSaveRef.current = setTimeout(() => {
      window.forgeterm.saveSidebarWidth(newWidth)
    }, 300)
  }, [])

  const handleThemePreview = useCallback((windowTheme: WindowTheme | null) => {
    setPreviewTheme(windowTheme)
  }, [])

  const adjustCurrentThemeBrightness = useCallback(async (delta: number) => {
    const currentAccent = config?.window?.accentColor ?? '#38bdf8'
    const newAccent = adjustAccentBrightness(currentAccent, delta)
    const newWindow = generateWindowTheme(newAccent)
    const terminal = getTerminalTheme(config?.terminalTheme ?? 'dark')
    terminal.cursor = newAccent
    const updated: ForgeTermConfig = {
      ...config,
      theme: terminal,
      window: {
        ...newWindow,
        emoji: config?.window?.emoji,
        themeName: undefined, // no longer a preset
      },
    }
    await window.forgeterm.saveConfig(updated)
    setConfig(updated)
  }, [config])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      // Cmd+B: cycle sidebar mode
      if (mod && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        cycleSidebarMode()
      }

      // Cmd+N or Cmd+T: new session. Cmd+T is the "recent sessions" entry point,
      // so it opens the same modal focused on its search box.
      if (mod && !e.shiftKey && (e.key === 'n' || e.key === 't')) {
        e.preventDefault()
        openNewSessionModal(e.key === 't' ? 'search' : 'name')
      }

      // Cmd+Shift+D: Control Panel - every project and session in one board
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        window.forgeterm.openDashboard()
      }

      // Cmd+Shift+Y: theme editor (Cmd+Shift+T now reopens the last closed
      // session, Chrome-style, handled by the app-menu accelerator).
      if (mod && e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        setShowThemeEditor(true)
      }

      // Cmd+,: project settings
      if (mod && e.key === ',') {
        e.preventDefault()
        setShowProjectSettings(true)
      }

      // Cmd+P: project switcher
      if (mod && !e.shiftKey && e.key === 'p') {
        e.preventDefault()
        setShowProjectSwitcher(true)
      }

      // Cmd+A: select all terminal content
      if (mod && !e.shiftKey && e.key === 'a') {
        e.preventDefault()
        if (activeSessionId) {
          selectAllTerminal(activeSessionId)
        }
      }

      // Cmd+F: search the active session. Claude renders full-screen (alt buffer,
      // no scrollback), so search its on-disk transcript via the unified panel;
      // other shells keep the in-terminal buffer search bar.
      if (mod && !e.shiftKey && e.key === 'f') {
        e.preventDefault()
        if (activeSessionId) {
          const s = useSessionStore.getState().sessions.find((x) => x.id === activeSessionId)
          if (s?.conversationId) {
            setGlobalSearchScope(activeSessionId)
            setShowGlobalSearch(true)
          } else {
            toggleTerminalSearch(activeSessionId)
          }
        }
      }

      // Cmd+Shift+F: search across all open sessions
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setGlobalSearchScope('all')
        setShowGlobalSearch(true)
      }

      // Cmd+Shift+H: browse this project's session history (reopen closed sessions)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setShowHistory(true)
      }

      // Cmd+W: delete active session
      if (mod && !e.shiftKey && e.key === 'w') {
        e.preventDefault()
        const store = useSessionStore.getState()
        if (store.activeSessionId) {
          window.forgeterm.deleteSession(store.activeSessionId)
          removeSession(store.activeSessionId)
        }
      }

      // Cmd+Shift+W: close the project window
      if (mod && e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        window.forgeterm.closeWindow()
      }

      // Cmd+R: rename the active session inline (does NOT reload the renderer)
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        const store = useSessionStore.getState()
        if (store.activeSessionId) store.requestRename(store.activeSessionId)
      }

      // Cmd+K: clear terminal
      if (mod && e.key === 'k') {
        e.preventDefault()
        if (activeSessionId) {
          clearTerminal(activeSessionId)
        }
      }

      // Cmd+Down: scroll to bottom
      if (mod && e.key === 'ArrowDown') {
        e.preventDefault()
        if (activeSessionId) scrollTerminalToBottom(activeSessionId)
      }

      // Cmd+Up: scroll to top
      if (mod && e.key === 'ArrowUp') {
        e.preventDefault()
        if (activeSessionId) scrollTerminalToTop(activeSessionId)
      }

      // Cmd+1-9: switch sessions
      if (mod && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const index = parseInt(e.key) - 1
        const store = useSessionStore.getState()
        if (index < store.sessions.length) {
          setActive(store.sessions[index].id)
        }
      }

      // Cmd+?: help
      if (mod && e.shiftKey && e.key === '?') {
        e.preventDefault()
        setShowHelp(true)
      }

      // Cmd+Shift+= / Cmd+Shift+-: lighten/darken accent
      if (mod && e.shiftKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        adjustCurrentThemeBrightness(7)
      }
      if (mod && e.shiftKey && e.key === '_') {
        e.preventDefault()
        adjustCurrentThemeBrightness(-7)
      }

      // Escape: close modals and panels
      if (e.key === 'Escape') {
        setShowModal(false)
        setShowThemeEditor(false)
        setShowProjectSettings(false)
        setShowProjectSwitcher(false)
        setShowHelp(false)
        setShowCliInstall(false)
        setShowRemoteAccess(false)
        setShowGlobalSearch(false)
        setShowHistory(false)
        setInfoPanelSessionId(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSessionId, setActive, removeSession, cycleSidebarMode, adjustCurrentThemeBrightness, openNewSessionModal])

  const handleNewSession = useCallback(async (name: string, command?: string, addToStartup?: boolean) => {
    setShowModal(false)
    await createSession(name, command, false, true)
    if (addToStartup) {
      const currentConfig = config || {}
      const existingSessions = currentConfig.sessions || []
      const alreadyExists = existingSessions.some((s) => s.name === name && s.command === command)
      if (!alreadyExists) {
        const updatedConfig: ForgeTermConfig = {
          ...currentConfig,
          sessions: [...existingSessions, { name, command, autoStart: true }],
        }
        await window.forgeterm.saveConfig(updatedConfig)
        setConfig(updatedConfig)
      }
    }
  }, [createSession, config])

  // Resume a Claude conversation in a brand-new session (used when the source
  // session is already running).
  const handleResumeSession = useCallback(async (conversationId: string, name: string) => {
    const command = buildResumeCommand(conversationId, claudeLaunch)
    const resumeName = `${name} (resume)`
    const id = await window.forgeterm.createSession(resumeName, command)
    if (id) {
      addSession({ id, name: resumeName, command, running: true })
      setActive(id)
    }
    setInfoPanelSessionId(null)
  }, [claudeLaunch, addSession, setActive])

  // Reopen a closed/historical session as a new one. Claude sessions resume the
  // conversation; other shells re-run their stored command.
  const handleReopenHistorical = useCallback(async (h: HistoricalSession) => {
    const command = h.conversationId ? buildResumeCommand(h.conversationId, claudeLaunch) : h.command
    const id = await window.forgeterm.createSession(h.name, command)
    if (id) {
      addSession({ id, name: h.name, command, running: true, conversationId: h.conversationId })
      setActive(id)
    }
    setShowHistory(false)
    setShowModal(false)
  }, [claudeLaunch, addSession, setActive])

  // Reopen the single most-recently-closed session (Chrome-style Cmd+Shift+T).
  // Picks the newest closed session for this project that isn't already open.
  const handleReopenLastClosed = useCallback(async () => {
    if (!projectPath) return
    const openIds = new Set(
      useSessionStore.getState().sessions.map((s) => s.conversationId).filter(Boolean) as string[],
    )
    const sessions = await window.forgeterm.getSessionHistory(projectPath)
    let best: HistoricalSession | null = null
    for (const s of sessions) {
      if (s.conversationId && openIds.has(s.conversationId)) continue
      if (!best || (s.endedAt ?? s.createdAt) > (best.endedAt ?? best.createdAt)) best = s
    }
    if (best) handleReopenHistorical(best)
  }, [projectPath, handleReopenHistorical])

  // Cmd+Shift+T (via the app menu accelerator) -> reopen last closed session.
  useEffect(() => {
    return window.forgeterm.onReopenLastClosed(() => handleReopenLastClosed())
  }, [handleReopenLastClosed])

  // Resume a stopped session in place: starts it, running its stored resume command.
  const handleResumeInPlace = useCallback(async (sessionId: string) => {
    await window.forgeterm.restartSession(sessionId)
    setRunning(sessionId, true)
    setActive(sessionId)
    setInfoPanelSessionId(null)
  }, [setRunning, setActive])

  const handleRevealMatch = useCallback((sessionId: string, line: number, col: number, length: number) => {
    const wasActive = useSessionStore.getState().activeSessionId === sessionId
    setActive(sessionId)
    setShowGlobalSearch(false)
    // When switching sessions, the activation effect scrolls the terminal to the
    // bottom in a rAF; wait for that before scrolling to the match so it wins.
    setTimeout(() => revealTerminalMatch(sessionId, line, col, length), wasActive ? 0 : 130)
  }, [setActive])

  const handleSaveTheme = useCallback(async (updatedConfig: ForgeTermConfig) => {
    setShowThemeEditor(false)
    await window.forgeterm.saveConfig(updatedConfig)
    setConfig(updatedConfig)
  }, [])

  const handleSaveProjectSettings = useCallback(async (updatedConfig: ForgeTermConfig) => {
    setShowProjectSettings(false)
    await window.forgeterm.saveConfig(updatedConfig)
    setConfig(updatedConfig)
    // The CLI name / skip-permissions toggle live here, so re-resolve the launch
    // settings that new sessions and resumes are built from.
    setClaudeLaunch(await window.forgeterm.getClaudeLaunch())
    if (updatedConfig.projectName) {
      document.title = updatedConfig.projectName
    } else {
      document.title = folderName
    }

    // Create any newly configured sessions that don't exist yet
    const configuredSessions = updatedConfig.sessions || []
    const currentSessions = useSessionStore.getState().sessions
    for (const cs of configuredSessions) {
      const exists = currentSessions.some((s) => s.name === cs.name)
      if (!exists) {
        const idle = cs.autoStart === false
        await createSession(cs.name, cs.command, idle)
      }
    }
  }, [createSession, folderName])

  const handleEditConfig = useCallback(() => {
    window.forgeterm.createAndOpenConfig()
  }, [])

  return (
    <div
      className="app"
      style={{
        '--accent-color': accentColor,
        '--accent-glow': accentGlow(accentColor, 0.55),
        '--accent-glow-soft': accentGlow(accentColor, 0.18),
      } as React.CSSProperties}
    >
      <div className="titlebar" style={{ background: titlebarBg }}>
        <button
          className="sidebar-toggle-btn"
          onClick={cycleSidebarMode}
          title={`Toggle Sidebar (${navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl+'}B)`}
          style={{ color: titlebarFg }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" />
            {sidebarMode === 'hidden' && <line x1="3" y1="8" x2="5" y2="8" strokeWidth="1.5" />}
          </svg>
        </button>
        <span className="titlebar-text" style={{ color: titlebarFg }}>
          {emoji && <span className="titlebar-emoji">{emoji}</span>}
          {displayName}
        </span>
        <div className="titlebar-actions">
          <button
            className="titlebar-action-btn"
            onClick={() => { setGlobalSearchScope('all'); setShowGlobalSearch(true) }}
            title={`Search All Sessions (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}⇧F)`}
            style={{ background: 'rgba(255,255,255,0.1)', color: titlebarFg }}
          >
            {/* Magnifier */}
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
          </button>
          <button
            className="titlebar-action-btn"
            onClick={() => setShowHistory(true)}
            title={`Session History (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}⇧H)`}
            style={{ background: 'rgba(255,255,255,0.1)', color: titlebarFg }}
          >
            {/* Clock / history */}
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 4.5V8l2.5 1.5" />
            </svg>
          </button>
          <button
            className="titlebar-action-btn"
            onClick={() => window.forgeterm.revealInFinder()}
            title="Reveal in Finder"
            style={{ background: 'rgba(255,255,255,0.1)', color: titlebarFg }}
          >
            {/* macOS Finder icon */}
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1.5" y="1" width="13" height="14" rx="2" />
              <line x1="1.5" y1="5" x2="14.5" y2="5" />
              <circle cx="5.5" cy="8.5" r="0.75" fill="currentColor" stroke="none" />
              <circle cx="10.5" cy="8.5" r="0.75" fill="currentColor" stroke="none" />
              <path d="M5.5 11.5c0 0 1.5 1.5 5 0" />
            </svg>
          </button>
          <button
            className="open-project-btn"
            onClick={() => setShowProjectSwitcher(true)}
            title="Switch Project (Cmd+P)"
            style={{ background: accentColor }}
          >
            {/* Grid/switch icon */}
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
              <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
              <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
            </svg>
            Open
          </button>
        </div>
      </div>
      <UpdateBanner accentColor={accentColor} />
      <div className="main-layout">
        {sidebarMode !== 'hidden' && (
          <Sidebar
            mode={sidebarMode}
            accentColor={accentColor}
            sidebarBackground={sidebarBg}
            sidebarForeground={sidebarFg}
            buttonBackground={buttonBg}
            width={sidebarWidth}
            onWidthChange={handleSidebarWidthChange}
            onNewSession={() => openNewSessionModal('name')}
            onQuickSession={() => createSession(DEFAULT_SESSION_NAME, claudeStartCommand, false, true)}
            onQuickTerminal={() => createSession('Terminal', undefined, false, true)}
            onDuplicateSession={(name, command) => createSession(name, command, false, true)}
            onProjectSettings={() => setShowProjectSettings(true)}
            onThemeEditor={() => setShowThemeEditor(true)}
            onHelp={() => setShowHelp(true)}
            onCli={() => setShowCliInstall(true)}
            onRemote={() => setShowRemoteAccess(true)}
            onInfoPanel={(id) => setInfoPanelSessionId(infoPanelSessionId === id ? null : id)}
            cliStatus={cliStatus}
            remoteRunning={remoteRunning}
          />
        )}
        {infoPanelSessionId && (() => {
          const panelSession = sessions.find(s => s.id === infoPanelSessionId)
          return panelSession ? (
            <SessionInfoPanel
              session={panelSession}
              accentColor={accentColor}
              onClose={() => setInfoPanelSessionId(null)}
              onResume={handleResumeSession}
              onResumeInPlace={handleResumeInPlace}
            />
          ) : null
        })()}
        <div className={`terminal-area${sidebarMode === 'hidden' || showCliPrompt ? ' has-floating' : ''}`}>
          {sessions.map((session) => (
            <TerminalView
              key={session.id}
              sessionId={session.id}
              active={session.id === activeSessionId}
              config={config}
            />
          ))}
          {sessions.length === 0 && (
            <div className="empty-state">
              <p>No sessions. Press Cmd+N to create one.</p>
            </div>
          )}
          {sidebarMode === 'hidden' && (
            <div className="floating-actions">
              <button className="sidebar-action-btn" onClick={() => openNewSessionModal('name')} title="New Session (Cmd+N)" style={{ background: buttonBg, color: sidebarFg }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
              </button>
              <button className="sidebar-action-btn" onClick={() => setShowProjectSettings(true)} title="Project Settings (Cmd+,)" style={{ background: buttonBg, color: sidebarFg }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </button>
              <button className="sidebar-action-btn" onClick={() => setShowThemeEditor(true)} title="Theme Editor (Cmd+Shift+T)" style={{ background: buttonBg, color: sidebarFg }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h1a2 2 0 0 0 2-2 10 10 0 0 0-7-13z" /><circle cx="8" cy="10" r="1.5" fill="currentColor" /><circle cx="12" cy="7" r="1.5" fill="currentColor" /><circle cx="16" cy="10" r="1.5" fill="currentColor" /><circle cx="9" cy="14" r="1.5" fill="currentColor" /></svg>
              </button>
              <button className="sidebar-action-btn" onClick={() => setShowHelp(true)} title="Help & Shortcuts (?)" style={{ background: buttonBg, color: sidebarFg }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              </button>
              <button className="sidebar-action-btn" onClick={() => setShowCliInstall(true)} title="CLI Tool" style={{ background: buttonBg, color: sidebarFg, position: 'relative' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
                <span className="cli-status-dot" style={{
                  background: cliStatus === 'connected' ? '#4ade80' : cliStatus === 'error' ? '#f87171' : '#fb923c',
                  boxShadow: `0 0 4px ${cliStatus === 'connected' ? '#4ade8080' : cliStatus === 'error' ? '#f8717180' : '#fb923c80'}`,
                }} />
              </button>
            </div>
          )}
          {showCliPrompt && (
            <button
              className="cli-install-hint"
              onClick={() => setShowCliInstall(true)}
              title="Install CLI tool"
              style={{ '--cli-glow-color': accentColor } as React.CSSProperties}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              Install CLI
            </button>
          )}
          <ClaudeConnectionBanner accentColor={accentColor} />
        </div>
      </div>

      {showModal && (
        <NewSessionModal
          accentColor={accentColor}
          presets={(config?.sessions || []).map((s) => ({ name: s.name, command: s.command }))}
          projectPath={projectPath}
          openConversationIds={sessions.map((s) => s.conversationId).filter(Boolean) as string[]}
          defaultName={DEFAULT_SESSION_NAME}
          defaultCommand={claudeStartCommand}
          initialFocus={modalFocus}
          onSubmit={handleNewSession}
          onReopen={handleReopenHistorical}
          onCancel={() => setShowModal(false)}
        />
      )}

      {showThemeEditor && (
        <ThemeEditor
          config={config}
          onSave={handleSaveTheme}
          onCancel={() => { setShowThemeEditor(false); setPreviewTheme(null) }}
          onPreview={handleThemePreview}
        />
      )}

      {showProjectSettings && (
        <ProjectSettings
          config={config}
          accentColor={accentColor}
          projectName={folderName}
          onSave={handleSaveProjectSettings}
          onCancel={() => setShowProjectSettings(false)}
        />
      )}

      {showProjectSwitcher && (
        <ProjectSwitcher
          accentColor={accentColor}
          onCancel={() => setShowProjectSwitcher(false)}
        />
      )}

      {showHelp && (
        <HelpModal
          accentColor={accentColor}
          onClose={() => setShowHelp(false)}
        />
      )}

      {showCliInstall && (
        <CliInstallModal
          accentColor={accentColor}
          cliStatus={cliStatus}
          onClose={() => setShowCliInstall(false)}
          onInstalled={() => {
            setShowCliInstall(false)
            setShowCliPrompt(false)
            refreshCliStatus()
          }}
          onStatusChange={refreshCliStatus}
        />
      )}

      {showRemoteAccess && (
        <RemoteAccessModal
          accentColor={accentColor}
          onClose={() => setShowRemoteAccess(false)}
        />
      )}

      {showGlobalSearch && (
        <GlobalSearch
          sessions={sessions}
          accentColor={accentColor}
          projectPath={projectPath}
          scope={globalSearchScope}
          onReveal={handleRevealMatch}
          onClose={() => setShowGlobalSearch(false)}
        />
      )}

      {showHistory && (
        <ProjectHistory
          projectPath={projectPath}
          accentColor={accentColor}
          openConversationIds={sessions.map((s) => s.conversationId).filter(Boolean) as string[]}
          onReopen={handleReopenHistorical}
          onClose={() => setShowHistory(false)}
        />
      )}

      {showWelcome && (
        <ProjectSwitcher
          accentColor={accentColor}
          welcomeMode
          onCancel={() => setShowWelcome(false)}
        />
      )}
    </div>
  )
}

export default App
