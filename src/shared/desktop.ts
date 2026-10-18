export interface DesktopStatus {
  version: string
  server: 'not-configured' | 'connecting' | 'connected' | 'offline' | 'paused' | 'error'
  runtime: RuntimeStatus
}

export interface RuntimeTask { taskId: string; runId: string; capability: string; state: string }
export interface RuntimeStatus {
  process: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'missing' | 'unresponsive'
  connection: DesktopStatus['server']
  pid?: number
  tasks: RuntimeTask[]
}

export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>
  quit(): Promise<void>
  startRuntime(): Promise<void>
  stopRuntime(): Promise<void>
}
