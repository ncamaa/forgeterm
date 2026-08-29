import { useState, useRef, useEffect, useCallback } from 'react'
import { useSessionStore, type Session } from '../store/sessionStore'
import type { CliStatus } from '../../shared/types'

interface MenuState {
  sessionId: string
  x: number
  y: number
}

interface SidebarProps {
  mode: 'full' | 'compact'
  accentColor: string
  sidebarBackground?: string
  sidebarForeground?: string
  buttonBackground?: string
  width: number
  onWidthChange: (width: number) => void
  onNewSession: () => void
  onQuickSession: () => void
  onQuickTerminal: () => void
  onDuplicateSession: (name: string, command?: string) => void
  onProjectSettings: () => void
  onThemeEditor: () => void
  onHelp: () => void
  onCli: () => void
  onRemote: () => void
  onInfoPanel: (sessionId: string) => void
  cliStatus: CliStatus
  remoteRunning: boolean
}

export function Sidebar({
  mode,
  accentColor,
  sidebarBackground,
  sidebarForeground,
  buttonBackground,
  width,
  onWidthChange,
  onNewSession,
  onQuickSession,
  onQuickTerminal,
  onDuplicateSession,
  onProjectSettings,
  onThemeEditor,
  onHelp,
  onCli,
  onRemote,
  onInfoPanel,
  cliStatus,
  remoteRunning,
}: SidebarProps) {
  const { sessions, activeSessionId, setActive, removeSession, renameRequestId, clearRenameRequest } = useSessionStore()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [repoUrl, setRepoUrl] = useState<string | null | undefined>(undefined)
  const [isDragging, setIsDragging] = useState(false)
  // Quick-add expanded into its Claude / Terminal choices.
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const editInputRef = useRef<HTMLInputElement>(null)

  const btnBg = buttonBackground ?? '#1c2d4d'
  const sidebarFg = sidebarForeground ?? '#8faabe'

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Fetch repo URL once
  useEffect(() => {
    window.forgeterm.getRepoUrl().then(setRepoUrl)
  }, [])

  useEffect(() => {
    const handleClick = () => { setMenu(null); setQuickAddOpen(false) }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setQuickAddOpen(false) }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setMenu({ sessionId, x: e.clientX, y: e.clientY })
  }, [])

  const openDotsMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ sessionId, x: rect.right + 4, y: rect.top })
  }, [])

  const handlePlay = useCallback(async (id: string) => {
    await window.forgeterm.restartSession(id)
    useSessionStore.getState().setRunning(id, true)
  }, [])

  const handleStop = useCallback(async (id: string) => {
    await window.forgeterm.killSession(id)
    useSessionStore.getState().setRunning(id, false)
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    await window.forgeterm.deleteSession(id)
    removeSession(id)
  }, [removeSession])

  const handleDuplicate = useCallback((id: string) => {
    const session = sessions.find((s) => s.id === id)
    if (session) {
      onDuplicateSession(session.name + ' (copy)', session.command)
    }
  }, [sessions, onDuplicateSession])

  const startRename = useCallback((id: string) => {
    const session = sessions.find((s) => s.id === id)
    if (session) {
      setEditingId(session.id)
      setEditName(session.name)
    }
    setMenu(null)
  }, [sessions])

  // Cmd+R (from App) requests inline rename of a session.
  useEffect(() => {
    if (renameRequestId) {
      startRename(renameRequestId)
      clearRenameRequest()
    }
  }, [renameRequestId, startRename, clearRenameRequest])

  const commitRename = useCallback(async () => {
    if (editingId && editName.trim()) {
      await window.forgeterm.renameSession(editingId, editName.trim())
      useSessionStore.getState().renameSession(editingId, editName.trim())
    }
    setEditingId(null)
  }, [editingId, editName])

  const compact = mode === 'compact'

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    const startX = e.clientX
    const startWidth = width

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(140, Math.min(500, startWidth + (ev.clientX - startX)))
      onWidthChange(newWidth)
    }
    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width, onWidthChange])

  return (
    <div
      className={`sidebar ${compact ? 'sidebar-compact' : ''}${isDragging ? ' sidebar-dragging' : ''}`}
      style={{
        ...(!compact ? { width, minWidth: width } : {}),
        ...(sidebarBackground ? { background: sidebarBackground } : {}),
        ...(sidebarForeground ? { color: sidebarForeground } : {}),
      }}
    >
      {!compact && <div className="sidebar-header" style={{ color: sidebarFg }}>Sessions</div>}
      <div className="sidebar-sessions">
        {sessions.map((session: Session) => (
          <div
            key={session.id}
            className={`sidebar-session ${session.id === activeSessionId ? 'active' : ''}`}
            style={
              session.id === activeSessionId
                ? { borderLeftColor: accentColor, background: btnBg }
                : undefined
            }
            onClick={() => setActive(session.id)}
            onContextMenu={(e) => handleContextMenu(e, session.id)}
            title={compact ? session.name : undefined}
          >
            {editingId === session.id && !compact ? (
              <input
                ref={editInputRef}
                className="rename-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                style={{ borderColor: accentColor }}
              />
            ) : (
              <>
                <ContextCircle
                  size={compact ? 12 : 14}
                  percent={session.contextPercent}
                  running={session.running}
                  accentColor={accentColor}
                  activityStatus={session.activityStatus}
                />
                {!compact && (
                  <>
                    <span className="session-name">{session.name}</span>
                    <button
                      className="session-info-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onInfoPanel(session.id)
                      }}
                      title="Session info"
                      style={{ color: accentColor }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="4" r="1.5" />
                        <rect x="6.5" y="7" width="3" height="7" rx="1" />
                      </svg>
                    </button>
                    <div className="session-controls">
                      {session.running ? (
                        <button
                          className="session-ctrl-btn"
                          onClick={(e) => { e.stopPropagation(); handleStop(session.id) }}
                          title="Stop"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="10" height="10" rx="1.5" />
                          </svg>
                        </button>
                      ) : (
                        <button
                          className="session-ctrl-btn accent"
                          onClick={(e) => { e.stopPropagation(); handlePlay(session.id) }}
                          title="Start"
                          style={{ color: accentColor }}
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 2.5l10 5.5-10 5.5V2.5z" />
                          </svg>
                        </button>
                      )}
                      <button
                        className="session-ctrl-btn"
                        onClick={(e) => openDotsMenu(e, session.id)}
                        title="More actions"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="8" cy="3" r="1.5" />
                          <circle cx="8" cy="8" r="1.5" />
                          <circle cx="8" cy="13" r="1.5" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        ))}
        {!compact && (
          quickAddOpen ? (
            <div className="sidebar-quick-choices" onClick={(e) => e.stopPropagation()}>
              <button
                className="sidebar-quick-choice"
                onClick={() => { setQuickAddOpen(false); onQuickSession() }}
                title="New Claude session"
                style={{ borderColor: accentColor + '55', color: accentColor }}
              >
                {/* Starburst = Claude */}
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1l1.5 4.2L13.7 3l-2.2 4.2L16 8l-4.5 1.5L13.7 13l-4.2-2.2L8 15l-1.5-4.2L2.3 13l2.2-4.2L0 8l4.5-1.5L2.3 3l4.2 2.2z" />
                </svg>
                <span>Claude</span>
              </button>
              <button
                className="sidebar-quick-choice"
                onClick={() => { setQuickAddOpen(false); onQuickTerminal() }}
                title="New terminal session"
                style={{ borderColor: accentColor + '55', color: accentColor }}
              >
                {/* Prompt caret = plain shell */}
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                  <path d="M4.5 6.5L7 8.75 4.5 11M8.5 11h3" />
                </svg>
                <span>Terminal</span>
              </button>
            </div>
          ) : (
            <button
              className="sidebar-quick-add"
              onClick={(e) => { e.stopPropagation(); setQuickAddOpen(true) }}
              title="New session"
              style={{ borderColor: accentColor + '30', color: accentColor }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          )
        )}
      </div>
      <div className={`sidebar-actions ${compact ? 'sidebar-actions-compact' : ''}`}>
        <button
          className="sidebar-action-btn"
          onClick={onNewSession}
          title="New Session (Cmd+N)"
          style={{ background: btnBg, color: sidebarFg }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <button
          className="sidebar-action-btn"
          onClick={() => window.forgeterm.openDashboard()}
          title="Control Panel - all projects & sessions (Cmd+Shift+D)"
          style={{ background: btnBg, color: sidebarFg }}
        >
          {/* Stacked rows = the board */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <path d="M2 6h12M6 6v7.5" />
          </svg>
        </button>
        <button
          className="sidebar-action-btn"
          onClick={onProjectSettings}
          title="Project Settings (Cmd+,)"
          style={{ background: btnBg, color: sidebarFg }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          className="sidebar-action-btn"
          onClick={onThemeEditor}
          title="Theme Editor (Cmd+Shift+T)"
          style={{ background: btnBg, color: sidebarFg }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h1a2 2 0 0 0 2-2 10 10 0 0 0-7-13z" />
            <circle cx="8" cy="10" r="1.5" fill="currentColor" />
            <circle cx="12" cy="7" r="1.5" fill="currentColor" />
            <circle cx="16" cy="10" r="1.5" fill="currentColor" />
            <circle cx="9" cy="14" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          className="sidebar-action-btn"
          onClick={onHelp}
          title="Help & Shortcuts (?)"
          style={{ background: btnBg, color: sidebarFg }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
        <button
          className="sidebar-action-btn"
          onClick={onCli}
          title={cliStatus === 'not-setup' ? 'CLI Tool (not installed)' : cliStatus === 'connected' ? 'CLI Tool (connected)' : 'CLI Tool (server error)'}
          style={{ background: btnBg, color: sidebarFg, position: 'relative' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span
            className="cli-status-dot"
            style={{
              background: cliStatus === 'connected' ? '#4ade80' : cliStatus === 'error' ? '#f87171' : '#fb923c',
              boxShadow: `0 0 4px ${cliStatus === 'connected' ? '#4ade8080' : cliStatus === 'error' ? '#f8717180' : '#fb923c80'}`,
            }}
          />
        </button>
        <button
          className="sidebar-action-btn"
          onClick={onRemote}
          title={remoteRunning ? 'Remote Access (active)' : 'Remote Access'}
          style={{ background: btnBg, color: sidebarFg, position: 'relative' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
          {remoteRunning && (
            <span
              className="cli-status-dot"
              style={{
                background: '#4ade80',
                boxShadow: '0 0 4px #4ade8080',
              }}
            />
          )}
        </button>
      </div>

      {!compact && (
        <div
          className="sidebar-resize-handle"
          onMouseDown={handleResizeStart}
        />
      )}

      {menu && (
        <div
          className="context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => {
            const id = menu.sessionId
            setMenu(null)
            handlePlay(id)
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2.5l10 5.5-10 5.5V2.5z" /></svg>
            Restart
          </div>
          <div className="context-menu-item" onClick={() => {
            const id = menu.sessionId
            setMenu(null)
            handleStop(id)
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>
            Kill
          </div>
          <div className="context-menu-item" onClick={() => {
            const id = menu.sessionId
            setMenu(null)
            handleDuplicate(id)
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5.5" y="2" width="8.5" height="8.5" rx="1.5" /><path d="M2 5.5v7a1.5 1.5 0 0 0 1.5 1.5h7" /></svg>
            Duplicate
          </div>
          <div className="context-menu-item" onClick={() => startRename(menu.sessionId)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" /></svg>
            Rename
          </div>
          <div className="context-menu-item" onClick={() => {
            const id = menu.sessionId
            setMenu(null)
            onInfoPanel(id)
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="4" r="1.5" /><rect x="6.5" y="7" width="3" height="7" rx="1" /></svg>
            Info
          </div>
          {repoUrl && (<>
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={() => {
              setMenu(null)
              window.forgeterm.openExternal(repoUrl)
            }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
              Open Repo
            </div>
          </>)}
          <div className="context-menu-divider" />
          <div className="context-menu-item danger" onClick={() => {
            const id = menu.sessionId
            setMenu(null)
            handleDelete(id)
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
            Delete
          </div>
        </div>
      )}

    </div>
  )
}

function ContextCircle({ size, percent, running, accentColor, activityStatus }: {
  size: number
  percent?: number
  running: boolean
  accentColor: string
  activityStatus: 'idle' | 'working' | 'unread'
}) {
  const hasContext = percent != null && percent > 0
  const r = 7 // ring radius within 20x20 viewbox
  const circumference = 2 * Math.PI * r
  const offset = hasContext ? circumference * (1 - percent / 100) : circumference

  // Determine colors
  const isWorking = activityStatus === 'working'
  const isUnread = activityStatus === 'unread'
  const dotColor = isWorking ? '#4ade80' : isUnread ? '#f87171' : accentColor
  const contextColor = hasContext && percent > 80 ? '#f87171' : hasContext && percent > 60 ? '#fbbf24' : accentColor
  const ringColor = isWorking ? '#4ade80' : isUnread ? '#f87171' : contextColor

  const className = `context-circle${isWorking ? ' activity-working' : isUnread ? ' activity-unread' : ''}`

  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} style={{ flexShrink: 0 }}>
      {/* Background ring (always visible when there's context data) */}
      {hasContext && (
        <circle
          cx="10" cy="10" r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth="2.5"
          opacity="0.15"
        />
      )}
      {/* Foreground arc (context usage) - hidden while the working spinner shows */}
      {hasContext && !isWorking && (
        <circle
          cx="10" cy="10" r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth="2.5"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          opacity="0.85"
          style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%', transition: 'stroke-dashoffset 0.6s ease' }}
        />
      )}
      {/* Indeterminate loading spinner while Claude is working */}
      {isWorking && (
        <circle
          className="context-spinner"
          cx="10" cy="10" r={r}
          fill="none"
          stroke="#4ade80"
          strokeWidth="2.5"
          strokeDasharray={`${circumference * 0.25} ${circumference * 0.75}`}
          strokeLinecap="round"
        />
      )}
      {/* Center dot */}
      {running ? (
        <circle cx="10" cy="10" r={hasContext ? 3 : 3.5} fill={dotColor} />
      ) : (
        <circle cx="10" cy="10" r={hasContext ? 3 : 3.5} fill="none" stroke={dotColor} strokeWidth="1.5" opacity="0.4" />
      )}
    </svg>
  )
}

