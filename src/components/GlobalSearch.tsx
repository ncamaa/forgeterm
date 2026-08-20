import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react'
import type { Session } from '../store/sessionStore'
import type { TranscriptMatch } from '../../shared/types'
import { searchAllTerminals, getSessionLastOutput } from './TerminalView'

interface GlobalSearchProps {
  sessions: Session[]
  accentColor: string
  projectPath: string
  /** 'all' searches every open session; a session id scopes to that one (Cmd+F on a Claude session). */
  scope: 'all' | string
  onReveal: (sessionId: string, line: number, col: number, length: number) => void
  onClose: () => void
}

const MAX_PER_SESSION = 8

// A match in a live terminal buffer (non-Claude session) - reveal-able in place.
interface TerminalMatch {
  source: 'terminal'
  line: number
  col: number
  preview: string
}

// A match in a Claude transcript on disk - shown inline (Claude can't be scrolled).
interface DiskMatch extends TranscriptMatch {
  source: 'transcript'
}

type Match = TerminalMatch | DiskMatch

interface Group {
  sessionId: string
  sessionName: string
  isClaude: boolean
  matches: Match[]
  total: number
  recency: number
}

interface FlatRow {
  sessionId: string
  match: Match
}

const ROLE_LABEL: Record<string, string> = {
  text: 'message',
  thinking: 'thinking',
  tool_use: 'tool',
  tool_result: 'output',
}

// Highlight length for a row: transcript matches carry their own (a multi-term
// query highlights the term that matched, not the whole query); terminal matches
// always matched the query verbatim.
function matchLen(m: Match, query: string): number {
  return m.source === 'transcript' ? m.matchLength : query.length
}

// Render a one-line preview windowed around the match, with the matched term
// highlighted. `col` is an index into `preview`.
function Snippet({ preview, col, length }: { preview: string; col: number; length: number }) {
  const winStart = Math.max(0, col - 28)
  let before = preview.slice(winStart, col)
  if (winStart === 0) before = before.replace(/^\s+/, '')
  const lead = winStart > 0 ? '…' : ''
  const match = preview.slice(col, col + length)
  const after = preview.slice(col + length, col + length + 160)
  return (
    <span className="global-search-snippet">
      {lead}{before}<mark className="global-search-match">{match}</mark>{after}
    </span>
  )
}

// Full (un-windowed) preview with the match highlighted - shown when a transcript
// row is expanded, since we can't scroll Claude's own viewport to the match.
function FullSnippet({ preview, col, length }: { preview: string; col: number; length: number }) {
  return (
    <span>
      {preview.slice(0, col)}
      <mark className="global-search-match">{preview.slice(col, col + length)}</mark>
      {preview.slice(col + length)}
    </span>
  )
}

