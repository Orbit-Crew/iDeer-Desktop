export interface DesktopStatus {
  version: string
  server: 'not-configured' | 'connecting' | 'connected' | 'offline' | 'paused' | 'error'
  runtime: RuntimeStatus
}

export interface RuntimeTask { taskId: string; runId: string; capability: string; state: string }
export interface LoginStatus {
  state: 'unauthenticated' | 'awaiting-confirmation' | 'authenticated' | 'expired' | 'error'
  account: string
  device: string
  error: string
  verification?: string
}
export interface RuntimeStatus {
  process: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'missing' | 'unresponsive'
  connection: DesktopStatus['server']
  pid?: number
  tasks: RuntimeTask[]
  login?: LoginStatus
}

export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>
  quit(): Promise<void>
  startRuntime(): Promise<void>
  stopRuntime(): Promise<void>
  beginLogin(server: string, deviceName: string): Promise<void>
}
