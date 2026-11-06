// Issue 110: the human terminal pane (decision #59). xterm.js renders; a
// desktop-local PTY in the Electron main provides the real terminal semantics
// (input, resize, process exit, kill). The pane touches only the minimal
// terminal bridge (window.ideerTerminal) — terminal output is content, not
// trusted UI, and never crosses the trusted desktop:* bridge
// (test/security.test.ts pins the module graph). Behavior reference: the
// pinned linz TerminalPanel (xterm UI, debounced resize-on-fit, exit notice,
// kill on unmount), with a new desktop-owned IPC shape.
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalSessionStore } from '../../stores/terminalSessions'

export default function TerminalPane({ instanceId }: {
  instanceId: string
  panelType: string
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // One session per mounted instance: the overlay keeps instances mounted
  // across tab/pane moves, so the session survives repositioning and dies
  // only when the instance leaves the layout (or the window goes away).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC', selectionBackground: '#585B70' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    let disposed = false
    let sessionId: string | null = null
    // Keystrokes ride the same content bridge; before the spawn resolves
    // there is nowhere to send them, matching the linz behavior. Rejections
    // (a dying session, an oversized paste) are not actionable here — the
    // exit/notice path owns the visible state.
    term.onData((data) => {
      if (sessionId) void window.ideerTerminal.write(sessionId, data).catch(() => {})
    })
    const unsubscribeData = window.ideerTerminal.onData((event) => {
      if (event.sessionId === sessionId) term.write(event.data)
    })
    const unsubscribeExit = window.ideerTerminal.onExit((event) => {
      if (event.sessionId !== sessionId) return
      term.write(`\r\n\x1b[33m[进程已退出，代码 ${event.exitCode}]\x1b[0m\r\n`)
      useTerminalSessionStore.getState().markExited(instanceId)
    })

    const spawn = async (): Promise<void> => {
      try {
        // No arguments: the start dir is resolved in the trusted main process
        // (bound workspace folder, user home fallback) — the renderer never
        // supplies a path or a command.
        const view = await window.ideerTerminal.spawn()
        if (disposed) {
          void window.ideerTerminal.kill(view.sessionId).catch(() => {})
          return
        }
        sessionId = view.sessionId
        useTerminalSessionStore.getState().register(instanceId, view.sessionId)
        fit.fit()
        void window.ideerTerminal.resize(view.sessionId, term.cols, term.rows).catch(() => {})
      } catch (error) {
        term.write(`\r\n\x1b[31m[终端启动失败：${(error as Error).message}]\x1b[0m\r\n`)
      }
    }
    void spawn()

    const scheduleResize = (): void => {
      window.setTimeout(() => {
        if (disposed || !sessionId) return
        try {
          fit.fit()
          void window.ideerTerminal.resize(sessionId, term.cols, term.rows).catch(() => {})
        } catch { /* zero-size container: skip */ }
      }, 100)
    }
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleResize) : null
    resizeObserver?.observe(container)

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      unsubscribeData()
      unsubscribeExit()
      if (sessionId) {
        // Defensive kill: the close guard already killed and unregistered on
        // the guarded paths; this covers unguarded removals (e.g. startup
        // hydrate) so no shell outlives its pane.
        void window.ideerTerminal.kill(sessionId).catch(() => {})
        useTerminalSessionStore.getState().unregister(instanceId)
      }
      term.dispose()
    }
  }, [instanceId])

  return <div ref={containerRef} className="h-full w-full overflow-hidden" style={{ background: '#1E1E2E' }} />
}
