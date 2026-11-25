import { useState, useCallback, useMemo } from 'react'
import type { Workspace, RecentProject } from '../../shared/types'
import { PROJECT_EMOJIS } from '../themes'
import { parseCliList } from '../../shared/claudeCli'

interface EditWorkspaceModalProps {
  workspace: Workspace
  accentColor: string
  projects: RecentProject[]
  onSave: (updated: Workspace) => void
  onDelete: () => void
  onCancel: () => void
}

export function EditWorkspaceModal({
  workspace,
  accentColor,
  projects,
  onSave,
  onDelete,
  onCancel,
}: EditWorkspaceModalProps) {
  const [name, setName] = useState(workspace.name)
  const [emoji, setEmoji] = useState(workspace.emoji || '')
  const [wsAccentColor, setWsAccentColor] = useState(workspace.accentColor || '')
  const [description, setDescription] = useState(workspace.description || '')
  const [wsProjects, setWsProjects] = useState<string[]>([...workspace.projects])
  const [defaultCommand, setDefaultCommand] = useState(workspace.defaultCommand || '')
  const [wsClaudeCliName, setWsClaudeCliName] = useState(workspace.claudeCliName || '')
  const [wsClaudeCliAlternates, setWsClaudeCliAlternates] = useState((workspace.claudeCliAlternates ?? []).join(', '))
  const [wsSkipPermissions, setWsSkipPermissions] = useState(workspace.dangerouslySkipPermissions ?? true)
  const [addProjectFilter, setAddProjectFilter] = useState('')
  const [showAddSuggestions, setShowAddSuggestions] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.path, p])), [projects])

  const availableProjects = useMemo(() => {
    const inWs = new Set(wsProjects)
    return projects.filter((p) => !inWs.has(p.path))
  }, [projects, wsProjects])

  const filteredAvailable = useMemo(() => {
    if (!addProjectFilter.trim()) return availableProjects.slice(0, 10)
    const q = addProjectFilter.toLowerCase()
    return availableProjects
      .filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .slice(0, 10)
  }, [availableProjects, addProjectFilter])

  const removeProject = useCallback((path: string) => {
    setWsProjects((prev) => prev.filter((p) => p !== path))
  }, [])

  const addProject = useCallback((path: string) => {
    setWsProjects((prev) => [...prev, path])
    setAddProjectFilter('')
    setShowAddSuggestions(false)
  }, [])

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    const alternates = parseCliList(wsClaudeCliAlternates)

    // Rename if name changed
    if (trimmedName !== workspace.name) {
      await window.forgeterm.renameWorkspace(workspace.name, trimmedName)
    }

    // Update workspace properties
    await window.forgeterm.updateWorkspace(trimmedName, {
      emoji: emoji || undefined,
      description: description.trim() || undefined,
      accentColor: wsAccentColor.trim() || undefined,
      defaultCommand: defaultCommand.trim() || undefined,
      // Empty string clears the override; the handler maps it back to undefined.
      claudeCliName: wsClaudeCliName.trim(),
      // Empty list clears the alternates (the handler stores undefined).
      claudeCliAlternates: alternates,
      dangerouslySkipPermissions: wsSkipPermissions,
    })

    // Sync projects: remove old, add new
    const oldSet = new Set(workspace.projects)
    const newSet = new Set(wsProjects)
    for (const p of workspace.projects) {
      if (!newSet.has(p)) {
        await window.forgeterm.removeProjectFromWorkspace(p)
      }
    }
    for (const p of wsProjects) {
      if (!oldSet.has(p)) {
        await window.forgeterm.addProjectToWorkspace(trimmedName, p)
      }
    }

    // Reorder
    await window.forgeterm.reorderWorkspaceProjects(trimmedName, wsProjects)

    onSave({
      ...workspace,
      name: trimmedName,
      emoji: emoji || undefined,
      description: description.trim() || undefined,
      accentColor: wsAccentColor.trim() || undefined,
      defaultCommand: defaultCommand.trim() || undefined,
      claudeCliName: wsClaudeCliName.trim() || undefined,
      claudeCliAlternates: alternates.length > 0 ? alternates : undefined,
      dangerouslySkipPermissions: wsSkipPermissions,
      projects: wsProjects,
    })
  }, [name, emoji, wsAccentColor, description, defaultCommand, wsClaudeCliName, wsClaudeCliAlternates, wsSkipPermissions, wsProjects, workspace, onSave])

  const resolvedAccent = wsAccentColor || accentColor

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal edit-workspace-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {emoji && <span>{emoji}</span>}
          Edit Workspace
        </h3>

        <div className="form-field">
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
          />
        </div>

        <div className="form-field">
          <label>Emoji</label>
          <div className="ws-emoji-grid">
            <button
              className={`ws-emoji-btn ${!emoji ? 'selected' : ''}`}
              onClick={() => setEmoji('')}
              style={!emoji ? { borderColor: resolvedAccent } : undefined}
              title="None"
            >
              -
            </button>
            {PROJECT_EMOJIS.map((e) => (
              <button
                key={e}
                className={`ws-emoji-btn ${emoji === e ? 'selected' : ''}`}
                onClick={() => setEmoji(e)}
                style={emoji === e ? { borderColor: resolvedAccent } : undefined}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div className="form-field">
          <label>Accent Color</label>
          <div className="ws-color-row">
            <div
              className="ws-color-swatch"
              style={{ background: wsAccentColor || accentColor }}
            />
            <input
              type="text"
              value={wsAccentColor}
              onChange={(e) => setWsAccentColor(e.target.value)}
              placeholder={accentColor}
              style={{ flex: 1 }}
            />
          </div>
        </div>

        <div className="form-field">
          <label>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional notes about this workspace..."
            rows={2}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '6px',
              color: '#f1f5f9',
              fontSize: '13px',
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <div className="ws-description-hint">Shown under the workspace name in the project switcher</div>
        </div>

        <div className="settings-section-title">Projects</div>
        <div className="ws-project-chips">
          {wsProjects.map((p) => {
            const proj = projectMap.get(p)
            return (
              <span key={p} className="ws-project-chip">
                {proj?.emoji ? `${proj.emoji} ` : ''}{proj?.name || p.split('/').pop()}
                <button
                  className="ws-chip-remove"
                  onClick={() => removeProject(p)}
                  title="Remove from workspace"
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              </span>
            )
          })}
        </div>
        <div className="ws-add-project-row">
          <input
            type="text"
            value={addProjectFilter}
            onChange={(e) => {
              setAddProjectFilter(e.target.value)
              setShowAddSuggestions(true)
            }}
            onFocus={() => setShowAddSuggestions(true)}
            onBlur={() => setTimeout(() => setShowAddSuggestions(false), 150)}
            placeholder="Add project..."
          />
          {showAddSuggestions && filteredAvailable.length > 0 && (
            <div className="ws-project-suggestions">
              {filteredAvailable.map((p) => (
                <div
                  key={p.path}
                  className="ws-project-suggestion"
                  onMouseDown={() => addProject(p.path)}
                >
                  {p.emoji ? `${p.emoji} ` : ''}{p.name}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
                    {p.path.split('/').slice(-2).join('/')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="form-field" style={{ marginTop: 16 }}>
          <label>Default Command</label>
          <input
            type="text"
            value={defaultCommand}
            onChange={(e) => setDefaultCommand(e.target.value)}
            placeholder="e.g. git pull"
          />
          <div className="ws-description-hint">Runs in each project's first session when workspace opens</div>
        </div>

        <div className="form-field" style={{ marginTop: 16 }}>
          <label>Claude CLI command</label>
          <input
            type="text"
            value={wsClaudeCliName}
            onChange={(e) => setWsClaudeCliName(e.target.value)}
            placeholder="claude"
          />
          <div className="ws-description-hint">Used for Claude resumes in this workspace's projects (e.g. claude-hsp)</div>
          <input
            type="text"
            style={{ marginTop: 6 }}
            value={wsClaudeCliAlternates}
            onChange={(e) => setWsClaudeCliAlternates(e.target.value)}
            placeholder="Other identities, e.g. claude-work, claude-admin"
          />
          <div className="ws-description-hint">Extra Claude CLI names, comma separated. Each gets its own one-click Claude button.</div>
          <label style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={wsSkipPermissions}
              onChange={(e) => setWsSkipPermissions(e.target.checked)}
            />
            <span>Skip permissions on resume (<code>--dangerously-skip-permissions</code>)</span>
          </label>
        </div>

        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
          <button
            type="button"
            className="btn-cancel"
            style={{ color: '#f87171' }}
            onClick={() => setShowDeleteConfirm(true)}
          >
            Delete
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-create"
              style={{ backgroundColor: resolvedAccent }}
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="modal-overlay confirm-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete workspace?</h3>
            <p className="confirm-text">
              This will delete the "{workspace.name}" workspace. The projects inside will remain in your project list.
            </p>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button
                className="btn-create"
                style={{ background: '#f87171' }}
                onClick={onDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
