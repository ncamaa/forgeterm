import fs from 'node:fs'
import path from 'node:path'

// Claude Code gives every running session a short peer name (e.g. `forgeterm-96`)
// that other sessions use to refer to it ("Message from @hsp-37"). Each live
// Claude process writes it to `~/.claude*/sessions/<pid>.json` (one dir per
// identity). Files of dead processes linger, so only live pids count.

export interface LiveClaudeSession {
  pid: number
  sessionId?: string
  name: string
  updatedAt: number
  /** Claude config dir the process runs under, e.g. `/Users/me/.claude-hsp`. */
  configDir: string
  /** Working directory Claude was started in (picks the transcript's project folder). */
  cwd?: string
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readLiveClaudeSessions(
  sessionsDirs: string[],
  isAlive: (pid: number) => boolean = pidAlive,
): LiveClaudeSession[] {
  const live: LiveClaudeSession[] = []
  for (const dir of sessionsDirs) {
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f))
    } catch {
      continue
    }
    const configDir = path.dirname(dir)
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
        const pid = Number(data.pid)
        if (!Number.isInteger(pid) || pid <= 0 || typeof data.name !== 'string' || !data.name) continue
        if (!isAlive(pid)) continue
        live.push({
          pid,
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
          name: data.name,
          updatedAt: Number(data.updatedAt) || 0,
          configDir,
          cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
        })
      } catch { /* partial write or not a session file */ }
    }
  }
  return live
}

function newest(list: LiveClaudeSession[]): LiveClaudeSession | undefined {
  return list.reduce<LiveClaudeSession | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined)
}

// Match by Claude conversation id first (no process scan needed).
export function liveSessionByConversation(conversationId: string | undefined, live: LiveClaudeSession[]): LiveClaudeSession | null {
  if (!conversationId) return null
  return newest(live.filter(s => s.sessionId === conversationId)) ?? null
}

// Fallback: a live Claude process somewhere under the session's shell pid. Covers
// the window before the conversation id is known and a stale id after /clear.
export function liveSessionByAncestry(
  shellPid: number,
  live: LiveClaudeSession[],
  childMap: Map<number, number[]>,
): LiveClaudeSession | null {
  const byPid = new Map(live.map(s => [s.pid, s]))
  const found: LiveClaudeSession[] = []
  const stack = [...(childMap.get(shellPid) ?? [])]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const hit = byPid.get(pid)
    if (hit) found.push(hit)
    const kids = childMap.get(pid)
    if (kids) stack.push(...kids)
  }
  return newest(found) ?? null
}
