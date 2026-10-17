export interface DesktopStatus {
  version: string
  server: 'not-configured'
  runtime: 'not-installed'
}

export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>
  quit(): Promise<void>
}
