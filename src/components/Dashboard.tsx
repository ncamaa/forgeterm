import { useEffect, useMemo, useState, useCallback } from 'react'
import type { DashboardState, DashboardProject, DashboardSession } from '../../shared/types'
import { SessionSearch } from './SessionSearch'

/**
 * The Control Panel: every project and every live session on one board, so a
 * dozen agents running in parallel can be triaged without hunting windows.
 *
 * Rows are ordered by how much they want from you (waiting -> working -> idle),
 * because the whole point is to answer "who needs me?" at a glance.
 */

type Filter = 'all' | 'waiting' | 'working'
type View = 'list' | 'cards'

/** Sort weight for a session: lower sorts first. */
function sessionRank(s: DashboardSession): number {
  if (s.activityStatus === 'unread') return 0
  if (s.activityStatus === 'working') return 1
  if (!s.running) return 3
  return 2
}

/** A project inherits the urgency of its most urgent session. */
function projectRank(p: DashboardProject): number {
  if (!p.isOpen) return 5
  if (p.sessions.length === 0) return 4
  return Math.min(...p.sessions.map(sessionRank))
}

function countBy(projects: DashboardProject[], pred: (s: DashboardSession) => boolean): number {
  return projects.reduce((n, p) => n + p.sessions.filter(pred).length, 0)
}

