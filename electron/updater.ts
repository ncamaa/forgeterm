import { app, net, BrowserWindow } from 'electron'
import { writeFileSync, chmodSync, createWriteStream, unlinkSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { tmpdir } from 'os'

// --- Update provider abstraction ---
// Currently uses GitHub Releases API (notification-only).
// To switch to full auto-update with electron-updater:
//   1. `pnpm add electron-updater`
//   2. Replace GitHubReleaseProvider with ElectronUpdaterProvider below
//   3. The rest of the code (IPC, UI) stays the same

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion?: string
  releaseUrl?: string
  releaseNotes?: string
  dmgUrl?: string
  /** Set when the update check itself failed (not the same as up to date). */
  error?: string
}

export interface UpdateProvider {
  check(): Promise<UpdateInfo>
  /** Apply the update (restart + install). Only supported by auto-updater providers. */
  apply(): Promise<void>
  /** Whether this provider supports in-app install (vs. just opening a URL). */
  readonly supportsAutoInstall: boolean
}

// --- GitHub Release provider (notification-only) ---

const GITHUB_OWNER = 'ncamaa'
const GITHUB_REPO = 'forgeterm'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    request.setHeader('User-Agent', `ForgeTerm/${app.getVersion()}`)
    let body = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { body += chunk.toString() })
      response.on('end', () => {
        if (response.statusCode === 200) {
          try { resolve(JSON.parse(body)) }
          catch { reject(new Error('Invalid JSON')) }
        } else {
          reject(new Error(`HTTP ${response.statusCode}`))
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/** Extract the version from a `.../releases/tag/vX.Y.Z` redirect target. */
export function parseVersionFromReleaseLocation(location: string): string | null {
  const m = location.match(/\/tag\/v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?)\/?$/)
  return m ? m[1] : null
}

/**
 * Fallback that is not subject to the unauthenticated API rate limit:
 * github.com/<repo>/releases/latest answers with a 302 whose Location ends in /tag/vX.Y.Z.
 */
function fetchLatestTagViaRedirect(): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'HEAD',
      redirect: 'manual',
    })
    request.setHeader('User-Agent', `ForgeTerm/${app.getVersion()}`)
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    request.on('redirect', (_status, _method, redirectUrl) => {
      const version = parseVersionFromReleaseLocation(redirectUrl)
      finish(() => version ? resolve(version) : reject(new Error(`Unexpected redirect: ${redirectUrl}`)))
      request.abort()
    })
    request.on('response', (response) => {
      finish(() => reject(new Error(`HTTP ${response.statusCode} (no redirect)`)))
    })
    request.on('error', (err) => finish(() => reject(err)))
    request.end()
  })
}

export class GitHubReleaseProvider implements UpdateProvider {
  readonly supportsAutoInstall = false

  async check(): Promise<UpdateInfo> {
    const currentVersion = app.getVersion()
    try {
      const data = await fetchJson(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      ) as { tag_name: string; html_url: string; body?: string; assets?: Array<{ name: string; browser_download_url: string }> }

      const latestVersion = data.tag_name.replace(/^v/, '')
      const available = compareVersions(currentVersion, latestVersion) > 0

      const dmgAsset = data.assets?.find(a => a.name.endsWith('.dmg'))

      return {
        available,
        currentVersion,
        latestVersion,
        releaseUrl: data.html_url,
        releaseNotes: data.body ?? undefined,
        dmgUrl: dmgAsset?.browser_download_url,
      }
    } catch (apiErr) {
      // API failed (rate limit, network): fall back to the github.com redirect.
      try {
        const latestVersion = await fetchLatestTagViaRedirect()
        const base = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
        return {
          available: compareVersions(currentVersion, latestVersion) > 0,
          currentVersion,
          latestVersion,
          releaseUrl: `${base}/tag/v${latestVersion}`,
          dmgUrl: `${base}/download/v${latestVersion}/ForgeTerm-Mac-${latestVersion}.dmg`,
        }
      } catch (fallbackErr) {
        const reason = (apiErr instanceof Error ? apiErr.message : String(apiErr)) +
          '; fallback: ' + (fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr))
        return { available: false, currentVersion, error: reason }
      }
    }
  }

  async apply(): Promise<void> {
    throw new Error('Auto-install not supported. Use openExternal to open the release URL.')
  }
}

// --- Uncomment when you have code signing + electron-updater installed ---
//
// import { autoUpdater } from 'electron-updater'
//
// export class ElectronUpdaterProvider implements UpdateProvider {
//   readonly supportsAutoInstall = true
//
//   async check(): Promise<UpdateInfo> {
//     const currentVersion = app.getVersion()
//     try {
//       const result = await autoUpdater.checkForUpdates()
//       if (!result || !result.updateInfo) {
//         return { available: false, currentVersion }
//       }
//       const latestVersion = result.updateInfo.version
//       return {
//         available: compareVersions(currentVersion, latestVersion) > 0,
//         currentVersion,
//         latestVersion,
//         releaseNotes: typeof result.updateInfo.releaseNotes === 'string'
//           ? result.updateInfo.releaseNotes : undefined,
//       }
//     } catch {
//       return { available: false, currentVersion }
//     }
//   }
//
//   async apply(): Promise<void> {
//     await autoUpdater.downloadUpdate()
//     autoUpdater.quitAndInstall()
//   }
// }

// --- Singleton updater manager ---

export class UpdateManager {
  private provider: UpdateProvider
  private lastCheck: UpdateInfo | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners: Array<(info: UpdateInfo) => void> = []

  constructor(provider?: UpdateProvider) {
    // Swap this line to switch providers:
    this.provider = provider ?? new GitHubReleaseProvider()
  }

