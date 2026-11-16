import { useState } from 'react'

// The Claude Code peer name other sessions use for this one ("Message from
// @hsp-37"). Click copies it without triggering the row's own click.
export function PeerNameBadge({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span
      className="peer-name-badge"
      title={copied ? 'Copied!' : `Claude peer name @${name} (click to copy)`}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(name).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }).catch(() => {})
      }}
    >
      {copied ? 'copied' : name}
    </span>
  )
}
