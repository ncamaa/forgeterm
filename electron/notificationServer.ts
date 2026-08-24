import { app, Notification, BrowserWindow } from 'electron'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import type { ForgeTermNotification } from '../shared/types'

export function getSocketPath(): string {
  // Dev builds share the userData dir with the installed app, so they must not
  // share the socket file - otherwise whichever starts last takes over `ft`.
  const name = app.isPackaged ? 'forgeterm.sock' : 'forgeterm-dev.sock'
  return path.join(app.getPath('userData'), name)
}

const WATCHDOG_INTERVAL_MS = 5000
const PROBE_TIMEOUT_MS = 1000

function statInode(socketPath: string): number | null {
  try {
    return fs.statSync(socketPath).ino
  } catch {
    return null
  }
}

// True when a live server is accepting connections on socketPath. Used to tell
// a socket owned by another running instance from a stale file left by a dead one.
function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath)
    let settled = false
    const finish = (alive: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.removeAllListeners()
      conn.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
    conn.once('connect', () => finish(true))
    conn.once('error', () => finish(false))
  })
}

export type CommandResult = { ok: boolean; data?: unknown; error?: string }
export type CommandHandler = (payload: Record<string, unknown>) => CommandResult

export interface NotificationServerOptions {
  handlers: Map<string, CommandHandler>
  findWindowForProject: (projectPath: string) => BrowserWindow | null
  getProjectDisplayName: (projectPath: string) => string | null
}

interface CliCommand {
  command: string
  [key: string]: unknown
}

export class NotificationServer {
  private server: net.Server | null = null
  private ownedInode: number | null = null
  private watchdog: NodeJS.Timeout | null = null
  private checking = false
  // Servers whose socket file was replaced by another instance. Closing one
  // unlinks the path it bound, which now belongs to that instance, so these are
  // abandoned instead and reclaimed when the process exits.
  private abandoned: net.Server[] = []
  // Electron keeps a native notification's click delegate alive only while its
  // JS wrapper is reachable. A notification held in a local is collectable the
  // moment showNotification() returns, and once collected the banner stays on
  // screen but its 'click' is silently dropped. macOS keeps entries in
  // Notification Center indefinitely, so this can't be time-boxed - retain the
  // most recent ones instead.
  private liveNotifications = new Set<Electron.Notification>()
  private options: NotificationServerOptions

  constructor(options: NotificationServerOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    await this.ensureListening()
    if (!this.watchdog) {
      this.watchdog = setInterval(() => void this.ensureListening(), WATCHDOG_INTERVAL_MS)
      this.watchdog.unref()
    }
  }

  // Invariant: after this runs, the socket path is served by us unless another
  // live instance is already serving it. Re-binds if our file was removed.
  private async ensureListening(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const socketPath = getSocketPath()

      if (this.server?.listening) {
        const ino = statInode(socketPath)
        if (ino !== null && ino === this.ownedInode) return
        // Our file was deleted or replaced, so the CLI can no longer reach us.
        if (ino !== null && (await isSocketAlive(socketPath))) {
          this.releaseServer(true)
          return
        }
        this.releaseServer(false)
      }

      if (statInode(socketPath) !== null) {
        if (await isSocketAlive(socketPath)) return
        // Stale file from a dead instance - listen() would fail with EADDRINUSE.
        try {
          fs.unlinkSync(socketPath)
        } catch {
          // ignore
        }
      }

      await this.listen(socketPath)
    } finally {
      this.checking = false
    }
  }

  private releaseServer(pathTakenOver: boolean) {
    const server = this.server
    this.server = null
    this.ownedInode = null
    if (!server) return
    if (pathTakenOver) this.abandoned.push(server)
    else server.close()
  }

  private listen(socketPath: string): Promise<void> {
    return new Promise((resolve) => {
      const server = net.createServer((conn) => {
        // A CLI client that exits mid-reply raises EPIPE here; unhandled it
        // would take down the main process and every terminal with it.
        conn.on('error', () => {})
        let buffer = ''
        conn.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const payload = JSON.parse(line)
              const result = this.handleCommand(payload)
              conn.write(JSON.stringify(result) + '\n')
            } catch {
              conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n')
            }
          }
        })
      })

      const onListenError = (err: Error) => {
        console.error('NotificationServer failed to listen:', err.message)
        server.removeAllListeners()
        server.close()
        resolve()
      }

      server.once('error', onListenError)
      server.listen(socketPath, () => {
        server.removeListener('error', onListenError)
        server.on('error', (err) => console.error('NotificationServer error:', err.message))
        this.server = server
        this.ownedInode = statInode(socketPath)
        resolve()
      })
    })
  }

  private handleCommand(payload: CliCommand | ForgeTermNotification): CommandResult {
    // Command with explicit `command` field
    if ('command' in payload && typeof payload.command === 'string') {
      const handler = this.options.handlers.get(payload.command)
      if (handler) {
        try {
          return handler(payload as Record<string, unknown>)
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      }
      return { ok: false, error: `Unknown command: ${payload.command}` }
    }

    // Legacy: treat as notification (backwards compat with old CLI)
    if ('message' in payload) {
      this.showNotification(payload as ForgeTermNotification)
      return { ok: true }
    }

    return { ok: false, error: 'Unknown payload format' }
  }

  showNotification(notif: ForgeTermNotification) {
    const title = notif.title || this.options.getProjectDisplayName(notif.projectPath ?? '') || 'ForgeTerm'
    const body = notif.sessionName
      ? `[${notif.sessionName}] ${notif.message}`
      : notif.message

    const n = new Notification({
      title,
      body,
      silent: notif.sound === false,
    })

    this.liveNotifications.add(n)
    while (this.liveNotifications.size > 50) {
      const oldest = this.liveNotifications.values().next().value
      if (!oldest) break
      this.liveNotifications.delete(oldest)
    }
    n.on('close', () => this.liveNotifications.delete(n))

    n.on('click', () => {
      const win = notif.projectPath ? this.options.findWindowForProject(notif.projectPath) : null
      if (!win || win.isDestroyed()) {
        // No live window: the project was closed since, or the notify came from
        // outside a ForgeTerm session. Reopen it if we know which, and still
        // bring the app forward so the click goes somewhere.
        if (notif.projectPath) this.options.handlers.get('open')?.({ path: notif.projectPath })
        if (process.platform === 'darwin') app.focus({ steal: true })
        return
      }
      if (win.isMinimized()) win.restore()
      // macOS will not raise a background app from BrowserWindow.focus() alone:
      // Electron calls activateIgnoringOtherApps:NO, and focus() is a no-op on a
      // window that isn't visible. Without this the click did nothing at all.
      if (process.platform === 'darwin') app.focus({ steal: true })
      win.show()
      win.focus()
      if (notif.sessionId) {
        const sessionId = notif.sessionId
        if (win.webContents.isLoading()) {
          win.webContents.once('did-finish-load', () => {
            if (!win.isDestroyed()) win.webContents.send('notification:focus-session', sessionId)
          })
        } else {
          win.webContents.send('notification:focus-session', sessionId)
        }
      }
    })

    n.show()
  }

  // Reflects whether the CLI can actually reach us, not just whether the server
  // object is bound - the socket file it was bound to may be gone.
  isListening(): boolean {
    if (!this.server?.listening || this.ownedInode === null) return false
    return statInode(getSocketPath()) === this.ownedInode
  }

  stop() {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    if (!this.server) return
    const ino = statInode(getSocketPath())
    this.releaseServer(ino !== null && ino !== this.ownedInode)
  }
}
