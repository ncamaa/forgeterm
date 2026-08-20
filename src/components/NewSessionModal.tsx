import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { HistoricalSession, TranscriptMatch } from '../../shared/types'

interface SessionPreset {
  name: string
  command?: string
}

type SortField = 'closed' | 'opened'
type SortDir = 'desc' | 'asc'

interface NewSessionModalProps {
  accentColor: string
  presets: SessionPreset[]
  projectPath: string
  /** Conversation ids currently open - excluded from the recent-sessions list. */
  openConversationIds: string[]
  /** Name prefilled in the form (the default Claude session). */
  defaultName: string
  /** Command prefilled in the form: this project's Claude CLI + permission flags. */
  defaultCommand: string
  /** Field that takes focus on open - Cmd+N lands on the name, Cmd+T on search. */
  initialFocus: 'name' | 'search'
  onSubmit: (name: string, command?: string, addToStartup?: boolean) => void
  onReopen: (session: HistoricalSession) => void
  onCancel: () => void
}

/** Snippets shown per session in search results. */
const MATCHES_PER_SESSION = 3

const ROLE_LABEL: Record<string, string> = {
  text: 'message',
  thinking: 'thinking',
  tool_use: 'tool',
  tool_result: 'output',
}

function formatWhen(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

// One-line preview windowed around the match, with the matched term highlighted.
function Snippet({ preview, col, length }: { preview: string; col: number; length: number }) {
  const winStart = Math.max(0, col - 24)
  let before = preview.slice(winStart, col)
  if (winStart === 0) before = before.replace(/^\s+/, '')
  const lead = winStart > 0 ? '…' : ''
  const match = preview.slice(col, col + length)
  const after = preview.slice(col + length, col + length + 140)
  return (
    <span className="project-history-snippet">
      {lead}{before}<mark className="global-search-match">{match}</mark>{after}
    </span>
  )
}

/** Everything about a session that a name query should match against. */
function metaHaystack(s: HistoricalSession): string {
  return [s.name, s.info?.title, s.info?.summary, s.info?.lastAction, s.command]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

export function NewSessionModal({
  accentColor,
  presets,
  projectPath,
  openConversationIds,
  defaultName,
  defaultCommand,
  initialFocus,
  onSubmit,
  onReopen,
  onCancel,
}: NewSessionModalProps) {
  const [name, setName] = useState(defaultName)
  const [command, setCommand] = useState(defaultCommand)
  const [addToStartup, setAddToStartup] = useState(false)
  const [history, setHistory] = useState<HistoricalSession[]>([])
  const [sortField, setSortField] = useState<SortField>('closed')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [contentMatches, setContentMatches] = useState<Map<string, TranscriptMatch[]>>(new Map())
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (initialFocus === 'search') {
      searchRef.current?.focus()
    } else {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [initialFocus])

  // Stable key so the load effect doesn't re-fire on every parent re-render
  // (openConversationIds is a fresh array reference each render).
  const openKey = openConversationIds.join(',')

  // Load this project's closed sessions. Dedup by conversation (latest per
  // conversationId, else per id) and drop conversations that are currently open.
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    window.forgeterm.getSessionHistory(projectPath).then((sessions) => {
      if (cancelled) return
      const openSet = new Set(openKey ? openKey.split(',') : [])
      const byKey = new Map<string, HistoricalSession>()
      for (const s of sessions) {
        if (s.conversationId && openSet.has(s.conversationId)) continue
        const key = s.conversationId ? `c:${s.conversationId}` : `i:${s.id}`
        const prev = byKey.get(key)
        if (!prev || (s.endedAt ?? s.createdAt) > (prev.endedAt ?? prev.createdAt)) byKey.set(key, s)
      }
      setHistory([...byKey.values()])
    })
    return () => { cancelled = true }
  }, [projectPath, openKey])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed !== debounced) setSearching(true)
    const t = setTimeout(() => setDebounced(trimmed), 180)
    return () => clearTimeout(t)
    // `debounced` is read only to decide whether a search is pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // Content search: every closed Claude conversation's on-disk transcript.
  useEffect(() => {
    if (!debounced) { setContentMatches(new Map()); setSearching(false); return }
    let cancelled = false
    const targets = history
      .filter((s) => s.conversationId)
      .map((s) => ({ id: s.id, conversationId: s.conversationId as string, projectPath }))
    if (targets.length === 0) { setContentMatches(new Map()); setSearching(false); return }
    window.forgeterm.searchTranscripts(targets, debounced, MATCHES_PER_SESSION)
      .then((results) => {
        if (cancelled) return
        setContentMatches(new Map(results.map((r) => [r.id, r.matches])))
        setSearching(false)
      })
      .catch(() => { if (!cancelled) { setContentMatches(new Map()); setSearching(false) } })
    return () => { cancelled = true }
  }, [debounced, history, projectPath])

  // Timestamp the current sort keys on: close time (endedAt) or open time (createdAt).
  const whenOf = useCallback(
    (s: HistoricalSession) => (sortField === 'opened' ? s.createdAt : (s.endedAt ?? s.createdAt)),
    [sortField],
  )

  const sorted = useMemo(() => {
    const arr = [...history].sort((a, b) => whenOf(a) - whenOf(b))
    if (sortDir === 'desc') arr.reverse()
    return arr
  }, [history, sortDir, whenOf])

  // Query terms must ALL be present (in the name/title/summary, or - via the
  // transcript search - somewhere in the conversation). Name hits rank above
  // conversation-only hits; the chosen time sort orders within each group.
  const visible = useMemo(() => {
    if (!debounced) return sorted
    const terms = debounced.toLowerCase().split(/\s+/).filter(Boolean)
    const byName: HistoricalSession[] = []
    const byContent: HistoricalSession[] = []
    for (const s of sorted) {
      const hay = metaHaystack(s)
      if (terms.every((t) => hay.includes(t))) byName.push(s)
      else if (contentMatches.has(s.id)) byContent.push(s)
    }
    return [...byName, ...byContent]
  }, [sorted, debounced, contentMatches])

  useEffect(() => { setSelected(0) }, [debounced, visible.length])
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }) }, [selected, visible])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const cmd = command.trim()
    const sessionName = name.trim() || (cmd ? cmd.split(/\s+/)[0] : 'shell')
    onSubmit(sessionName, cmd || undefined, addToStartup)
  }

  const handlePresetClick = useCallback((preset: SessionPreset) => {
    onSubmit(preset.name, preset.command)
  }, [onSubmit])

  // Arrow keys walk the results; Enter reopens the highlighted one instead of
  // submitting the form (which would create a brand-new session).
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, visible.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      const target = visible[selected]
      if (query.trim() && target) {
        e.preventDefault()
        onReopen(target)
      }
    }
  }, [visible, selected, query, onReopen])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal new-session-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New Session</h3>

        <form className="new-session-form" onSubmit={handleSubmit}>
          <div className="new-session-scroll">
            {history.length > 0 && (
              <div className="session-history-section">
                <div className="session-history-head">
                  <div className="presets-label">Recent sessions</div>
                  <div className="session-sort-controls">
                    <div className="session-sort-group">
                      <button
                        type="button"
                        className={`session-sort-field${sortField === 'closed' ? ' active' : ''}`}
                        onClick={() => setSortField('closed')}
                      >
                        Closed
                      </button>
                      <button
                        type="button"
                        className={`session-sort-field${sortField === 'opened' ? ' active' : ''}`}
                        onClick={() => setSortField('opened')}
                      >
                        Opened
                      </button>
                    </div>
                    <button
                      type="button"
                      className="session-sort-dir"
                      onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                      title={sortDir === 'desc' ? 'Newest first — click for oldest' : 'Oldest first — click for newest'}
                    >
                      {sortDir === 'desc' ? '↓ Newest' : '↑ Oldest'}
                    </button>
                  </div>
                </div>

                <div className="session-history-search">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7" cy="7" r="4.5" />
                    <line x1="10.5" y1="10.5" x2="14" y2="14" />
                  </svg>
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    placeholder="Search by name, or inside the conversation…"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                  />
                  {query && (
                    <button
                      type="button"
                      className="session-history-search-clear"
                      onClick={() => { setQuery(''); searchRef.current?.focus() }}
                      title="Clear search"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  )}
                </div>

                <div className={`session-history-list${debounced ? ' searching' : ''}`}>
                  {visible.length === 0 && (
                    <div className="session-history-empty">
                      {searching ? 'Searching conversations…' : `No recent session matches “${debounced}”.`}
                    </div>
                  )}
                  {visible.map((s, i) => {
                    const matches = contentMatches.get(s.id)
                    const showMatches = !!debounced && !!matches?.length
                    // Extra rows (title / snippets) stack the button vertically.
                    const stacked = showMatches || (!!debounced && !!s.info?.title)
                    const isSel = !!debounced && i === selected
                    return (
                      <button
                        key={s.id}
                        ref={isSel ? selectedRef : undefined}
                        type="button"
                        className={`history-btn${stacked ? ' with-matches' : ''}${isSel ? ' selected' : ''}`}
                        onClick={() => onReopen(s)}
                        onMouseEnter={() => { if (debounced) setSelected(i) }}
                        style={{ borderColor: isSel ? accentColor : accentColor + '44' }}
                      >
                        <span className="history-btn-row">
                          <span className="history-btn-main">
                            <span className="preset-name">{s.name}</span>
                            {s.conversationId && <span className="project-history-claude-tag">Claude</span>}
                          </span>
                          <span className="history-btn-date">
                            {sortField === 'opened' ? 'opened ' : 'closed '}{formatWhen(whenOf(s))}
                          </span>
                        </span>
                        {s.info?.title && debounced && (
                          <span className="history-btn-info">{s.info.title}</span>
                        )}
                        {showMatches && (
                          <span className="project-history-matches">
                            {matches!.map((m, j) => (
                              <span key={j} className="project-history-match-row">
                                <span className={`global-search-roletag role-${m.role} kind-${m.kind}`}>
                                  {m.role === 'user' ? 'you' : ROLE_LABEL[m.kind] ?? 'claude'}
                                </span>
                                <Snippet preview={m.preview} col={m.col} length={m.matchLength} />
                              </span>
                            ))}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                <div className="presets-divider">
                  <span>{presets.length > 0 ? 'or from project config' : 'or start new'}</span>
                </div>
              </div>
            )}

            {presets.length > 0 && (
              <div className="session-presets">
                <div className="presets-label">From project config</div>
                <div className="presets-list">
                  {presets.map((preset, i) => (
                    <button
                      key={i}
                      type="button"
                      className="preset-btn"
                      onClick={() => handlePresetClick(preset)}
                      style={{ borderColor: accentColor + '44' }}
                    >
                      <span className="preset-name">{preset.name}</span>
                      {preset.command && (
                        <span className="preset-command">{preset.command}</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="presets-divider">
                  <span>or create custom</span>
                </div>
              </div>
            )}

            <div className="form-field">
              <label>Name</label>
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="shell"
              />
            </div>
            <div className="form-field">
              <label>Command (optional)</label>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. npm run dev"
              />
            </div>
            <label className="add-to-startup-toggle">
              <input
                type="checkbox"
                checked={addToStartup}
                onChange={(e) => setAddToStartup(e.target.checked)}
              />
              <span>Add to project startup sessions</span>
            </label>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-create"
              style={{ backgroundColor: accentColor }}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
