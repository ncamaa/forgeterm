#!/usr/bin/env node

const { execSync } = require('child_process')
const path = require('path')
const net = require('net')
const os = require('os')
const fs = require('fs')

const subcommand = process.argv[2]

if (subcommand === 'notify') {
  handleNotify()
} else if (subcommand === 'open') {
  handleOpen()
} else if (subcommand === 'list') {
  handleList()
} else if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  printHelp()
} else if (subcommand === '--version' || subcommand === '-v') {
  const pkg = require('../package.json')
  console.log(`forgeterm ${pkg.version}`)
} else {
  // Default: launch Electron with folder path
  const folder = subcommand || '.'
  const absPath = path.resolve(folder)

  const electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron')
  const mainPath = path.join(__dirname, '..', 'dist-electron', 'main.js')

  try {
    execSync(`"${electronPath}" "${mainPath}" "${absPath}"`, { stdio: 'inherit' })
  } catch {
    process.exit(1)
  }
}

// --- Socket helpers ---

// The directory is Electron's userData dir, which is named after the package
// name - lowercase, and case-sensitive outside macOS.
function getSocketPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/forgeterm/forgeterm.sock')
  }
  return path.join(os.homedir(), '.config/forgeterm/forgeterm.sock')
}

function isForgeTermRunning() {
  if (process.platform === 'win32') return false
  try {
    execSync('pgrep -i forgeterm', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function notReachableError(socketPath) {
  if (isForgeTermRunning()) {
    return new Error(
      `ForgeTerm is running but is not serving ${socketPath}.\n` +
        'It re-binds the socket every few seconds; if this persists, restart ForgeTerm.'
    )
  }
  return new Error('Could not connect to ForgeTerm. Is it running?')
}

function sendCommand(payload) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.FORGETERM_SOCKET || getSocketPath()
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(payload) + '\n')
    })

    let response = ''
    client.on('data', (data) => {
      response += data.toString()
      if (response.includes('\n')) {
        try {
          resolve(JSON.parse(response.trim()))
        } catch {
          resolve({ ok: false, error: 'Invalid response' })
        }
        client.end()
      }
    })

    client.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(notReachableError(socketPath))
      } else {
        reject(new Error(err.message))
      }
    })

    const timeout = setTimeout(() => {
      client.destroy()
      reject(new Error('Timed out waiting for ForgeTerm response'))
    }, 5000)
    timeout.unref()
  })
}

// --- Commands ---

async function handleNotify() {
  const args = process.argv.slice(3)

  let message = ''
  let title = undefined
  let sound = true

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title' && args[i + 1]) {
      title = args[++i]
    } else if (args[i] === '--no-sound') {
      sound = false
    } else if (args[i] === '--help' || args[i] === '-h') {
      printNotifyHelp()
      process.exit(0)
    } else if (!args[i].startsWith('-')) {
      message = args[i]
    }
  }

  if (!message) {
    printNotifyHelp()
    process.exit(1)
  }

  const projectPath = process.env.FORGETERM_PROJECT_PATH
  const sessionId = process.env.FORGETERM_SESSION_ID
  const sessionName = process.env.FORGETERM_SESSION_NAME

  try {
    const result = await sendCommand({
      command: 'notify',
      message,
      title,
      sound,
      projectPath,
      sessionId,
      sessionName,
    })
    if (!result.ok) {
      console.error('Notification failed:', result.error)
      process.exit(1)
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

async function handleOpen() {
  const args = process.argv.slice(3)

  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage: forgeterm open <path>

Open a directory in ForgeTerm. If the project is already open, it focuses
the existing window. Otherwise it creates a new window and adds the project
to your recent projects list.

Examples:
  forgeterm open .
  forgeterm open ~/projects/my-app
  forgeterm open /absolute/path/to/project
`.trim())
    process.exit(0)
  }

  const folder = args[0]
  if (!folder) {
    console.error('Usage: forgeterm open <path>')
    process.exit(1)
  }

  const absPath = path.resolve(folder)
  if (!fs.existsSync(absPath)) {
    console.error(`Path does not exist: ${absPath}`)
    process.exit(1)
  }

  try {
    const result = await sendCommand({ command: 'open', path: absPath })
    if (!result.ok) {
      console.error('Failed to open project:', result.error)
      process.exit(1)
    }
    console.log(`Opened ${absPath}`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

async function handleList() {
  const args = process.argv.slice(3)

  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage: forgeterm list [options]

List your recent ForgeTerm projects.

Options:
  --json    Output as JSON
  -h, --help  Show this help
`.trim())
    process.exit(0)
  }

  const jsonOutput = args.includes('--json')

  try {
    const result = await sendCommand({ command: 'list' })
    if (!result.ok) {
      console.error('Failed to list projects:', result.error)
      process.exit(1)
    }

    const projects = result.data || []
    if (jsonOutput) {
      console.log(JSON.stringify(projects, null, 2))
    } else if (projects.length === 0) {
      console.log('No recent projects.')
    } else {
      for (const p of projects) {
        const workspace = p.workspace ? ` [${p.workspace}]` : ''
        console.log(`  ${p.name}${workspace}`)
        console.log(`    ${p.path}`)
      }
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

// --- Help ---

function printHelp() {
  const pkg = require('../package.json')
  console.log(`
forgeterm ${pkg.version} - Terminal emulator for multi-project workflows

Usage: forgeterm <command> [options]

Commands:
  forgeterm [path]            Launch ForgeTerm (optionally in a directory)
  forgeterm open <path>       Open a project in the running ForgeTerm app
  forgeterm list [--json]     List recent projects
  forgeterm notify "message"  Send a native notification
  forgeterm help              Show this help

Notification options:
  --title "title"   Custom notification title
  --no-sound        Suppress notification sound

Examples:
  forgeterm .                     Open current directory
  forgeterm open ~/projects/app   Open a project (adds to recent list)
  forgeterm list                  Show recent projects
  forgeterm list --json           Output recent projects as JSON
  forgeterm notify "Build done"   Send a notification
  pnpm build && forgeterm notify "Build done"

Tip: Add this to your project's CLAUDE.md or AI instructions:
  When you finish a task, run: forgeterm notify "Done"
`.trim())
}

function printNotifyHelp() {
  console.log(`
Usage: forgeterm notify "message" [options]

Send a macOS notification through the running ForgeTerm app.
When run inside a ForgeTerm session, the notification automatically
includes project and session context. Clicking it focuses that window.

Options:
  --title "title"   Custom notification title (defaults to project name)
  --no-sound        Suppress notification sound
  -h, --help        Show this help

Examples:
  forgeterm notify "Build complete"
  forgeterm notify "Tests passed" --title "CI"
  forgeterm notify "Deploy done" --no-sound
`.trim())
}
