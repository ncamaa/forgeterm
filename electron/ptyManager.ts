import * as pty from 'node-pty'
import os from 'node:os'
import type { SessionContext } from '../shared/types'

interface PtySession {
  id: string
  name: string
  pty: pty.IPty | null
  command?: string
  cwd: string
  running: boolean
  info?: SessionContext
  conversationId?: string
  createdAt: number
  // True once the user renamed this session manually; blocks CLI/Claude renames.
  nameLocked?: boolean
  // Last size the renderer reported, kept even while the PTY is stopped so a
  // restart spawns at the terminal's real size instead of 80x24. xterm only
  // reports a size when its container changes, so nothing else would correct it.
  cols?: number
  rows?: number
}

interface CreateSessionOptions {
  name: string
  command?: string
  cwd: string
  idle?: boolean
  nameLocked?: boolean
  socketPath?: string
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

export type DataListener = (id: string, data: string) => void
export type ExitListener = (id: string, exitCode: number) => void

// PTY output is coalesced per session before it reaches the renderer: one IPC
// message per frame instead of one per chunk. Large bursts flush early.
const DATA_BATCH_MS = 16
const DATA_BATCH_MAX = 64 * 1024

export class PtyManager {
  private sessions = new Map<string, PtySession>()
  private nextId = 1
  private dataCallbacks = new Map<string, (id: string, data: string) => void>()
  private exitCallbacks = new Map<string, (id: string, exitCode: number) => void>()
  private extraDataListeners = new Map<string, Set<DataListener>>()
  private extraExitListeners = new Map<string, Set<ExitListener>>()
  private pendingData = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> }>()
  private socketPath?: string

  private emitData(id: string, data: string) {
    const pending = this.pendingData.get(id)
    if (pending) {
      pending.data += data
      if (pending.data.length >= DATA_BATCH_MAX) this.flush(id)
      return
    }
    if (data.length >= DATA_BATCH_MAX) {
      this.dataCallbacks.get(id)?.(id, data)
      return
    }
    this.pendingData.set(id, { data, timer: setTimeout(() => this.flush(id), DATA_BATCH_MS) })
  }

  /** Sends any coalesced output for this session now. Call before anything that must arrive after it. */
  flush(id: string) {
    const pending = this.pendingData.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingData.delete(id)
    this.dataCallbacks.get(id)?.(id, pending.data)
  }

  createSession(options: CreateSessionOptions): string {
    const id = `session-${this.nextId++}`

    if (options.socketPath) this.socketPath = options.socketPath

    this.dataCallbacks.set(id, options.onData)
    this.exitCallbacks.set(id, options.onExit)

    if (options.idle) {
      this.sessions.set(id, {
        id,
        name: options.name,
        pty: null,
        command: options.command,
        cwd: options.cwd,
        running: false,
        createdAt: Date.now(),
        nameLocked: options.nameLocked,
      })
      return id
    }

    const extraEnv: Record<string, string> = {
      FORGETERM: '1',
      FORGETERM_PROJECT_PATH: options.cwd,
      FORGETERM_SESSION_ID: id,
      FORGETERM_SESSION_NAME: options.name,
    }
    if (this.socketPath) extraEnv.FORGETERM_SOCKET = this.socketPath

    const proc = this.spawnShell(options.cwd, extraEnv)

    proc.onData((data) => {
      this.emitData(id, data)
      this.extraDataListeners.get(id)?.forEach(cb => cb(id, data))
    })

    proc.onExit(({ exitCode }) => {
      this.flush(id)
      const session = this.sessions.get(id)
      if (session) {
        session.running = false
        session.pty = null
      }
      this.exitCallbacks.get(id)?.(id, exitCode ?? 0)
      this.extraExitListeners.get(id)?.forEach(cb => cb(id, exitCode ?? 0))
    })

    // If there's a command, write it to stdin after the shell initializes
    if (options.command) {
      setTimeout(() => {
        proc.write(options.command + '\n')
      }, 150)
    }

    this.sessions.set(id, {
      id,
      name: options.name,
      pty: proc,
      command: options.command,
      cwd: options.cwd,
      running: true,
      createdAt: Date.now(),
      nameLocked: options.nameLocked,
    })

    return id
  }

