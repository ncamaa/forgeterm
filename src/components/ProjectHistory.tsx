import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { HistoricalSession, TranscriptMatch } from '../../shared/types'

interface ProjectHistoryProps {
  projectPath: string
  accentColor: string
  /** Conversation ids that are currently open - excluded from the "closed" list. */
  openConversationIds: string[]
  onReopen: (session: HistoricalSession) => void
  onClose: () => void
}

function formatDate(ts: number): string {
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

const ROLE_LABEL: Record<string, string> = {
  text: 'message',
  thinking: 'thinking',
  tool_use: 'tool',
  tool_result: 'output',
}

// One-line preview windowed around the match.
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

export function ProjectHistory({ projectPath, accentColor, openConversationIds, onReopen, onClose }: ProjectHistoryProps) {
  const [all, setAll] = useState<HistoricalSession[]>([])
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [contentMatches, setContentMatches] = useState<Map<string, TranscriptMatch[]>>(new Map())
  const inputRef = useRef<HTMLInputElement>(null)

  // Stable key so the load effect doesn't re-fire on every parent re-render
  // (openConversationIds is a fresh array reference each render).
  const openKey = openConversationIds.join(',')
  const openSet = useMemo(() => new Set(openKey ? openKey.split(',') : []), [openKey])

  useEffect(() => { inputRef.current?.focus() }, [])

  // Load this project's history. Dedup by conversation (latest per conversationId,
  // else per id), drop currently-open conversations, sort newest first.
  useEffect(() => {
    if (!projectPath) return
    window.forgeterm.getSessionHistory(projectPath).then((sessions) => {
      const byKey = new Map<string, HistoricalSession>()
      for (const s of sessions) {
        if (s.conversationId && openSet.has(s.conversationId)) continue
        const key = s.conversationId ? `c:${s.conversationId}` : `i:${s.id}`
        const prev = byKey.get(key)
        if (!prev || (s.endedAt ?? s.createdAt) > (prev.endedAt ?? prev.createdAt)) byKey.set(key, s)
      }
      setAll([...byKey.values()].sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt)))
    })
  }, [projectPath, openSet])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])

  // Content search across the historical transcripts (Claude sessions only).
  useEffect(() => {
    if (!debounced) { setContentMatches(new Map()); return }
    let cancelled = false
    const targets = all
      .filter((s) => s.conversationId)
      .map((s) => ({ id: s.id, conversationId: s.conversationId as string, projectPath }))
    if (targets.length === 0) { setContentMatches(new Map()); return }
    window.forgeterm.searchTranscripts(targets, debounced, 4).then((results) => {
      if (cancelled) return
      setContentMatches(new Map(results.map((r) => [r.id, r.matches])))
    }).catch(() => { if (!cancelled) setContentMatches(new Map()) })
    return () => { cancelled = true }
  }, [debounced, all, projectPath])

  // When searching, show sessions matching by name/title OR by transcript content.
  const visible = useMemo(() => {
    if (!debounced) return all
    const q = debounced.toLowerCase()
    return all.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.info?.title ?? '').toLowerCase().includes(q) ||
      contentMatches.has(s.id))
  }, [all, debounced, contentMatches])

  const handleReopen = useCallback((s: HistoricalSession, e: React.MouseEvent) => {
    e.stopPropagation()
    onReopen(s)
  }, [onReopen])

  return (
    <div className="session-search-overlay" onClick={onClose}>
      <div className="session-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="session-search-header">
          <div className="session-search-title">Session History · {projectPath.split('/').pop()}</div>
          <button className="session-search-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="session-search-filters">
          <input
            ref={inputRef}
            className="session-search-input"
            type="text"
            placeholder="Filter by name, or search inside closed conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
          />
        </div>

        <div className="session-search-results">
          {visible.length === 0 && (
            <div className="session-search-empty">
              {debounced ? `No past sessions match “${debounced}”.` : 'No closed sessions yet for this project.'}
            </div>
          )}
          {visible.map((s) => {
            const matches = contentMatches.get(s.id)
            return (
              <div key={s.id} className="session-search-result project-history-result">
                <div className="session-search-result-header">
                  <span className="session-search-result-name">{s.name}</span>
                  <span className="session-search-result-date">{formatDate(s.endedAt ?? s.createdAt)}</span>
                </div>
                <div className="session-search-result-meta">
                  {s.conversationId && <span className="project-history-claude-tag">Claude</span>}
                  {s.info?.title && <span className="session-search-result-info">{s.info.title}</span>}
                </div>
                {matches && matches.length > 0 && (
                  <div className="project-history-matches">
                    {matches.map((m, i) => (
                      <div key={i} className="project-history-match-row">
                        <span className={`global-search-roletag role-${m.role} kind-${m.kind}`}>
                          {m.role === 'user' ? 'you' : ROLE_LABEL[m.kind] ?? 'claude'}
                        </span>
                        <Snippet preview={m.preview} col={m.col} length={m.matchLength} />
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className="project-history-reopen"
                  style={{ borderColor: accentColor, color: accentColor }}
                  onClick={(e) => handleReopen(s, e)}
                >
                  {s.conversationId ? 'Resume' : 'Reopen'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
