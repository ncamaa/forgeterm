import { create } from 'zustand'
import type { SessionActivityStatus, SessionActivitySignal, SessionContext } from '../../shared/types'

// dataTransfer type set while a sidebar session row is dragged to reorder, so other
// drop targets (the terminal's file drop) can tell it apart from external drags.
export const SESSION_DRAG_TYPE = 'application/x-forgeterm-session'

export interface Session {
  id: string
  name: string
  command?: string
  running: boolean
  activityStatus: SessionActivityStatus
  info?: SessionContext
  contextPercent?: number
  conversationId?: string
  // True once a precise activity signal (Claude hook / `ft activity`) has been
  // seen for this session. Disables the PTY-output heuristic so the two never fight.
  hookManaged?: boolean
}

interface SessionStore {
  sessions: Session[]
  activeSessionId: string | null
  // Transient signal: when set, the Sidebar opens inline rename for this session.
  renameRequestId: string | null
  addSession: (session: Omit<Session, 'activityStatus'>) => void
  removeSession: (id: string) => void
  setActive: (id: string) => void
  // Moves a session to `toIndex` in the list (sidebar drag reorder).
  moveSession: (id: string, toIndex: number) => void
  setRunning: (id: string, running: boolean) => void
  renameSession: (id: string, name: string) => void
  setSessionInfo: (id: string, info: SessionContext) => void
  setConversationId: (id: string, conversationId: string) => void
  setContextPercent: (id: string, percent: number) => void
  setActivityStatus: (id: string, status: SessionActivityStatus) => void
  markSessionWorking: (id: string) => void
  applyActivitySignal: (id: string, signal: SessionActivitySignal, viewing: boolean) => void
  requestRename: (id: string) => void
  clearRenameRequest: () => void
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  activeSessionId: null,
  renameRequestId: null,

  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, { ...session, activityStatus: 'idle' }],
      activeSessionId: state.activeSessionId ?? session.id,
    })),

  removeSession: (id) =>
    set((state) => {
      const idx = state.sessions.findIndex((s) => s.id === id)
      const sessions = state.sessions.filter((s) => s.id !== id)
      let activeSessionId = state.activeSessionId
      if (activeSessionId === id) {
        // Pick adjacent session: prefer next, fall back to previous
        const nextIdx = Math.min(idx, sessions.length - 1)
        activeSessionId = nextIdx >= 0 ? sessions[nextIdx].id : null
      }
      return { sessions, activeSessionId }
    }),

  setActive: (id) =>
    set((state) => ({
      activeSessionId: id,
      // Visiting a session clears the unread/needs-attention dot. A hook-managed
      // session that is actively working keeps its loading indicator (a later
      // 'done'/'attention' signal clears it); heuristic sessions clear on view.
      sessions: state.sessions.map((s) =>
        s.id === id && !(s.hookManaged && s.activityStatus === 'working')
          ? { ...s, activityStatus: 'idle' as const }
          : s,
      ),
    })),

  moveSession: (id, toIndex) =>
    set((state) => {
      const from = state.sessions.findIndex((s) => s.id === id)
      if (from < 0 || from === toIndex) return state
      const sessions = [...state.sessions]
      const [moved] = sessions.splice(from, 1)
      sessions.splice(toIndex, 0, moved)
      return { sessions }
    }),

  setRunning: (id, running) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, running } : s,
      ),
    })),

  renameSession: (id, name) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, name } : s,
      ),
    })),

  setSessionInfo: (id, info) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, info, contextPercent: info.contextPercent ?? s.contextPercent } : s,
      ),
    })),

  setConversationId: (id, conversationId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, conversationId } : s,
      ),
    })),

  setContextPercent: (id, percent) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, contextPercent: percent } : s,
      ),
    })),

  setActivityStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, activityStatus: status } : s,
      ),
    })),

  markSessionWorking: (id) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session || session.activityStatus === 'working') return state
      return {
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, activityStatus: 'working' as const } : s,
        ),
      }
    }),

  // Precise activity signal from a Claude hook / `ft activity`. Marks the
  // session hook-managed (disabling the PTY heuristic) and maps the signal to
  // a display status: 'done' clears to idle when you're viewing the session,
  // otherwise becomes 'unread'; 'attention' always becomes 'unread'.
  applyActivitySignal: (id, signal, viewing) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session) return state
      let status: SessionActivityStatus
      switch (signal) {
        case 'working': status = 'working'; break
        case 'done': status = viewing ? 'idle' : 'unread'; break
        case 'attention': status = 'unread'; break
        default: status = 'idle'
      }
      return {
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, activityStatus: status, hookManaged: true } : s,
        ),
      }
    }),

  requestRename: (id) => set({ renameRequestId: id }),
  clearRenameRequest: () => set({ renameRequestId: null }),
}))
