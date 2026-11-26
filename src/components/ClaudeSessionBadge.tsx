import type { CSSProperties } from 'react'
import {
  friendlyModelName,
  modelColor,
  resolveIdentityBadge,
  type ClaudeIdentityBadgeOverrides,
} from '../../shared/claudeBadge'

// Status-line style "which Claude is this": a filled identity chip (`HSP`) and
// the model in its family color (`Opus 5.5`). `stale` dims it for a stopped
// session, which shows what it last ran.
export function ClaudeSessionBadge({
  identity,
  model,
  overrides,
  stale,
}: {
  identity: string
  model?: string
  overrides: ClaudeIdentityBadgeOverrides
  stale?: boolean
}) {
  const chip = resolveIdentityBadge(identity, overrides)
  const modelName = model ? friendlyModelName(model) : null
  const title = [
    `Claude identity: ${identity === 'default' ? '~/.claude' : `~/.claude-${identity}`}`,
    model ? `Model: ${model}` : null,
    stale ? '(last seen; session stopped)' : null,
  ].filter(Boolean).join('\n')
  return (
    <span className={`claude-session-badge${stale ? ' stale' : ''}`} title={title}>
      <span className="claude-identity-chip" style={{ background: chip.color, color: chip.textColor }}>
        {chip.label}
      </span>
      {modelName && (
        <span className="claude-model-label" style={{ '--model-color': modelColor(model!) } as CSSProperties}>
          {modelName}
        </span>
      )}
    </span>
  )
}