// Compact elapsed time: "12s", "4m", "3h", "2d".
function elapsed(since: number, now: number): string {
  const secs = Math.max(0, Math.round((now - since) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function StatusDot({ session }: { session: DashboardSession }) {
  const status = !session.running ? 'stopped' : session.activityStatus
  const title =
    status === 'working' ? 'Working' :
    status === 'unread' ? 'Waiting on you' :
    status === 'stopped' ? 'Stopped' : 'Idle'
  return <span className={`cp-dot cp-dot-${status}`} title={title} />
}

function SessionRow({
  project,
  session,
  now,
  onFocus,
  onAction,
}: {
  project: DashboardProject
  session: DashboardSession
  now: number
  onFocus: (project: DashboardProject, session: DashboardSession) => void
  onAction: (project: DashboardProject, session: DashboardSession, action: 'stop' | 'restart') => void
}) {
  const waiting = session.running && session.activityStatus === 'unread'
  const detail = sessionDetail(session)

  return (
    <div
      className={`cp-row cp-session-row${waiting ? ' waiting' : ''}${session.isActive ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onFocus(project, session)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(project, session) } }}
      title="Jump to this session"
    >
      <span className="cp-cell cp-cell-status"><StatusDot session={session} /></span>
      <span className="cp-cell cp-cell-name">
        <span className="cp-session-name">{session.name}</span>
        {session.conversationId && <span className="cp-tag cp-tag-claude">Claude</span>}
        {!session.running && <span className="cp-tag cp-tag-stopped">stopped</span>}
      </span>
      <span className="cp-cell cp-cell-detail" title={detail || undefined}>{detail}</span>
      <span
        className="cp-cell cp-cell-when"
        title={session.statusChangedAt ? absoluteTime(session.statusChangedAt) : undefined}
      >
        {session.statusChangedAt ? elapsed(session.statusChangedAt, now) : ''}
      </span>
      <span className="cp-cell cp-cell-context">
        {session.contextPercent != null && (
          <span className={`cp-context${session.contextPercent >= 80 ? ' high' : ''}`}>{session.contextPercent}%</span>
        )}
      </span>
      <span className="cp-cell cp-cell-actions">
        {session.running ? (
          <button
            className="cp-icon-btn"
            title="Stop this session"
            onClick={(e) => { e.stopPropagation(); onAction(project, session, 'stop') }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /></svg>
          </button>
        ) : (
          <button
            className="cp-icon-btn"
            title="Restart this session"
            onClick={(e) => { e.stopPropagation(); onAction(project, session, 'restart') }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z" /></svg>
          </button>
        )}
      </span>
    </div>
  )
}

/** The one-line "what is this session doing" text, shared by both views. */
function sessionDetail(session: DashboardSession): string {
  if (session.running && session.activityStatus === 'unread') {
    return session.attentionMessage ?? session.info?.actionItem ?? 'Waiting for your response'
  }
  return session.info?.lastAction ?? session.info?.title ?? session.info?.summary ?? ''
}

function ProjectCard({
  project,
  now,
  onFocusProject,
  onFocusSession,
  onSessionAction,
  onNewSession,
  onCloseProject,
}: {
  project: DashboardProject
  now: number
  onFocusProject: (p: DashboardProject) => void
  onFocusSession: (p: DashboardProject, s: DashboardSession) => void
  onSessionAction: (p: DashboardProject, s: DashboardSession, action: 'stop' | 'restart') => void
  onNewSession: (p: DashboardProject) => void
  onCloseProject: (p: DashboardProject) => void
}) {
  const waiting = project.sessions.filter((s) => s.running && s.activityStatus === 'unread').length
  const working = project.sessions.filter((s) => s.running && s.activityStatus === 'working').length
  const sorted = [...project.sessions].sort(
    (a, b) => sessionRank(a) - sessionRank(b) || (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0),
  )

  return (
    <div className={`cp-card${waiting > 0 ? ' has-waiting' : ''}`}>
      <div className="cp-card-head">
        <button
          className="cp-card-title"
          style={project.accentColor ? { color: project.accentColor } : undefined}
          onClick={() => onFocusProject(project)}
          title={project.isOpen ? `Focus ${project.name}` : `Open ${project.name}`}
        >
          {project.emoji && <span className="cp-project-emoji">{project.emoji}</span>}
          <span className="cp-card-name">{project.name}</span>
        </button>
        <span className="cp-card-actions">
          <button
            className="cp-icon-btn"
            title={`New Claude session in ${project.name}`}
            onClick={() => onNewSession(project)}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          {project.isOpen && (
            <button
              className="cp-icon-btn"
              title={`Close the ${project.name} window`}
              onClick={() => onCloseProject(project)}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </span>
      </div>

      <div className="cp-card-meta">
        {project.workspace && <span className="cp-tag cp-tag-ws">{project.workspace}</span>}
        {waiting > 0 && <span className="cp-pill cp-pill-waiting">{waiting} waiting</span>}
        {working > 0 && <span className="cp-pill cp-pill-working">{working} working</span>}
        {project.isOpen && waiting === 0 && working === 0 && (
          <span className="cp-muted">{project.sessions.length || 'no'} session{project.sessions.length === 1 ? '' : 's'}</span>
        )}
        {!project.isOpen && <span className="cp-muted">click the name to open</span>}
      </div>

      {sorted.length > 0 && (
        <div className="cp-card-sessions">
          {sorted.map((s) => {
            const isWaiting = s.running && s.activityStatus === 'unread'
            const detail = sessionDetail(s)
            return (
              <div
                key={s.id}
                className={`cp-card-session${isWaiting ? ' waiting' : ''}${s.isActive ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => onFocusSession(project, s)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusSession(project, s) } }}
                title="Jump to this session"
              >
                <div className="cp-card-session-top">
                  <StatusDot session={s} />
                  <span className="cp-session-name">{s.name}</span>
                  {!s.running && <span className="cp-tag cp-tag-stopped">stopped</span>}
                  <span className="cp-card-session-right">
                    {s.contextPercent != null && (
                      <span className={`cp-context${s.contextPercent >= 80 ? ' high' : ''}`}>{s.contextPercent}%</span>
                    )}
                    <span
                      className="cp-cell-when"
                      title={s.statusChangedAt ? absoluteTime(s.statusChangedAt) : undefined}
                    >
                      {s.statusChangedAt ? elapsed(s.statusChangedAt, now) : ''}
                    </span>
                    <button
                      className="cp-icon-btn"
                      title={s.running ? 'Stop this session' : 'Restart this session'}
                      onClick={(e) => { e.stopPropagation(); onSessionAction(project, s, s.running ? 'stop' : 'restart') }}
                    >
                      {s.running
                        ? <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /></svg>
                        : <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z" /></svg>}
                    </button>
                  </span>
                </div>
                {detail && <div className="cp-card-session-detail" title={detail}>{detail}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ProjectGroup({
  project,
  now,
  collapsed,
  onToggle,
  onFocusProject,
  onFocusSession,
  onSessionAction,
  onNewSession,
  onCloseProject,
}: {
  project: DashboardProject
  now: number
  collapsed: boolean
  onToggle: (path: string) => void
  onFocusProject: (p: DashboardProject) => void
  onFocusSession: (p: DashboardProject, s: DashboardSession) => void
  onSessionAction: (p: DashboardProject, s: DashboardSession, action: 'stop' | 'restart') => void
  onNewSession: (p: DashboardProject) => void
  onCloseProject: (p: DashboardProject) => void
}) {
  const waiting = project.sessions.filter((s) => s.running && s.activityStatus === 'unread').length
  const working = project.sessions.filter((s) => s.running && s.activityStatus === 'working').length
  const sorted = [...project.sessions].sort(
    (a, b) => sessionRank(a) - sessionRank(b) || (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0),
  )

  return (
    <div className={`cp-group${waiting > 0 ? ' has-waiting' : ''}`}>
      <div
        className="cp-row cp-project-row"
        role="button"
        tabIndex={0}
        onClick={() => onToggle(project.path)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(project.path) } }}
      >
        <span className="cp-cell cp-cell-status">
          <span className={`cp-caret${collapsed ? '' : ' open'}`}>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 3l6 5-6 5" />
            </svg>
          </span>
        </span>
        <span className="cp-cell cp-cell-name">
          {project.emoji && <span className="cp-project-emoji">{project.emoji}</span>}
          <button
            className="cp-project-name"
            style={project.accentColor ? { color: project.accentColor } : undefined}
            onClick={(e) => { e.stopPropagation(); onFocusProject(project) }}
            title={project.isOpen ? `Focus ${project.name}` : `Open ${project.name}`}
          >
            {project.name}
          </button>
          {project.workspace && <span className="cp-tag cp-tag-ws">{project.workspace}</span>}
          {!project.isOpen && <span className="cp-tag cp-tag-closed">closed</span>}
        </span>
        <span className="cp-cell cp-cell-detail cp-project-summary">
          {waiting > 0 && <span className="cp-pill cp-pill-waiting">{waiting} waiting</span>}
          {working > 0 && <span className="cp-pill cp-pill-working">{working} working</span>}
          {project.isOpen && waiting === 0 && working === 0 && (
            <span className="cp-muted">{project.sessions.length || 'no'} session{project.sessions.length === 1 ? '' : 's'}</span>
          )}
          {!project.isOpen && <span className="cp-muted">click to open</span>}
        </span>
        <span className="cp-cell cp-cell-when">
          {!project.isOpen && project.lastOpened ? elapsed(project.lastOpened, now) : ''}
        </span>
        <span className="cp-cell cp-cell-context" />
        <span className="cp-cell cp-cell-actions">
          <button
            className="cp-icon-btn"
            title={`New Claude session in ${project.name}`}
            onClick={(e) => { e.stopPropagation(); onNewSession(project) }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          {project.isOpen && (
            <button
              className="cp-icon-btn"
              title={`Close the ${project.name} window`}
              onClick={(e) => { e.stopPropagation(); onCloseProject(project) }}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </span>
      </div>

      {!collapsed && sorted.map((s) => (
        <SessionRow
          key={s.id}
          project={project}
          session={s}
          now={now}
          onFocus={onFocusSession}
          onAction={onSessionAction}
        />
      ))}
    </div>
  )
}

export function Dashboard() {
  const [state, setState] = useState<DashboardState | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [showClosed, setShowClosed] = useState(false)
  const [view, setView] = useState<View>('list')
  // Ticks the relative times forward between pushes from main.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    window.forgeterm.getDashboardState().then(setState)
    return window.forgeterm.onDashboardStateChanged(setState)
  }, [])

  useEffect(() => {
    window.forgeterm.getUiPrefs().then((p) => { if (p.dashboardView) setView(p.dashboardView) })
  }, [])

  const changeView = useCallback((next: View) => {
    setView(next)
    window.forgeterm.setUiPrefs({ dashboardView: next })
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
      if (e.key === 'Escape') {
        setShowSearch(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }, [])

  const focusProject = useCallback((p: DashboardProject) => {
    window.forgeterm.openProject(p.path)
  }, [])

  const focusSession = useCallback((p: DashboardProject, s: DashboardSession) => {
    window.forgeterm.focusSessionInProject(p.path, s.id)
  }, [])

  const sessionAction = useCallback((p: DashboardProject, s: DashboardSession, action: 'stop' | 'restart') => {
    window.forgeterm.sessionAction(p.path, s.id, action)
  }, [])

  const newSession = useCallback((p: DashboardProject) => {
    window.forgeterm.newSessionInProject(p.path)
  }, [])

  const closeProject = useCallback((p: DashboardProject) => {
    window.forgeterm.closeProjectWindow(p.path)
  }, [])

  // Flatten workspaces + standalone into one project list; the workspace name
  // rides along as a tag, so the board stays a single ordered table.
  const allProjects = useMemo<DashboardProject[]>(() => {
    if (!state) return []
    const out: DashboardProject[] = []
    for (const ws of state.workspaces) out.push(...ws.projects)
    out.push(...state.standaloneProjects)
    const byPath = new Map<string, DashboardProject>()
    for (const p of out) if (!byPath.has(p.path)) byPath.set(p.path, p)
    return [...byPath.values()]
  }, [state])

  // A collapsed project would hide the very rows a filter just selected, so any
  // active filter or query forces every surviving group open.
  const forceOpen = query.trim() !== '' || filter !== 'all'

  const openProjects = useMemo(() => allProjects.filter((p) => p.isOpen), [allProjects])
  const closedProjects = useMemo(
    () => allProjects.filter((p) => !p.isOpen).sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)),
    [allProjects],
  )

  const waitingCount = countBy(openProjects, (s) => s.running && s.activityStatus === 'unread')
  const workingCount = countBy(openProjects, (s) => s.running && s.activityStatus === 'working')
  const sessionCount = countBy(openProjects, () => true)

  // Filter + search, then order by urgency. A project survives if it still has
  // a matching session (or matches by name itself).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchesSession = (s: DashboardSession) => {
      if (filter === 'waiting' && !(s.running && s.activityStatus === 'unread')) return false
      if (filter === 'working' && !(s.running && s.activityStatus === 'working')) return false
      if (!q) return true
      const hay = [s.name, s.attentionMessage, s.info?.title, s.info?.summary, s.info?.lastAction]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    }
    return openProjects
      .map((p) => ({ ...p, sessions: p.sessions.filter(matchesSession) }))
      .filter((p) => {
        const nameHit = !!q && (p.name.toLowerCase().includes(q) || (p.workspace ?? '').toLowerCase().includes(q))
        if (filter !== 'all' && p.sessions.length === 0) return false
        if (q && p.sessions.length === 0 && !nameHit) return false
        return true
      })
      .sort((a, b) => projectRank(a) - projectRank(b) || a.name.localeCompare(b.name))
  }, [openProjects, filter, query])

  if (!state) return null

  return (
    <div className="cp">
      <div className="cp-titlebar">
        <span className="cp-title">Control Panel</span>
        <div className="cp-summary">
          <button
            className={`cp-chip${filter === 'waiting' ? ' active' : ''}${waitingCount > 0 ? ' urgent' : ''}`}
            onClick={() => setFilter(filter === 'waiting' ? 'all' : 'waiting')}
            title="Show only sessions waiting on you"
          >
            <span className="cp-dot cp-dot-unread" /> {waitingCount} waiting
          </button>
          <button
            className={`cp-chip${filter === 'working' ? ' active' : ''}`}
            onClick={() => setFilter(filter === 'working' ? 'all' : 'working')}
            title="Show only sessions that are working"
          >
            <span className="cp-dot cp-dot-working" /> {workingCount} working
          </button>
          <span className="cp-chip cp-chip-static">{sessionCount} sessions · {openProjects.length} projects</span>
        </div>
        <div className="cp-titlebar-right">
          <div className="cp-viewtoggle" role="group" aria-label="Layout">
            <button
              className={view === 'list' ? 'active' : ''}
              onClick={() => changeView('list')}
              title="List: collapsible rows, densest view"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
              <span>List</span>
            </button>
            <button
              className={view === 'cards' ? 'active' : ''}
              onClick={() => changeView('cards')}
              title="Cards: one tile per project"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
                <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
                <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
                <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
              </svg>
              <span>Cards</span>
            </button>
          </div>
          <input
            className="cp-search"
            type="text"
            placeholder="Filter sessions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="cp-icon-btn" onClick={() => setShowSearch(true)} title="Search past sessions (Cmd+F)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="6.5" cy="6.5" r="5" />
              <path d="M10.5 10.5L15 15" />
            </svg>
          </button>
        </div>
      </div>

      {view === 'list' && <div className="cp-head cp-row">
        <span className="cp-cell cp-cell-status" />
        <span className="cp-cell cp-cell-name">Project / session</span>
        <span className="cp-cell cp-cell-detail">What's happening</span>
        <span className="cp-cell cp-cell-when">For</span>
        <span className="cp-cell cp-cell-context">Ctx</span>
        <span className="cp-cell cp-cell-actions" />
      </div>}

      <div className={`cp-body${view === 'cards' ? ' cards' : ''}`}>
        {visible.length === 0 && (
          <div className="cp-empty">
            {openProjects.length === 0
              ? 'No project windows are open. Open one below to get started.'
              : query || filter !== 'all'
                ? 'Nothing matches this filter.'
                : 'No sessions running.'}
          </div>
        )}

        {view === 'list' ? (
          visible.map((p) => (
            <ProjectGroup
              key={p.path}
              project={p}
              now={now}
              collapsed={!forceOpen && collapsed.has(p.path)}
              onToggle={toggle}
              onFocusProject={focusProject}
              onFocusSession={focusSession}
              onSessionAction={sessionAction}
              onNewSession={newSession}
              onCloseProject={closeProject}
            />
          ))
        ) : (
          <div className="cp-grid">
            {visible.map((p) => (
              <ProjectCard
                key={p.path}
                project={p}
                now={now}
                onFocusProject={focusProject}
                onFocusSession={focusSession}
                onSessionAction={sessionAction}
                onNewSession={newSession}
                onCloseProject={closeProject}
              />
            ))}
          </div>
        )}

        {closedProjects.length > 0 && (
          <div className="cp-closed">
            <button className="cp-closed-toggle" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? '▾' : '▸'} {closedProjects.length} closed project{closedProjects.length === 1 ? '' : 's'}
            </button>
            {showClosed && (view === 'list' ? (
              closedProjects.map((p) => (
                <ProjectGroup
                  key={p.path}
                  project={p}
                  now={now}
                  collapsed
                  onToggle={() => focusProject(p)}
                  onFocusProject={focusProject}
                  onFocusSession={focusSession}
                  onSessionAction={sessionAction}
                  onNewSession={newSession}
                  onCloseProject={closeProject}
                />
              ))
            ) : (
              <div className="cp-grid">
                {closedProjects.map((p) => (
                  <ProjectCard
                    key={p.path}
                    project={p}
                    now={now}
                    onFocusProject={focusProject}
                    onFocusSession={focusSession}
                    onSessionAction={sessionAction}
                    onNewSession={newSession}
                    onCloseProject={closeProject}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {showSearch && (
        <SessionSearch
          workspaces={state.workspaces}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  )
}
