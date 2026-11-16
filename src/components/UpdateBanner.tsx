import { useEffect, useState, useCallback } from 'react'
import type { UpdateInfo } from '../../shared/types'

interface UpdateBannerProps {
  accentColor: string
}

export function UpdateBanner({ accentColor }: UpdateBannerProps) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [installing, setInstalling] = useState(false)
  const [upToDate, setUpToDate] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    window.forgeterm.getLastUpdateCheck().then((info) => {
      if (info?.available) setUpdate(info)
    })
    return window.forgeterm.onUpdateAvailable((info) => {
      if (info.available) {
        setUpdate(info)
        setDismissed(false)
        setUpToDate(false)
      }
    })
  }, [])

  // Listen for manual check results (from menu "Check for Updates...")
  useEffect(() => {
    return window.forgeterm.onUpdateCheckResult((info) => {
      setCheckError(null)
      if (info.available) {
        setUpdate(info)
        setDismissed(false)
        setUpToDate(false)
      } else if (info.error) {
        setUpdate(null)
        setUpToDate(false)
        setCheckError(info.error)
      } else {
        setUpdate(null)
        setUpToDate(true)
        setTimeout(() => setUpToDate(false), 5000)
      }
    })
  }, [])

  // Listen for download progress
  useEffect(() => {
    return window.forgeterm.onDownloadProgress(({ progress }) => {
      if (progress >= 0) setDownloadProgress(progress)
    })
  }, [])

  // Close menu when clicking outside
  useEffect(() => {
    if (!showMenu) return
    const handler = () => setShowMenu(false)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [showMenu])

  const handleInstall = useCallback(async () => {
    setDownloading(true)
    setDownloadProgress(0)
    try {
      await window.forgeterm.downloadUpdate()
      setDownloading(false)
      setInstalling(true)
      window.forgeterm.installUpdate()
    } catch {
      setDownloading(false)
    }
  }, [])

  const handleCopyCommand = useCallback(async () => {
    const cmd = await window.forgeterm.getUpdateCommand()
    if (cmd) {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    setShowMenu(false)
  }, [])

  const handleDownload = useCallback(() => {
    if (update?.releaseUrl) {
      window.forgeterm.openExternal(update.releaseUrl)
    }
    setShowMenu(false)
  }, [update])

  // "Couldn't check" banner
  if (checkError) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '5px 14px',
          background: 'rgba(248, 113, 113, 0.06)',
          borderBottom: '1px solid rgba(248, 113, 113, 0.12)',
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ color: '#f87171', flex: 1 }}>
          Couldn't check for updates: {checkError}
        </span>
        <button
          onClick={() => setCheckError(null)}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(248, 113, 113, 0.6)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 2px',
            lineHeight: 1,
          }}
          title="Dismiss"
        >
          x
        </button>
      </div>
    )
  }

  // "You're up to date" banner
  if (upToDate) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '5px 14px',
          background: 'rgba(74, 222, 128, 0.06)',
          borderBottom: '1px solid rgba(74, 222, 128, 0.12)',
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span style={{ color: '#4ade80', flex: 1 }}>
          You're up to date! Running the latest version.
        </span>
        <button
          onClick={() => setUpToDate(false)}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(74, 222, 128, 0.5)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 2px',
            lineHeight: 1,
          }}
          title="Dismiss"
        >
          x
        </button>
      </div>
    )
  }

  if (!update?.available || dismissed) return null

  const hasDmg = !!update.dmgUrl
  const busy = downloading || installing

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 14px',
        background: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      <span style={{ color: 'rgba(255,255,255,0.7)', flex: 1 }}>
        ForgeTerm <strong>v{update.latestVersion}</strong> is available
        {' '}
        <span style={{ opacity: 0.5 }}>(current: v{update.currentVersion})</span>
      </span>

      {busy ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {downloading && (
            <>
              <div
                style={{
                  width: 80,
                  height: 4,
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${downloadProgress}%`,
                    height: '100%',
                    background: accentColor,
                    borderRadius: 2,
                    transition: 'width 0.2s ease',
                  }}
                />
              </div>
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                Downloading {downloadProgress}%
              </span>
            </>
          )}
          {installing && (
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
              Installing... app will restart
            </span>
          )}
        </div>
      ) : (
        <div style={{ position: 'relative', display: 'flex', gap: 4, alignItems: 'center' }}>
          {/* Primary button */}
          <button
            onClick={hasDmg ? handleInstall : handleDownload}
            style={{
              background: accentColor,
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {hasDmg ? 'Update now' : 'Download'}
          </button>

          {/* Dropdown arrow for extra options */}
          {hasDmg && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowMenu(!showMenu)
              }}
              style={{
                background: 'rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.5)',
                border: 'none',
                borderRadius: 4,
                padding: '3px 5px',
                fontSize: 10,
                cursor: 'pointer',
                lineHeight: 1,
              }}
              title="More options"
            >
              ▾
            </button>
          )}

          {/* Dropdown menu */}
          {showMenu && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 4,
                background: '#2a2a2a',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                padding: 4,
                zIndex: 100,
                minWidth: 160,
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              }}
            >
              <button
                onClick={handleCopyCommand}
                style={{
                  display: 'block',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.8)',
                  padding: '6px 10px',
                  fontSize: 11,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                {copied ? 'Copied!' : 'Copy update command'}
              </button>
              <button
                onClick={handleDownload}
                style={{
                  display: 'block',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.8)',
                  padding: '6px 10px',
                  fontSize: 11,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                View release on GitHub
              </button>
            </div>
          )}
        </div>
      )}

      {!busy && (
        <button
          onClick={() => setDismissed(true)}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.35)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 2px',
            lineHeight: 1,
          }}
          title="Dismiss"
        >
          x
        </button>
      )}
    </div>
  )
}
