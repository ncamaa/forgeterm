import { useState, useEffect, useCallback, useRef } from 'react'
import type { ForgeTermConfig, Workspace, SessionTemplate } from '../../shared/types'
import { parseCliList } from '../../shared/claudeCli'

interface SessionConfig {
  name: string
  command: string
  autoStart: boolean
}

interface ProjectSettingsProps {
  config: ForgeTermConfig | null
  accentColor: string
  projectName: string
  onSave: (config: ForgeTermConfig) => void
  onCancel: () => void
}

export function ProjectSettings({ config, accentColor, projectName, onSave, onCancel }: ProjectSettingsProps) {
  const [sessions, setSessions] = useState<SessionConfig[]>([])
  const [customName, setCustomName] = useState('')
  const [dragDropBehavior, setDragDropBehavior] = useState<'ask' | 'path' | 'content' | 'copy'>('ask')
  const [claudeCliName, setClaudeCliName] = useState('')
  const [claudeCliAlternates, setClaudeCliAlternates] = useState('')
  const [skipPermissions, setSkipPermissions] = useState(true)
  const [workspaceName, setWorkspaceName] = useState('')
  const [existingWorkspaces, setExistingWorkspaces] = useState<Workspace[]>([])
  const [showWorkspaceSuggestions, setShowWorkspaceSuggestions] = useState(false)
  const [sessionTemplates, setSessionTemplates] = useState<SessionTemplate[]>([])
  const [activeSessionSuggestion, setActiveSessionSuggestion] = useState<number | null>(null)
  const [showSessionSuggestions, setShowSessionSuggestions] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const wsInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCustomName(config?.projectName ?? '')
    setDragDropBehavior(config?.dragDropBehavior ?? 'ask')
    setClaudeCliName(config?.claudeCliName ?? '')
    setClaudeCliAlternates((config?.claudeCliAlternates ?? []).join(', '))
    setSkipPermissions(config?.dangerouslySkipPermissions ?? true)
    const configSessions = config?.sessions || []
    setSessions(
      configSessions.map((s) => ({
        name: s.name,
        command: s.command || '',
        autoStart: s.autoStart ?? true,
      })),
    )
    // Load workspace info
    Promise.all([
      window.forgeterm.getProjectPath(),
      window.forgeterm.getWorkspaces(),
    ]).then(([projectPath, workspaces]) => {
      setExistingWorkspaces(workspaces)
      const current = projectPath ? workspaces.find((ws) => ws.projects.includes(projectPath)) : undefined
      if (current) setWorkspaceName(current.name)
    })
    // Load session templates from all projects
    window.forgeterm.getAllSessionTemplates().then(setSessionTemplates)
  }, [config])

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const addSession = useCallback(() => {
    setSessions((prev) => [...prev, { name: '', command: '', autoStart: true }])
    setActiveSessionSuggestion(null)
  }, [])

  const removeSession = useCallback((index: number) => {
    setSessions((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const updateSession = useCallback((index: number, field: keyof SessionConfig, value: string | boolean) => {
    setSessions((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    )
    if (field === 'name' && typeof value === 'string') {
      setActiveSessionSuggestion(value.length > 0 ? index : null)
      setShowSessionSuggestions(value.length > 0)
    }
  }, [])

  const applyTemplate = useCallback((index: number, template: SessionTemplate) => {
    setSessions((prev) =>
      prev.map((s, i) =>
        i === index
          ? { ...s, name: template.name, command: template.command || '' }
          : s,
      ),
    )
    setActiveSessionSuggestion(null)
    setShowSessionSuggestions(false)
  }, [])

  const getFilteredTemplates = useCallback((query: string) => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    // Deduplicate by name+command, keep first occurrence
    const seen = new Set<string>()
    return sessionTemplates.filter((t) => {
      const key = `${t.name}::${t.command || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return t.name.toLowerCase().includes(q) || (t.command || '').toLowerCase().includes(q)
    })
  }, [sessionTemplates])

  const handleSave = useCallback(async () => {
    const validSessions = sessions.filter((s) => s.name.trim())
    const alternates = parseCliList(claudeCliAlternates)
    const updated: ForgeTermConfig = {
      ...config,
      projectName: customName.trim() || undefined,
      dragDropBehavior: dragDropBehavior === 'ask' ? undefined : dragDropBehavior,
      // Empty CLI name inherits the workspace/default ("claude"); skip-permissions
      // is stored explicitly so the project always overrides the workspace.
      claudeCliName: claudeCliName.trim() || undefined,
      // Empty list inherits the workspace's alternates, like the CLI name.
      claudeCliAlternates: alternates.length > 0 ? alternates : undefined,
      dangerouslySkipPermissions: skipPermissions,
      sessions: validSessions.map((s) => ({
        name: s.name.trim(),
        command: s.command.trim() || undefined,
        autoStart: s.autoStart,
      })),
    }
    // Save workspace association
    const projectPath = await window.forgeterm.getProjectPath()
    const trimmedWs = workspaceName.trim()
    if (projectPath) {
      if (trimmedWs) {
        await window.forgeterm.setProjectWorkspace(projectPath, trimmedWs)
      } else {
        await window.forgeterm.removeProjectFromWorkspace(projectPath)
      }
    }
    onSave(updated)
  }, [config, customName, dragDropBehavior, claudeCliName, claudeCliAlternates, skipPermissions, sessions, workspaceName, onSave])

  const filteredWorkspaces = existingWorkspaces.filter(
    (ws) => ws.name.toLowerCase().includes(workspaceName.toLowerCase()) && ws.name !== workspaceName,
  )

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal project-settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Project Settings</h3>

        <div className="form-field">
          <label>Project Name</label>
          <input
            ref={nameRef}
            type="text"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={projectName}
          />
        </div>

        <div className="form-field" style={{ position: 'relative' }}>
          <label>Workspace</label>
          <div className="workspace-input-row">
            <input
              ref={wsInputRef}
              type="text"
              value={workspaceName}
              onChange={(e) => {
                setWorkspaceName(e.target.value)
                setShowWorkspaceSuggestions(true)
              }}
              onFocus={() => setShowWorkspaceSuggestions(true)}
              onBlur={() => setTimeout(() => setShowWorkspaceSuggestions(false), 150)}
              placeholder="Type to join or create a workspace..."
            />
            {workspaceName && (
              <button
                className="workspace-clear-btn"
                onClick={() => setWorkspaceName('')}
                title="Remove from workspace"
                type="button"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M2 2l8 8M10 2l-8 8" />
                </svg>
              </button>
            )}
          </div>
          {showWorkspaceSuggestions && filteredWorkspaces.length > 0 && (
            <div className="workspace-suggestions">
              {filteredWorkspaces.map((ws) => (
                <div
                  key={ws.name}
                  className="workspace-suggestion"
                  onMouseDown={() => {
                    setWorkspaceName(ws.name)
                    setShowWorkspaceSuggestions(false)
                  }}
                >
                  <span className="workspace-suggestion-name">{ws.name}</span>
                  <span className="workspace-suggestion-count">
                    {ws.projects.length} project{ws.projects.length !== 1 ? 's' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="form-field">
          <label>Drag & Drop</label>
          <select
            className="drag-drop-select"
            value={dragDropBehavior}
            onChange={(e) => setDragDropBehavior(e.target.value as any)}
          >
            <option value="ask">Ask every time</option>
            <option value="path">Always paste path</option>
            <option value="content">Always paste content</option>
            <option value="copy">Always copy to project</option>
          </select>
        </div>

        <div className="form-field">
          <label>Claude CLI command</label>
          <input
            type="text"
            value={claudeCliName}
            onChange={(e) => setClaudeCliName(e.target.value)}
            placeholder="claude"
          />
          <input
            type="text"
            style={{ marginTop: 6 }}
            value={claudeCliAlternates}
            onChange={(e) => setClaudeCliAlternates(e.target.value)}
            placeholder="Other identities, e.g. claude-work, claude-admin"
            title="Extra Claude CLI names, comma or space separated. Each gets its own one-click Claude button."
          />
          <label className="checkbox-row" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={skipPermissions}
              onChange={(e) => setSkipPermissions(e.target.checked)}
            />
            <span>Skip permissions on resume (<code>--dangerously-skip-permissions</code>)</span>
          </label>
        </div>

        <div className="settings-section-title">Startup Sessions</div>
        <div className="session-configs">
          {sessions.map((session, i) => {
            const suggestions = activeSessionSuggestion === i && showSessionSuggestions
              ? getFilteredTemplates(session.name)
              : []
            return (
              <div key={i} className="session-config-row" style={{ position: 'relative' }}>
                <div className="session-config-fields">
                  <input
                    type="text"
                    value={session.name}
                    onChange={(e) => updateSession(i, 'name', e.target.value)}
                    onFocus={() => {
                      if (session.name.length > 0) {
                        setActiveSessionSuggestion(i)
                        setShowSessionSuggestions(true)
                      }
                    }}
                    onBlur={() => setTimeout(() => {
                      setActiveSessionSuggestion(null)
                      setShowSessionSuggestions(false)
                    }, 150)}
                    placeholder="Name"
                    className="session-config-input"
                    autoComplete="off"
                  />
                  <input
                    type="text"
                    value={session.command}
                    onChange={(e) => updateSession(i, 'command', e.target.value)}
                    placeholder="Command (optional)"
                    className="session-config-input"
                  />
                </div>
                <div className="session-config-right">
                  <label className="auto-start-toggle">
                    <input
                      type="checkbox"
                      checked={session.autoStart}
                      onChange={(e) => updateSession(i, 'autoStart', e.target.checked)}
                    />
                    <span>Auto</span>
                  </label>
                  <button
                    className="session-remove-btn"
                    onClick={() => removeSession(i)}
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M2 2l8 8M10 2l-8 8" />
                    </svg>
                  </button>
                </div>
                {suggestions.length > 0 && (
                  <div className="session-template-suggestions">
                    {suggestions.map((t, ti) => (
                      <div
                        key={ti}
                        className="session-template-suggestion"
                        onMouseDown={() => applyTemplate(i, t)}
                      >
                        <div className="session-template-main">
                          <span className="session-template-name">{t.name}</span>
                          {t.command && (
                            <span className="session-template-command">{t.command}</span>
                          )}
                        </div>
                        <span className="session-template-project">{t.projectName}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <button
          className="add-session-config-btn"
          onClick={addSession}
          style={{ color: accentColor }}
        >
          + Add Session
        </button>

        <div className="modal-actions">
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-create"
            style={{ backgroundColor: accentColor }}
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
