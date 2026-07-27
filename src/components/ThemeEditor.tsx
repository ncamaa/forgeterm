import { useState, useEffect, useCallback, useRef } from 'react'
import type { ForgeTermConfig, FavoriteTheme } from '../../shared/types'
import {
  ACCENT_SWATCHES,
  PRESET_THEMES,
  PROJECT_EMOJIS,
  TERMINAL_THEMES,
  accentGlow,
  generateWindowTheme,
  getTerminalTheme,
  titlebarGradient,
  type PresetTheme,
  type TerminalColors,
  type WindowTheme,
} from '../themes'

interface ThemeEditorProps {
  config: ForgeTermConfig | null
  onSave: (config: ForgeTermConfig) => void
  onCancel: () => void
  onPreview?: (windowTheme: WindowTheme | null) => void
}

interface ColorFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
}

function ColorField({ label, value, onChange }: ColorFieldProps) {
  const safeValue = value.startsWith('#') && (value.length === 7 || value.length === 4) ? value : '#000000'
  return (
    <div className="theme-field">
      <label>{label}</label>
      <div className="color-input-row">
        <input
          type="color"
          value={safeValue}
          onChange={(e) => onChange(e.target.value)}
          className="color-picker"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="color-text"
          spellCheck={false}
        />
      </div>
    </div>
  )
}

/** Miniature app window + the terminal's ANSI palette, so themes read apart at a glance. */
function ThemeSwatch({ w, terminal }: { w: WindowTheme; terminal: TerminalColors }) {
  return (
    <div className="theme-card-preview">
      <div className="tc-titlebar" style={{ background: titlebarGradient(w), borderBottomColor: w.accentColor }}>
        <span className="tc-dot" style={{ background: w.accentColor }} />
        <span className="tc-title-line" style={{ background: w.titlebarForeground }} />
      </div>
      <div className="tc-body">
        <div className="tc-sidebar" style={{ background: w.sidebarBackground }}>
          <div
            className="tc-session active"
            style={{ borderLeftColor: w.accentColor, background: w.buttonBackground }}
          />
          <div className="tc-session" style={{ background: w.buttonBackground, opacity: 0.4 }} />
          <div className="tc-session" style={{ background: w.buttonBackground, opacity: 0.4 }} />
        </div>
        <div className="tc-terminal" style={{ background: terminal.background }}>
          <span className="tc-line" style={{ background: terminal.green, width: '58%' }} />
          <span className="tc-line" style={{ background: terminal.foreground, width: '80%', opacity: 0.5 }} />
          <span className="tc-line" style={{ background: terminal.blue, width: '44%' }} />
        </div>
      </div>
      <div className="tc-swatches" style={{ background: terminal.background }}>
        {[terminal.red, terminal.yellow, terminal.green, terminal.cyan, terminal.blue, terminal.magenta].map(
          (c, i) => (
            <span key={i} className="tc-swatch" style={{ background: c }} />
          )
        )}
      </div>
    </div>
  )
}

function cardVars(accent: string, w?: WindowTheme): React.CSSProperties {
  return {
    '--card-accent': accent,
    '--card-glow': accentGlow(accent, 0.55),
    '--card-glow-soft': accentGlow(accent, 0.22),
    // Tinting the whole card with its own chrome is what makes themes
    // distinguishable at thumbnail size.
    ...(w ? { background: w.sidebarBackground, color: w.sidebarForeground } : {}),
  } as React.CSSProperties
}