export function GlobalSearch({ sessions, accentColor, projectPath, scope, onReveal, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  const targets = scope === 'all' ? sessions : sessions.filter((s) => s.id === scope)
  const scopedName = scope === 'all' ? null : targets[0]?.name

  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounce: terminal scan is synchronous, transcript search hits disk in main.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 130)
    return () => clearTimeout(t)
  }, [query])

  // Run the (async) search whenever the debounced query or session set changes.
  // A request token guards against out-of-order transcript responses.
  useEffect(() => {
    if (!debounced) { setGroups([]); return }
    let cancelled = false
    const order = new Map(sessions.map((s, i) => [s.id, i]))
    const nameOf = new Map(sessions.map((s) => [s.id, s.name]))
    const claudeIds = new Set(targets.filter((s) => s.conversationId).map((s) => s.id))
    const inScope = new Set(targets.map((s) => s.id))

    // 1. Terminal-buffer matches for non-Claude in-scope sessions (synchronous).
    const termGroups: Group[] = []
    for (const [sessionId, matches] of searchAllTerminals(debounced)) {
      if (!inScope.has(sessionId) || claudeIds.has(sessionId)) continue
      termGroups.push({
        sessionId,
        sessionName: nameOf.get(sessionId) ?? 'session',
        isClaude: false,
        matches: matches.slice(0, MAX_PER_SESSION).map((m) => ({ source: 'terminal', line: m.line, col: m.col, preview: m.preview })),
        total: matches.length,
        recency: getSessionLastOutput(sessionId),
      })
    }

    // 2. Transcript matches for Claude sessions (async, on disk in main process).
    const transcriptTargets = targets
      .filter((s) => s.conversationId)
      .map((s) => ({ id: s.id, conversationId: s.conversationId as string, projectPath }))

    const finish = (diskGroups: Group[]) => {
      if (cancelled) return
      const merged = [...termGroups, ...diskGroups]
      merged.sort((a, b) => {
        if (b.recency !== a.recency) return b.recency - a.recency
        return (order.get(a.sessionId) ?? 0) - (order.get(b.sessionId) ?? 0)
      })
      setGroups(merged)
    }

    if (transcriptTargets.length === 0) {
      finish([])
    } else {
      window.forgeterm.searchTranscripts(transcriptTargets, debounced, MAX_PER_SESSION).then((results) => {
        const diskGroups: Group[] = results.map((r) => ({
          sessionId: r.id,
          sessionName: nameOf.get(r.id) ?? 'session',
          isClaude: true,
          matches: r.matches.map((m) => ({ source: 'transcript' as const, ...m })),
          total: r.matches.length,
          recency: Math.max(getSessionLastOutput(r.id), ...r.matches.map((m) => m.timestamp ?? 0)),
        }))
        finish(diskGroups)
      }).catch(() => finish([]))
    }

    return () => { cancelled = true }
  }, [debounced, sessions, scope, projectPath])

  const flat: FlatRow[] = []
  for (const g of groups) for (const m of g.matches) flat.push({ sessionId: g.sessionId, match: m })

  useEffect(() => { setSelected(0) }, [flat.length])
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }) }, [selected])

  const rowKey = (sessionId: string, m: Match) =>
    m.source === 'terminal' ? `${sessionId}:t:${m.line}:${m.col}` : `${sessionId}:c:${m.msgIndex}:${m.col}`

  const activateRow = useCallback((row: FlatRow) => {
    if (row.match.source === 'terminal') {
      onReveal(row.sessionId, row.match.line, row.match.col, debounced.length)
    } else {
      // Transcript match: toggle inline expansion (no terminal to scroll to).
      const key = rowKey(row.sessionId, row.match)
      setExpanded((prev) => {
        const next = new Set(prev)
        next.has(key) ? next.delete(key) : next.add(key)
        return next
      })
    }
  }, [onReveal, debounced])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, flat.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = flat[selected]
      if (row) activateRow(row)
    }
  }, [flat, selected, activateRow, onClose])

  // Prefix-sum offsets so each rendered match knows its flat-list index.
  const offsets: number[] = []
  {
    let acc = 0
    for (const g of groups) { offsets.push(acc); acc += g.matches.length }
  }

  return (
    <div className="global-search-overlay" onClick={onClose}>
      <div className="global-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="global-search-input-row">
          <svg className="global-search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
          <input
            ref={inputRef}
            className="global-search-input"
            type="text"
            placeholder={scopedName ? `Search “${scopedName}”…` : 'Search all open sessions…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="global-search-kbd">esc</kbd>
        </div>

        <div className="global-search-results">
          {!debounced && (
            <div className="global-search-empty">
              {scopedName
                ? `Search the full conversation of “${scopedName}”.`
                : 'Search every open session - full Claude history, plus other shells’ scrollback.'}
            </div>
          )}
          {debounced && flat.length === 0 && (
            <div className="global-search-empty">No matches for &ldquo;{debounced}&rdquo;.</div>
          )}
          {groups.map((g, gi) => (
            <div className="global-search-group" key={g.sessionId}>
              <div className="global-search-group-header">
                <span className="global-search-group-name">{g.sessionName}</span>
                {g.isClaude && <span className="global-search-group-tag">transcript</span>}
                <span className="global-search-group-count">{g.total}{g.total >= MAX_PER_SESSION ? '+' : ''} match{g.total === 1 ? '' : 'es'}</span>
              </div>
              {g.matches.map((m, j) => {
                const idx = offsets[gi] + j
                const isSel = idx === selected
                const key = rowKey(g.sessionId, m)
                const isExpanded = m.source === 'transcript' && expanded.has(key)
                return (
                  <button
                    key={key}
                    ref={isSel ? selectedRef : undefined}
                    className={`global-search-result${isSel ? ' selected' : ''}${m.source === 'transcript' ? ' transcript' : ''}`}
                    style={isSel ? { borderColor: accentColor } : undefined}
                    onClick={() => activateRow({ sessionId: g.sessionId, match: m })}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    {m.source === 'transcript' && (
                      <span className={`global-search-roletag role-${m.role} kind-${m.kind}`}>
                        {m.role === 'user' ? 'you' : ROLE_LABEL[m.kind] ?? 'claude'}
                      </span>
                    )}
                    {isExpanded
                      ? <span className="global-search-snippet expanded"><FullSnippet preview={m.preview} col={m.col} length={matchLen(m, debounced)} /></span>
                      : <Snippet preview={m.preview} col={m.col} length={matchLen(m, debounced)} />}
                  </button>
                )
              })}
              {g.total > g.matches.length && (
                <div className="global-search-more">+{g.total - g.matches.length} more in this session</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
