// Which Claude identity and model a session runs, shown as a status-line style
// badge on its sidebar row: a filled identity chip (e.g. `HSP`) and the model
// in its family color (e.g. `Opus 5.5`).
//
// An identity is keyed by its Claude config dir: `~/.claude` is "default",
// `~/.claude-<name>` is "<name>" (so `~/.claude-hsp` is "hsp"). The label and
// color are generated from the key unless the app-level ui-prefs override them
// (`claudeIdentityBadges` in ui-prefs.json).

/** Live Claude details for one session, sent from main. */
export interface ClaudeSessionInfo {
  /** Identity key: "default" for ~/.claude, "<name>" for ~/.claude-<name>. */
  identity: string
  /** Model id of the latest assistant reply, e.g. `claude-opus-5-5`. */
  model?: string
}

export interface ClaudeIdentityBadgeStyle {
  label?: string
  /** Chip background, any CSS color. */
  color?: string
  /** Chip text color; picked for contrast against `color` when unset. */
  textColor?: string
}

/** ui-prefs `claudeIdentityBadges`: identity key -> badge style. */
export type ClaudeIdentityBadgeOverrides = Record<string, ClaudeIdentityBadgeStyle>

export const DEFAULT_IDENTITY = 'default'

/** `.claude` -> "default", `.claude-hsp` -> "hsp". */
export function identityKeyFromConfigDir(dirName: string): string {
  const m = /^\.?claude-(.+)$/.exec(dirName)
  return m ? m[1] : DEFAULT_IDENTITY
}

/**
 * Best guess from a CLI name, for sessions with no live Claude process: the
 * `claude-<name>` wrapper convention maps to `~/.claude-<name>`.
 */
export function identityKeyFromCli(cliName: string): string {
  if (cliName === 'claude') return DEFAULT_IDENTITY
  const m = /^claude-(.+)$/.exec(cliName)
  return m ? m[1] : cliName
}

// FNV-1a: similar keys ("hsp", "hsp-2") still land on far-apart hues.
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

// Saturated mid-tone chip color with a stable hue per identity key.
function hueColor(key: string): string {
  const hue = hash(key) % 360
  const s = 0.7
  const l = 0.42
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const hex = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

/** Black or white, whichever reads better on the given background (hex only; else white). */
export function contrastText(bg: string): string {
  const rgb = parseHex(bg)
  if (!rgb) return '#ffffff'
  const [r, g, b] = rgb.map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#111111' : '#ffffff'
}

export function resolveIdentityBadge(
  identity: string,
  overrides: ClaudeIdentityBadgeOverrides | undefined,
): { label: string; color: string; textColor: string } {
  const o = overrides?.[identity] ?? {}
  const label = o.label?.trim() || (identity === DEFAULT_IDENTITY ? 'CLAUDE' : identity.toUpperCase())
  const color = o.color?.trim() || (identity === DEFAULT_IDENTITY ? '#d97757' : hueColor(identity))
  return { label, color, textColor: o.textColor?.trim() || contrastText(color) }
}

type Family = 'Fable' | 'Opus' | 'Sonnet' | 'Haiku'
const FAMILY_COLORS: Record<Family, string> = {
  Fable: '#ff00ff',
  Opus: '#af5fff',
  Sonnet: '#00afff',
  Haiku: '#87d787',
}
const OTHER_MODEL_COLOR = '#bcbcbc'

function modelFamily(id: string): Family | null {
  const lc = id.toLowerCase()
  if (lc.includes('fable')) return 'Fable'
  if (lc.includes('opus')) return 'Opus'
  if (lc.includes('sonnet')) return 'Sonnet'
  if (lc.includes('haiku')) return 'Haiku'
  return null
}

/**
 * `claude-opus-5-5` -> "Opus 5.5", `claude-3-5-sonnet-20241022` -> "Sonnet 3.5",
 * `claude-opus-4-20250514` -> "Opus 4". Date stamps are ignored.
 */
export function friendlyModelName(id: string): string {
  const family = modelFamily(id)
  if (!family) return id.replace(/^claude-/, '')
  const ver = id.split(/[-_.[\]]/).filter(t => /^\d{1,2}$/.test(t)).slice(0, 2).join('.')
  return ver ? `${family} ${ver}` : family
}

export function modelColor(id: string): string {
  const family = modelFamily(id)
  return family ? FAMILY_COLORS[family] : OTHER_MODEL_COLOR
}