  private spawnShell(cwd: string, extraEnv?: Record<string, string>, cols = 80, rows = 24): pty.IPty {
    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh')
    return pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...extraEnv } as Record<string, string>,
    })
  }

  write(id: string, data: string) {
    this.sessions.get(id)?.pty?.write(data)
  }

  getFirstSessionId(): string | null {
    const first = this.sessions.keys().next()
    return first.done ? null : first.value
  }

  resize(id: string, cols: number, rows: number) {
    const session = this.sessions.get(id)
    if (session && cols > 0 && rows > 0) {
      session.cols = cols
      session.rows = rows
    }
    try {
      session?.pty?.resize(cols, rows)
    } catch {
      // ignore resize errors on dead PTY
    }
  }

  kill(id: string) {
    this.flush(id)
    const session = this.sessions.get(id)
    if (session?.pty) {
      session.pty.kill()
      session.pty = null
      session.running = false
    }
  }

  removeSession(id: string) {
    this.kill(id)
    this.sessions.delete(id)
    this.dataCallbacks.delete(id)
    this.exitCallbacks.delete(id)
    this.extraDataListeners.delete(id)
    this.extraExitListeners.delete(id)
  }

  restart(id: string, onData: (id: string, data: string) => void, onExit: (id: string, exitCode: number) => void): string {
    const session = this.sessions.get(id)
    if (!session) return id

    this.flush(id)
    // Kill existing PTY if still running
    if (session.pty) {
      session.pty.kill()
      session.pty = null
    }

    const extraEnv: Record<string, string> = {
      FORGETERM: '1',
      FORGETERM_PROJECT_PATH: session.cwd,
      FORGETERM_SESSION_ID: id,
      FORGETERM_SESSION_NAME: session.name,
    }
    if (this.socketPath) extraEnv.FORGETERM_SOCKET = this.socketPath

    const proc = this.spawnShell(session.cwd, extraEnv, session.cols, session.rows)

    this.dataCallbacks.set(id, onData)
    this.exitCallbacks.set(id, onExit)

    proc.onData((data) => {
      this.emitData(id, data)
      this.extraDataListeners.get(id)?.forEach(cb => cb(id, data))
    })

    proc.onExit(({ exitCode }) => {
      this.flush(id)
      const s = this.sessions.get(id)
      if (s) {
        s.running = false
        s.pty = null
      }
      this.exitCallbacks.get(id)?.(id, exitCode ?? 0)
      this.extraExitListeners.get(id)?.forEach(cb => cb(id, exitCode ?? 0))
    })

    // If there's a command, write it to stdin after the shell initializes
    if (session.command) {
      setTimeout(() => {
        proc.write(session.command + '\n')
      }, 150)
    }

    session.pty = proc
    session.running = true

    return id
  }

  rename(id: string, name: string, lock?: boolean) {
    const session = this.sessions.get(id)
    if (session) {
      session.name = name
      if (lock) session.nameLocked = true
    }
  }

  // Re-inserts sessions in the renderer's sidebar order. Map iteration order is
  // what getAllSessions (persist, `ft sessions`, remote) reports; unlisted ids keep
  // their relative order at the end.
  reorder(ids: string[]) {
    const reordered = new Map<string, PtySession>()
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (session) reordered.set(id, session)
    }
    for (const [id, session] of this.sessions) {
      if (!reordered.has(id)) reordered.set(id, session)
    }
    this.sessions = reordered
  }

  isNameLocked(id: string): boolean {
    return this.sessions.get(id)?.nameLocked ?? false
  }

  setSessionInfo(id: string, info: SessionContext) {
    const session = this.sessions.get(id)
    if (session) session.info = info
  }

  setConversationId(id: string, conversationId: string) {
    const session = this.sessions.get(id)
    if (session) session.conversationId = conversationId
  }

  getPid(id: string): number | null {
    return this.sessions.get(id)?.pty?.pid ?? null
  }

  getSession(id: string) {
    return this.sessions.get(id)
  }

  killAll() {
    for (const [id] of this.sessions) {
      this.kill(id)
    }
    this.sessions.clear()
    this.dataCallbacks.clear()
    this.exitCallbacks.clear()
    this.extraDataListeners.clear()
    this.extraExitListeners.clear()
  }

  addDataListener(id: string, listener: DataListener): () => void {
    if (!this.extraDataListeners.has(id)) {
      this.extraDataListeners.set(id, new Set())
    }
    this.extraDataListeners.get(id)!.add(listener)
    return () => { this.extraDataListeners.get(id)?.delete(listener) }
  }

  addExitListener(id: string, listener: ExitListener): () => void {
    if (!this.extraExitListeners.has(id)) {
      this.extraExitListeners.set(id, new Set())
    }
    this.extraExitListeners.get(id)!.add(listener)
    return () => { this.extraExitListeners.get(id)?.delete(listener) }
  }

  getAllSessions(): Array<{ id: string; name: string; command?: string; running: boolean; pid: number | null; info?: SessionContext; conversationId?: string; createdAt: number; nameLocked?: boolean }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      command: s.command,
      running: s.running,
      pid: s.pty?.pid ?? null,
      info: s.info,
      conversationId: s.conversationId,
      createdAt: s.createdAt,
      nameLocked: s.nameLocked,
    }))
  }
}
