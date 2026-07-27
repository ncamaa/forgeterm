export interface WindowTheme {
  accentColor: string
  titlebarBackground: string
  titlebarBackgroundEnd: string
  titlebarForeground: string
  sidebarBackground: string
  sidebarForeground: string
  buttonBackground: string
  /** Titlebar gradient direction in degrees. Defaults to 90 (left -> right). */
  gradientAngle?: number
}

export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  selection: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
}

export interface PresetTheme {
  id: string
  name: string
  window: WindowTheme
  /** Key into TERMINAL_THEMES - selecting the preset also switches the terminal. */
  terminalMode: string
  terminal: TerminalColors
}

// --- Color utilities ---

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [h * 360, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  h /= 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  const toHex = (c: number) => {
    const hex = Math.round(c * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function adjustAccentBrightness(accentHex: string, delta: number): string {
  const [h, s, l] = hexToHsl(accentHex)
  return hslToHex(h, s, Math.max(10, Math.min(90, l + delta)))
}

/** Accent color as rgba, for glows and soft accent washes. */
export function accentGlow(accentHex: string, alpha: number): string {
  if (!accentHex?.startsWith('#') || accentHex.length !== 7) return `rgba(56, 189, 248, ${alpha})`
  const r = parseInt(accentHex.slice(1, 3), 16)
  const g = parseInt(accentHex.slice(3, 5), 16)
  const b = parseInt(accentHex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** True when the chrome is a light theme, so callers can flip their own contrast. */
export function isLightChrome(w: Pick<WindowTheme, 'sidebarBackground'> | null | undefined): boolean {
  const bg = w?.sidebarBackground
  if (!bg?.startsWith('#') || bg.length !== 7) return false
  return hexToHsl(bg)[2] > 50
}

/** Single source of truth for the titlebar gradient, used by app chrome and previews. */
export function titlebarGradient(
  w: { titlebarBackground?: string; titlebarBackgroundEnd?: string; gradientAngle?: number } | null | undefined,
  fallback = '#101c3a'
): string {
  const start = w?.titlebarBackground ?? fallback
  if (!w?.titlebarBackgroundEnd) return start
  return `linear-gradient(${w.gradientAngle ?? 90}deg, ${start}, ${w.titlebarBackgroundEnd})`
}

// --- Terminal themes ---

type Ansi = [string, string, string, string, string, string, string, string]

function term(bg: string, fg: string, cursor: string, ansi: Ansi): TerminalColors {
  const [black, red, green, yellow, blue, magenta, cyan, white] = ansi
  return {
    background: bg,
    foreground: fg,
    cursor,
    selection: accentGlow(cursor, 0.28),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
  }
}

export const TERMINAL_THEMES: Record<string, TerminalColors> = {
  dark: term('#141d31', '#e6edf7', '#38bdf8', [
    '#1e293b', '#ff7b72', '#56d364', '#ffd866', '#79b8ff', '#d2a8ff', '#56d4dd', '#f1f5f9',
  ]),
  light: term('#f8fafc', '#1e293b', '#0284c7', [
    '#334155', '#dc2626', '#16a34a', '#ca8a04', '#2563eb', '#9333ea', '#0891b2', '#f1f5f9',
  ]),
  midnight: term('#151d36', '#cfdcf0', '#6aa8ff', [
    '#1c2540', '#ff7b8a', '#5ce68f', '#ffd479', '#7ab8ff', '#b79bff', '#5ad4f0', '#e4ecf8',
  ]),
  ocean: term('#112536', '#bfdcea', '#22d3ee', [
    '#17293c', '#ff8a6b', '#3ddc97', '#ffd166', '#6cc5ff', '#a6a1ff', '#5ee7e7', '#dff0f6',
  ]),
  aurora: term('#102831', '#c2e5dd', '#2ee6ac', [
    '#163035', '#ff7f7f', '#3ff0b0', '#ffe07a', '#63c7ff', '#b39bff', '#4fe6e6', '#e0f5f0',
  ]),
  forest: term('#17291c', '#c3dcbc', '#4ade80', [
    '#1e3324', '#ef6f5e', '#5bdc7d', '#f2cd4f', '#58a9e6', '#b07fd0', '#3ecfae', '#e9f3e6',
  ]),
  citrus: term('#212916', '#dde7c6', '#b8e63c', [
    '#29321a', '#ff7a6a', '#a8e34a', '#f5d94a', '#6fb8ff', '#c79bff', '#5fdec6', '#f0f5e2',
  ]),
  warm: term('#2c1f0e', '#e3cfae', '#f5a623', [
    '#33240f', '#ff7a5c', '#86cf5e', '#ffc043', '#6fa8dc', '#c58af0', '#4fc9b0', '#f5ead6',
  ]),
  sunset: term('#2f1a21', '#f0cfcb', '#ff8a4c', [
    '#38202a', '#ff7a7a', '#7ee0a1', '#ffbf5e', '#7fb6ff', '#ff8ad0', '#5fd8d8', '#ffe6e0',
  ]),
  ember: term('#2e1518', '#f0cbc6', '#ff6b5e', [
    '#391a1b', '#ff7161', '#86dc8b', '#ffc860', '#7fb3ff', '#e08aff', '#55d6cf', '#ffe3dd',
  ]),
  rose: term('#2e1721', '#ecc9d6', '#ff5fa2', [
    '#381c29', '#ff7f9e', '#6fe3b6', '#ffdd8f', '#8fb8ff', '#e59bff', '#6fe0e0', '#ffe4ef',
  ]),
  grape: term('#27163c', '#e0cef5', '#e879f9', [
    '#2e1c47', '#ff7b9c', '#7fe6a6', '#ffd782', '#8fb2ff', '#f18aff', '#6fdff0', '#f0e2ff',
  ]),
  violet: term('#1e1737', '#d8d0f5', '#a78bfa', [
    '#241c42', '#ff8598', '#7de3a8', '#ffd97d', '#8ab4ff', '#c79bff', '#6ee0e6', '#ece6ff',
  ]),
  abyss: term('#15193d', '#ccd3f5', '#818cf8', [
    '#1a1f47', '#ff8093', '#6fe0a5', '#ffd36e', '#7da2ff', '#b48aff', '#5fd6ee', '#e2e8ff',
  ]),
  nord: term('#2e3440', '#d8dee9', '#88c0d0', [
    '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
  ]),
  mono: term('#1d2025', '#d5d9df', '#c7ccd4', [
    '#23262c', '#e8858a', '#97cf9a', '#ddc179', '#92b3d9', '#bd9bd0', '#86c9c9', '#eceff3',
  ]),
  neon: term('#1d1032', '#f2d9ff', '#ff4fd8', [
    '#26123f', '#ff4d6d', '#3bf0a5', '#ffe14d', '#4fc3ff', '#ff5fe0', '#38f0ec', '#ffe9ff',
  ]),
  frost: term('#eef4fa', '#22303f', '#0284c7', [
    '#33455a', '#d13b3b', '#17864f', '#a97400', '#1d6fd6', '#8b3fc4', '#0d7f96', '#f7fbff',
  ]),
  latte: term('#f7f1e6', '#3b3128', '#c2410c', [
    '#4a3f33', '#c23a2b', '#4a7c1f', '#a06a00', '#2563a8', '#8b3d8b', '#0f7a72', '#fffaf2',
  ]),
}

export function getTerminalTheme(mode: string): TerminalColors {
  return { ...(TERMINAL_THEMES[mode] || TERMINAL_THEMES.dark) }
}

export function getTerminalThemeNames(): string[] {
  return Object.keys(TERMINAL_THEMES)
}

// --- Window chrome generation ---

type HSL = [number, number, number]

/**
 * Builds a full window chrome from an accent plus three background stops.
 * Text and button colors are derived from the accent hue so every theme is
 * internally consistent, and light chrome (sidebar lightness > 50) flips to
 * dark text automatically.
 */
function buildChrome(accent: string, from: HSL, to: HSL, sidebar: HSL, angle = 90): WindowTheme {
  const [ah, as] = hexToHsl(accent)
  const [sh, ss, sl] = sidebar
  const light = sl > 50
  return {
    accentColor: accent,
    titlebarBackground: hslToHex(from[0], from[1], from[2]),
    titlebarBackgroundEnd: hslToHex(to[0], to[1], to[2]),
    titlebarForeground: light ? hslToHex(ah, Math.min(as, 65), 24) : hslToHex(ah, Math.min(as, 50), 82),
    sidebarBackground: hslToHex(sh, ss, sl),
    sidebarForeground: light ? hslToHex(ah, Math.min(as, 50), 30) : hslToHex(ah, Math.min(as, 34), 74),
    buttonBackground: light
      ? hslToHex(sh, Math.min(ss, 34), sl - 9)
      : hslToHex(sh, Math.min(ss + 8, 55), sl + 12),
    gradientAngle: angle,
  }
}

export function generateWindowTheme(accentHex: string): WindowTheme {
  const [h, s] = hexToHsl(accentHex)
  const cs = Math.min(s, 58)
  return buildChrome(
    accentHex,
    [h - 8, cs * 0.85, 16],
    [h + 20, cs * 0.8, 28],
    [h, cs * 0.75, 15],
    105
  )
}

// --- Preset themes ---

interface PresetSpec {
  id: string
  name: string
  accent: string
  from: HSL
  to: HSL
  sidebar: HSL
  angle: number
  terminalMode: string
}

const PRESET_SPECS: PresetSpec[] = [
  // Blues / cyans
  { id: 'midnight', name: 'Midnight', accent: '#4c9eff', from: [226, 58, 17], to: [209, 66, 30], sidebar: [224, 46, 15], angle: 100, terminalMode: 'midnight' },
  { id: 'ocean', name: 'Ocean', accent: '#22d3ee', from: [202, 62, 15], to: [184, 62, 28], sidebar: [199, 52, 14], angle: 95, terminalMode: 'ocean' },
  { id: 'aurora', name: 'Aurora', accent: '#2ee6ac', from: [196, 58, 16], to: [152, 54, 27], sidebar: [178, 46, 14], angle: 115, terminalMode: 'aurora' },
  // Greens / yellows
  { id: 'forest', name: 'Forest', accent: '#4ade80', from: [152, 46, 14], to: [96, 44, 24], sidebar: [145, 40, 13], angle: 110, terminalMode: 'forest' },
  { id: 'citrus', name: 'Citrus', accent: '#b8e63c', from: [92, 46, 15], to: [58, 54, 26], sidebar: [85, 40, 14], angle: 110, terminalMode: 'citrus' },
  { id: 'gold', name: 'Gold', accent: '#fbbf24', from: [28, 56, 15], to: [45, 62, 27], sidebar: [34, 46, 14], angle: 100, terminalMode: 'warm' },
  // Warm / reds
  { id: 'sunset', name: 'Sunset', accent: '#ff8a3d', from: [12, 62, 17], to: [330, 54, 28], sidebar: [8, 50, 15], angle: 115, terminalMode: 'sunset' },
  { id: 'ember', name: 'Ember', accent: '#ff5f52', from: [0, 58, 15], to: [16, 58, 27], sidebar: [358, 48, 14], angle: 100, terminalMode: 'ember' },
  { id: 'rose', name: 'Rose', accent: '#ff5c9c', from: [336, 54, 16], to: [352, 52, 28], sidebar: [338, 44, 15], angle: 100, terminalMode: 'rose' },
  // Pinks / purples
  { id: 'bubblegum', name: 'Bubblegum', accent: '#f472d0', from: [302, 56, 16], to: [268, 56, 29], sidebar: [296, 46, 15], angle: 120, terminalMode: 'grape' },
  { id: 'lavender', name: 'Lavender', accent: '#a78bfa', from: [252, 52, 17], to: [274, 54, 29], sidebar: [256, 44, 16], angle: 100, terminalMode: 'violet' },
  { id: 'cosmos', name: 'Cosmos', accent: '#c084fc', from: [240, 64, 14], to: [292, 58, 27], sidebar: [248, 52, 14], angle: 135, terminalMode: 'abyss' },
  { id: 'synthwave', name: 'Synthwave', accent: '#ff3fd8', from: [268, 72, 16], to: [192, 78, 26], sidebar: [270, 58, 13], angle: 125, terminalMode: 'neon' },
  // Neutrals
  { id: 'nord', name: 'Nord', accent: '#88c0d0', from: [220, 17, 24], to: [219, 21, 34], sidebar: [220, 16, 22], angle: 100, terminalMode: 'nord' },
  { id: 'graphite', name: 'Graphite', accent: '#b0b8c4', from: [220, 6, 18], to: [220, 7, 28], sidebar: [220, 5, 17], angle: 100, terminalMode: 'mono' },
  // Light
  { id: 'latte', name: 'Latte', accent: '#e2691a', from: [32, 48, 92], to: [18, 44, 85], sidebar: [30, 38, 94], angle: 105, terminalMode: 'latte' },
  { id: 'arctic', name: 'Arctic', accent: '#0ea5e9', from: [205, 48, 94], to: [193, 42, 86], sidebar: [205, 40, 96], angle: 105, terminalMode: 'frost' },
]

export const PRESET_THEMES: PresetTheme[] = PRESET_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  window: buildChrome(spec.accent, spec.from, spec.to, spec.sidebar, spec.angle),
  terminalMode: spec.terminalMode,
  terminal: TERMINAL_THEMES[spec.terminalMode],
}))

/** Vivid accents for the "generate from color" quick picks. */
export const ACCENT_SWATCHES = [
  '#4c9eff', '#22d3ee', '#2ee6ac', '#4ade80', '#b8e63c', '#fbbf24',
  '#ff8a3d', '#ff5f52', '#ff5c9c', '#f472d0', '#a78bfa', '#c084fc',
  '#ff3fd8', '#88c0d0', '#b0b8c4', '#e2691a',
]

// --- Emoji set ---

export const PROJECT_EMOJIS = [
  '🚀', '⚡', '🔥', '💎', '🌊', '🌲', '🎯', '🔮',
  '🎨', '🏗️', '🔧', '🧪', '📦', '🎸', '🌙', '☀️',
  '🌈', '❄️', '🍀', '🦊', '🐙', '🦀', '🐍', '🦅',
  '💜', '💙', '💚', '💛', '🧡', '❤️', '🤖', '👾',
  '🎮', '📡', '🔑', '⭐', '🌸', '🍊', '🫐', '🍋',
  '🎵', '🌴', '🦋',
]
