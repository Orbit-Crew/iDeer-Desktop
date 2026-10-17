import type { DesktopBridge } from '../shared/desktop'

declare global {
  interface Window {
    ideer: DesktopBridge
  }
}
