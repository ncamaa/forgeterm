import type { ClaudeLaunch } from './types'

// Helpers for projects that run more than one Claude identity (CLI wrapper),
// e.g. a primary "claude-hsp" plus an alternate "claude-hsp-ncadm".

/** Parse a comma/space-separated list (or an array) of CLI names, trimmed and de-duplicated. */
export function parseCliList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  const out: string[] = []
  for (const name of raw) {
    const n = name.trim()
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/** Every identity the project can launch, primary first, without duplicates. */
export function claudeIdentities(launch: ClaudeLaunch): string[] {
  return parseCliList([launch.cliName, ...(launch.cliAlternates ?? [])])
}

/** Short badge label for an identity: "claude-hsp-ncadm" -> "hsp-ncadm". */
export function identityShortName(cliName: string): string {
  const short = cliName.replace(/^claude-/, '')
  return short || cliName
}

/**
 * The identity a session was launched with, read from the first word of its
 * command. Only a known identity counts; anything else (a plain shell, a
 * custom command) resolves to the primary.
 */
export function sessionIdentity(command: string | undefined, launch: ClaudeLaunch): string {
  const first = command?.trim().split(/\s+/)[0]
  return first && claudeIdentities(launch).includes(first) ? first : launch.cliName
}

/** The launch settings with the CLI swapped for the given identity. */
export function launchFor(launch: ClaudeLaunch, cliName: string): ClaudeLaunch {
  return cliName === launch.cliName ? launch : { ...launch, cliName }
}