  get supportsAutoInstall(): boolean {
    return this.provider.supportsAutoInstall
  }

  onUpdateAvailable(fn: (info: UpdateInfo) => void) {
    this.listeners.push(fn)
  }

  async checkNow(): Promise<UpdateInfo> {
    this.lastCheck = await this.provider.check()
    if (this.lastCheck.available) {
      for (const fn of this.listeners) fn(this.lastCheck)
    }
    return this.lastCheck
  }

  getLastCheck(): UpdateInfo | null {
    return this.lastCheck
  }

  startPeriodicChecks() {
    // Check shortly after launch (give the app 30s to settle)
    setTimeout(() => this.checkNow(), 30_000)
    this.timer = setInterval(() => this.checkNow(), CHECK_INTERVAL_MS)
  }

  stopPeriodicChecks() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async applyUpdate(): Promise<void> {
    return this.provider.apply()
  }

  private downloadedDmgPath: string | null = null

  /** Download DMG to temp, sending progress events to all windows. Returns local path. */
  downloadDmg(dmgUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const dmgPath = join(tmpdir(), 'ForgeTerm-update.dmg')
      const request = net.request(dmgUrl)
      request.setHeader('User-Agent', `ForgeTerm/${app.getVersion()}`)
      request.on('response', (response) => {
        // Follow redirects (GitHub asset URLs redirect)
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          const location = response.headers['location']
          const redirectUrl = Array.isArray(location) ? location[0] : location
          if (redirectUrl) {
            this.downloadDmg(redirectUrl).then(resolve, reject)
            return
          }
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`))
          return
        }
        const contentLength = response.headers['content-length']
        const totalBytes = contentLength
          ? parseInt(Array.isArray(contentLength) ? contentLength[0] : contentLength, 10)
          : 0
        let receivedBytes = 0
        const file = createWriteStream(dmgPath)

        response.on('data', (chunk) => {
          receivedBytes += chunk.length
          file.write(chunk)
          const progress = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : -1
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('update:download-progress', { progress, receivedBytes, totalBytes })
            }
          }
        })
        response.on('end', () => {
          file.end(() => {
            this.downloadedDmgPath = dmgPath
            resolve(dmgPath)
          })
        })
        response.on('error', (err: Error) => {
          file.close()
          try { unlinkSync(dmgPath) } catch {}
          reject(err)
        })
      })
      request.on('error', reject)
      request.end()
    })
  }

  /** Build a shell command string that downloads, mounts, copies, and relaunches. */
  buildUpdateCommand(dmgUrl: string): string {
    const appPath = '/Applications/ForgeTerm.app'
    return [
      `DMG_URL="${dmgUrl}"`,
      `DMG_PATH="/tmp/ForgeTerm-update.dmg"`,
      `echo "Downloading ForgeTerm update..."`,
      `curl -L -o "$DMG_PATH" "$DMG_URL"`,
      `echo "Mounting DMG..."`,
      `MOUNT_DIR=$(hdiutil attach "$DMG_PATH" -nobrowse -noverify | grep "/Volumes/" | awk -F'\\t' '{print $NF}')`,
      `echo "Installing to ${appPath}..."`,
      `rm -rf "${appPath}"`,
      `cp -R "$MOUNT_DIR/ForgeTerm.app" "${appPath}"`,
      `echo "Cleaning up..."`,
      `hdiutil detach "$MOUNT_DIR" -quiet`,
      `rm -f "$DMG_PATH"`,
      `xattr -cr "${appPath}"`,
      `echo "Launching ForgeTerm..."`,
      `open "${appPath}"`,
      `echo "Done!"`,
    ].join(' && ')
  }

  /** Spawn a detached update script, then quit the app. Uses pre-downloaded DMG if available. */
  installViaScript(dmgUrl: string): void {
    const appPath = '/Applications/ForgeTerm.app'
    const pid = process.pid
    const scriptPath = join(tmpdir(), `forgeterm-update-${Date.now()}.sh`)
    const preDownloaded = this.downloadedDmgPath

    const downloadStep = preDownloaded
      ? `DMG_PATH="${preDownloaded}"\necho "Using pre-downloaded DMG..."`
      : `DMG_PATH="/tmp/ForgeTerm-update.dmg"
echo "Downloading ForgeTerm update..."
curl -L -o "$DMG_PATH" "${dmgUrl}"
if [ $? -ne 0 ]; then
  echo "Download failed."
  rm -f "$DMG_PATH"
  exit 1
fi`

    const script = `#!/bin/bash
# ForgeTerm self-update script
# Wait for the app to exit
echo "Waiting for ForgeTerm to quit..."
while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done

${downloadStep}

echo "Mounting DMG..."
MOUNT_DIR=$(hdiutil attach "$DMG_PATH" -nobrowse -noverify | grep "/Volumes/" | awk -F'\\t' '{print $NF}')
if [ -z "$MOUNT_DIR" ]; then
  echo "Mount failed."
  rm -f "$DMG_PATH"
  exit 1
fi

echo "Installing to ${appPath}..."
rm -rf "${appPath}"
cp -R "$MOUNT_DIR/ForgeTerm.app" "${appPath}"

echo "Cleaning up..."
hdiutil detach "$MOUNT_DIR" -quiet
rm -f "$DMG_PATH"

xattr -cr "${appPath}"

echo "Launching ForgeTerm..."
open "${appPath}"

# Clean up this script
rm -f "${scriptPath}"
`

    writeFileSync(scriptPath, script, 'utf-8')
    chmodSync(scriptPath, 0o755)

    // Spawn detached so it survives our exit
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    // Quit the app
    app.quit()
  }
}
