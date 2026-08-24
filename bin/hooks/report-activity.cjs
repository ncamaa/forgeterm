#!/usr/bin/env node
/**
 * ForgeTerm activity hook
 *
 * Reports Claude's working state to ForgeTerm so the sidebar and Control Panel
 * can show a loading indicator while Claude is working and a glowing
 * notification dot when it finishes (cleared once you visit the session).
 *
 * Registered on three Claude Code events, with the status passed as argv[2]:
 *   UserPromptSubmit -> working    Stop -> done    Notification -> attention
 *
 * On Notification, Claude also hands us the reason on stdin as JSON
 * ({"message": "Claude needs your permission to use Bash"}). We forward it as
 * --message so the Control Panel can say WHY a session is waiting on you,
 * rather than just that it is.
 *
 * No-op outside a ForgeTerm-spawned terminal (FORGETERM_SESSION_ID unset).
 * Fires `forgeterm activity <status>` fire-and-forget and ALWAYS exits 0, so it
 * can never delay or block a Claude turn even if ForgeTerm isn't running.
 */

const { spawn } = require('node:child_process')

// Only relevant inside a ForgeTerm-spawned terminal.
if (!process.env.FORGETERM_SESSION_ID || !process.env.FORGETERM_PROJECT_PATH) {
  process.exit(0)
}

const status = process.argv[2]
if (!status) process.exit(0)

function report(message) {
  try {
    const args = ['activity', status]
    if (message) args.push('--message', message)
    const child = spawn('forgeterm', args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // never block a Claude turn
  }
  process.exit(0)
}

// Only 'attention' carries a reason worth showing; everything else reports
// immediately rather than waiting on stdin.
if (status !== 'attention' || process.stdin.isTTY) report('')

// Read the hook payload, but never let a slow/absent stdin hold up the turn.
let raw = ''
const bail = setTimeout(() => report(''), 400)
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('error', () => { clearTimeout(bail); report('') })
process.stdin.on('end', () => {
  clearTimeout(bail)
  let message = ''
  try {
    const payload = JSON.parse(raw)
    if (payload && typeof payload.message === 'string') message = payload.message.trim()
  } catch {
    // not JSON - report the bare status
  }
  report(message.slice(0, 300))
})
