import type { DesktopBridge, TerminalBridge } from '../shared/desktop'

declare global {
  interface Window {
    /** The trusted platform bridge (desktop:* family). */
    ideer: DesktopBridge
    /** Issue 110: the human terminal's separate minimal bridge — terminal
     * output is content, not trusted UI, and never crosses `ideer`. */
    ideerTerminal: TerminalBridge
  }
}
