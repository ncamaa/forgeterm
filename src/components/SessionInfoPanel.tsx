import { useState } from 'react'
import type { Session } from '../store/sessionStore'
import { PeerNameBadge } from './PeerNameBadge'
import type { SessionTimelineEntry } from '../../shared/types'

interface SessionInfoPanelProps {
  session: Session
  accentColor: string
  onClose: () => void
  onResume: (conversationId: string, name: string) => void
  onResumeInPlace: (sessionId: string) => void
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  if (isYesterday) return `Yesterday ${time}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

export function SessionInfoPanel({ session, accentColor, onClose, onResume, onResumeInPlace }: SessionInfoPanelProps) {
  const info = session.info
  const timeline = info?.timeline ?? []
  const conversationId = session.conversationId
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!conversationId) return
    navigator.clipboard.writeText(conversationId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="session-info-panel">
      <div className="session-info-panel-header">
        <div className="session-info-panel-title">{info?.title || session.name}</div>
        {session.peerName && <PeerNameBadge name={session.peerName} />}
        <button className="session-info-panel-close" onClick={onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {conversationId && (
        <div className="session-info-panel-conversation">
          <div className="session-info-panel-label">Claude conversation</div>
          <div className="session-info-panel-conversation-row">
            <code
              className="session-info-panel-conversation-id"
              title={copied ? 'Copied!' : 'Click to copy conversation ID'}
              onClick={handleCopy}
            >
              {copied ? 'Copied!' : conversationId}
            </code>
            {session.running ? (
              <button
                className="session-info-panel-resume"
                style={{ background: accentColor }}
                onClick={() => onResume(conversationId, session.name)}
                title="Open a new session resuming this Claude conversation"
              >
                Resume in new session
              </button>
            ) : (
              <button
                className="session-info-panel-resume"
                style={{ background: accentColor }}
                onClick={() => onResumeInPlace(session.id)}
                title="Start this session, resuming the Claude conversation"
              >
                Resume session
              </button>
            )}
          </div>
        </div>
      )}

      {info ? (
        <>
          <div className="session-info-panel-current">
            <div className="session-info-panel-summary">{info.summary}</div>
            <div className="session-info-panel-section">
              <div className="session-info-panel-label">Last action</div>
              <div className="session-info-panel-text">{info.lastAction}</div>
            </div>
            {info.actionItem && (
              <div className="session-info-panel-action">
                <span className="session-info-panel-action-badge" style={{ background: accentColor }}>Action needed</span>
                {info.actionItem}
              </div>
            )}
            {session.contextPercent != null && (
              <div className="session-info-panel-context">
                <div className="session-info-panel-context-bar">
                  <div
                    className="session-info-panel-context-fill"
                    style={{
                      width: `${session.contextPercent}%`,
                      background: session.contextPercent > 80 ? '#f87171' : session.contextPercent > 60 ? '#fbbf24' : accentColor,
                    }}
                  />
                </div>
                <span className="session-info-panel-context-label">{session.contextPercent}% context</span>
              </div>
            )}
          </div>

          {timeline.length > 0 && (
            <div className="session-info-panel-timeline">
              <div className="session-info-panel-label">Timeline</div>
              <div className="session-info-panel-timeline-list">
                {[...timeline].reverse().map((entry: SessionTimelineEntry, i: number) => (
                  <div key={entry.timestamp} className="timeline-entry">
                    <div className="timeline-dot" style={{ background: i === 0 ? accentColor : '#475569' }} />
                    {i < timeline.length - 1 && <div className="timeline-line" />}
                    <div className="timeline-content">
                      <div className="timeline-time">{formatTimestamp(entry.timestamp)}</div>
                      <div className="timeline-action">{entry.lastAction}</div>
                      {entry.actionItem && (
                        <div className="timeline-action-item">{entry.actionItem}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="session-info-panel-empty">
          <div className="session-info-panel-empty-text">No activity reported yet</div>
          <div className="session-info-panel-empty-hint">
            Activity will appear here as the agent works
          </div>
        </div>
      )}
    </div>
  )
}