function ThemeCard({
  theme,
  selected,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  theme: PresetTheme
  selected: boolean
  onClick: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  return (
    <button
      className={`theme-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={cardVars(theme.window.accentColor, theme.window)}
    >
      <ThemeSwatch w={theme.window} terminal={theme.terminal} />
      <span className="theme-card-name">{theme.name}</span>
    </button>
  )
}

function FavoriteCard({
  fav,
  selected,
  onClick,
  onDelete,
  onMouseEnter,
  onMouseLeave,
}: {
  fav: FavoriteTheme
  selected: boolean
  onClick: () => void
  onDelete: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const w = fav.window as WindowTheme
  const terminal = TERMINAL_THEMES[fav.terminalMode] || TERMINAL_THEMES.dark
  return (
    <button
      className={`theme-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={cardVars(w.accentColor, w)}
    >
      <ThemeSwatch w={w} terminal={terminal} />
      <span className="theme-card-name">
        {fav.name}
        <button
          className="fav-delete-btn"
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="Remove favorite"
        >
          x
        </button>
      </span>
    </button>
  )
}

function MiniPreview({ windowTheme, terminal }: { windowTheme: WindowTheme; terminal: TerminalColors }) {
  return (
    <div className="theme-preview" style={cardVars(windowTheme.accentColor)}>
      <div
        className="preview-titlebar"
        style={{ background: titlebarGradient(windowTheme), color: windowTheme.titlebarForeground }}
      >
        Project Name
      </div>
      <div className="preview-body">
        <div className="preview-sidebar" style={{ background: windowTheme.sidebarBackground, color: windowTheme.sidebarForeground }}>
          <div className="preview-session">
            <span className="preview-dot" style={{ background: windowTheme.accentColor }} />
            shell
          </div>
          <div className="preview-session active" style={{ borderLeftColor: windowTheme.accentColor, background: windowTheme.buttonBackground }}>
            <span className="preview-dot" style={{ background: windowTheme.accentColor }} />
            server
          </div>
          <div className="preview-btn" style={{ background: windowTheme.buttonBackground, color: windowTheme.sidebarForeground }}>
            + New
          </div>
        </div>
        <div className="preview-terminal" style={{ background: terminal.background, color: terminal.foreground }}>
          <div className="preview-term-line"><span style={{ color: terminal.green }}>$</span> <span style={{ color: terminal.foreground }}>pnpm dev</span></div>
          <div className="preview-term-line" style={{ color: terminal.cyan }}>ready in 240 ms</div>
          <div className="preview-term-line" style={{ color: terminal.magenta }}>http://localhost:5173</div>
          <div className="preview-term-palette">
            {[terminal.red, terminal.yellow, terminal.green, terminal.cyan, terminal.blue, terminal.magenta, terminal.white].map((c, i) => (
              <span key={i} className="preview-term-chip" style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ThemeEditor({ config, onSave, onCancel, onPreview }: ThemeEditorProps) {
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null)
  const [selectedFavorite, setSelectedFavorite] = useState<string | null>(null)
  const [terminalMode, setTerminalMode] = useState<string>('dark')
  const [emoji, setEmoji] = useState<string>('')
  const [generateColor, setGenerateColor] = useState('#38bdf8')
  const [showCustom, setShowCustom] = useState(false)
  const [favorites, setFavorites] = useState<FavoriteTheme[]>([])
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveName, setSaveName] = useState('')
  const saveInputRef = useRef<HTMLInputElement>(null)

  // Custom color state
  const [custom, setCustom] = useState<WindowTheme>({
    accentColor: '#38bdf8',
    titlebarBackground: '#0b1120',
    titlebarBackgroundEnd: '#111d33',
    titlebarForeground: '#8faabe',
    sidebarBackground: '#0c1322',
    sidebarForeground: '#8faabe',
    buttonBackground: '#172541',
  })

  // Load favorites on mount
  useEffect(() => {
    window.forgeterm.getFavoriteThemes().then(setFavorites)
  }, [])

  // Load from existing config
  useEffect(() => {
    const w = config?.window
    if (w?.themeName) {
      // Check if it's a favorite
      if (favorites.some((f) => f.name === w.themeName)) {
        setSelectedFavorite(w.themeName)
        setSelectedPreset(null)
      } else {
        setSelectedPreset(w.themeName)
      }
    }
    if (w?.emoji) setEmoji(w.emoji)
    if (config?.terminalTheme) setTerminalMode(config.terminalTheme)

    if (w) {
      setCustom({
        accentColor: w.accentColor ?? '#38bdf8',
        titlebarBackground: w.titlebarBackground ?? '#0b1120',
        titlebarBackgroundEnd: w.titlebarBackgroundEnd ?? '#111d33',
        titlebarForeground: w.titlebarForeground ?? '#8faabe',
        sidebarBackground: w.sidebarBackground ?? '#0c1322',
        sidebarForeground: w.sidebarForeground ?? '#8faabe',
        buttonBackground: w.buttonBackground ?? '#172541',
        gradientAngle: w.gradientAngle,
      })
    }
  }, [config, favorites])

  const activeTheme: WindowTheme = (() => {
    if (selectedPreset) {
      const preset = PRESET_THEMES.find((t) => t.id === selectedPreset)
      if (preset) return preset.window
    }
    if (selectedFavorite) {
      const fav = favorites.find((f) => f.name === selectedFavorite)
      if (fav) return fav.window as WindowTheme
    }
    return custom
  })()

  const terminalTheme = TERMINAL_THEMES[terminalMode] || TERMINAL_THEMES.dark

  // Send preview to parent and clear on unmount
  const sendPreview = useCallback((theme: WindowTheme | null) => {
    onPreview?.(theme)
  }, [onPreview])

  useEffect(() => {
    return () => sendPreview(null)
  }, [sendPreview])

  const handleSelectPreset = useCallback((theme: PresetTheme) => {
    setSelectedPreset(theme.id)
    setSelectedFavorite(null)
    setCustom({ ...theme.window })
    // A preset owns its terminal palette too - that is most of what makes it look different.
    setTerminalMode(theme.terminalMode)
    setShowCustom(false)
    sendPreview(null) // clear hover preview since we're committing
  }, [sendPreview])

  const handleSelectFavorite = useCallback((fav: FavoriteTheme) => {
    setSelectedFavorite(fav.name)
    setSelectedPreset(null)
    setCustom({ ...fav.window } as WindowTheme)
    setTerminalMode(fav.terminalMode)
    setShowCustom(false)
    sendPreview(null)
  }, [sendPreview])

  const handleDeleteFavorite = useCallback(async (name: string) => {
    await window.forgeterm.deleteFavoriteTheme(name)
    setFavorites((prev) => prev.filter((f) => f.name !== name))
    if (selectedFavorite === name) {
      setSelectedFavorite(null)
    }
  }, [selectedFavorite])

  const handleGenerateFromColor = useCallback((color: string) => {
    setGenerateColor(color)
    const generated = generateWindowTheme(color)
    setCustom(generated)
    setSelectedPreset(null)
    setSelectedFavorite(null)
  }, [])

  const updateCustomField = useCallback((field: keyof WindowTheme, value: string) => {
    setCustom((prev) => ({ ...prev, [field]: value }))
    setSelectedPreset(null)
    setSelectedFavorite(null)
  }, [])

  const handleSaveFavorite = useCallback(async () => {
    const name = saveName.trim()
    if (!name) return
    const theme: FavoriteTheme = {
      name,
      window: { ...activeTheme },
      terminalMode,
    }
    await window.forgeterm.saveFavoriteTheme(theme)
    setFavorites((prev) => {
      const filtered = prev.filter((f) => f.name !== name)
      return [...filtered, theme]
    })
    setSelectedFavorite(name)
    setSelectedPreset(null)
    setShowSaveDialog(false)
    setSaveName('')
  }, [saveName, activeTheme, terminalMode])

  // Focus save input when dialog opens
  useEffect(() => {
    if (showSaveDialog) {
      setTimeout(() => saveInputRef.current?.focus(), 50)
    }
  }, [showSaveDialog])

  const handleSave = useCallback(() => {
    const terminal = getTerminalTheme(terminalMode)
    // Override terminal cursor with accent color
    terminal.cursor = activeTheme.accentColor

    const updated: ForgeTermConfig = {
      ...config,
      theme: terminal,
      terminalTheme: terminalMode,
      window: {
        ...activeTheme,
        emoji: emoji || undefined,
        themeName: selectedPreset ?? selectedFavorite ?? undefined,
      },
    }
    onSave(updated)
  }, [config, activeTheme, terminalMode, emoji, selectedPreset, selectedFavorite, onSave])

  // Live preview handlers for hover
  const handlePresetHover = useCallback((theme: PresetTheme) => {
    sendPreview(theme.window)
  }, [sendPreview])

  const handleFavoriteHover = useCallback((fav: FavoriteTheme) => {
    sendPreview(fav.window as WindowTheme)
  }, [sendPreview])

  const handleHoverLeave = useCallback(() => {
    sendPreview(null)
  }, [sendPreview])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal theme-editor-modal" onClick={(e) => e.stopPropagation()} style={cardVars(activeTheme.accentColor)}>
        <div className="theme-editor-head">
          <h3>Customize Theme</h3>
          <MiniPreview windowTheme={activeTheme} terminal={terminalTheme} />
        </div>

        <div className="theme-editor-body">
        {/* Preset Themes */}
        <div className="theme-section">
          <div className="theme-section-title">Themes</div>
          <div className="theme-grid">
            {PRESET_THEMES.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                selected={selectedPreset === theme.id}
                onClick={() => handleSelectPreset(theme)}
                onMouseEnter={() => handlePresetHover(theme)}
                onMouseLeave={handleHoverLeave}
              />
            ))}
          </div>
        </div>

        {/* Emoji */}
        <div className="theme-section">
          <div className="theme-section-title">Project Icon</div>
          <div className="emoji-grid">
            <button
              className={`emoji-btn ${emoji === '' ? 'selected' : ''}`}
              onClick={() => setEmoji('')}
              title="No icon"
            >
              <span className="emoji-none">-</span>
            </button>
            {PROJECT_EMOJIS.map((e) => (
              <button
                key={e}
                className={`emoji-btn ${emoji === e ? 'selected' : ''}`}
                onClick={() => setEmoji(e)}
                style={emoji === e ? { borderColor: activeTheme.accentColor } : undefined}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Favorite Themes */}
        {favorites.length > 0 && (
          <div className="theme-section">
            <div className="theme-section-title">Favorites</div>
            <div className="theme-grid">
              {favorites.map((fav) => (
                <FavoriteCard
                  key={fav.name}
                  fav={fav}
                  selected={selectedFavorite === fav.name}
                  onClick={() => handleSelectFavorite(fav)}
                  onDelete={() => handleDeleteFavorite(fav.name)}
                  onMouseEnter={() => handleFavoriteHover(fav)}
                  onMouseLeave={handleHoverLeave}
                />
              ))}
            </div>
          </div>
        )}

        {/* Generate from color */}
        <div className="theme-section">
          <div className="theme-section-title">Generate from Color</div>
          <div className="generate-row">
            <input
              type="color"
              value={generateColor}
              onChange={(e) => handleGenerateFromColor(e.target.value)}
              className="color-picker generate-picker"
            />
            <div className="accent-swatch-row">
              {ACCENT_SWATCHES.map((c) => (
                <button
                  key={c}
                  className={`accent-swatch ${generateColor.toLowerCase() === c ? 'selected' : ''}`}
                  style={{ background: c, '--card-glow': accentGlow(c, 0.7) } as React.CSSProperties}
                  title={c}
                  onClick={() => handleGenerateFromColor(c)}
                />
              ))}
            </div>
          </div>
          <span className="generate-label">Pick any color to auto-generate matching window chrome</span>
        </div>

        {/* Terminal mode */}
        <div className="theme-section">
          <div className="theme-section-title">Terminal Palette</div>
          <div className="terminal-mode-row">
            {Object.entries(TERMINAL_THEMES).map(([id, theme]) => (
              <button
                key={id}
                className={`terminal-mode-btn ${terminalMode === id ? 'active' : ''}`}
                onClick={() => setTerminalMode(id)}
                style={cardVars(activeTheme.accentColor)}
              >
                <span className="mode-swatch" style={{ background: theme.background }}>
                  {[theme.red, theme.green, theme.blue, theme.magenta].map((c, i) => (
                    <span key={i} className="mode-swatch-dot" style={{ background: c }} />
                  ))}
                </span>
                {id.charAt(0).toUpperCase() + id.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Custom colors */}
        <div className="theme-section">
          <button
            className="custom-toggle"
            onClick={() => setShowCustom(!showCustom)}
          >
            <span className={`custom-arrow ${showCustom ? 'open' : ''}`}>&#9654;</span>
            <span className="theme-section-title" style={{ margin: 0 }}>Custom Colors</span>
          </button>
          {showCustom && (
            <div className="custom-fields">
              <ColorField label="Accent Color" value={custom.accentColor} onChange={(v) => updateCustomField('accentColor', v)} />
              <ColorField label="Titlebar Start" value={custom.titlebarBackground} onChange={(v) => updateCustomField('titlebarBackground', v)} />
              <ColorField label="Titlebar End" value={custom.titlebarBackgroundEnd} onChange={(v) => updateCustomField('titlebarBackgroundEnd', v)} />
              <ColorField label="Titlebar Text" value={custom.titlebarForeground} onChange={(v) => updateCustomField('titlebarForeground', v)} />
              <ColorField label="Sidebar Background" value={custom.sidebarBackground} onChange={(v) => updateCustomField('sidebarBackground', v)} />
              <ColorField label="Sidebar Text" value={custom.sidebarForeground} onChange={(v) => updateCustomField('sidebarForeground', v)} />
              <ColorField label="Button Background" value={custom.buttonBackground} onChange={(v) => updateCustomField('buttonBackground', v)} />
            </div>
          )}
        </div>
        </div>

        {/* Save as favorite dialog */}
        {showSaveDialog && (
          <div className="save-favorite-dialog">
            <input
              ref={saveInputRef}
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveFavorite(); if (e.key === 'Escape') setShowSaveDialog(false) }}
              placeholder="Theme name..."
              className="save-favorite-input"
              spellCheck={false}
            />
            <button
              className="btn-create btn-save-fav"
              style={{ backgroundColor: activeTheme.accentColor }}
              onClick={handleSaveFavorite}
              disabled={!saveName.trim()}
            >
              Save
            </button>
            <button className="btn-cancel" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </button>
          </div>
        )}

        <div className="modal-actions theme-editor-actions">
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-save-favorite"
            onClick={() => setShowSaveDialog(true)}
            title="Save current theme as a favorite"
          >
            Save as Favorite
          </button>
          <button
            type="button"
            className="btn-create"
            style={{
              backgroundColor: activeTheme.accentColor,
              boxShadow: `0 0 18px ${accentGlow(activeTheme.accentColor, 0.5)}`,
            }}
            onClick={handleSave}
          >
            Apply Theme
          </button>
        </div>
      </div>
    </div>
  )
}
