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
  workspace?: { state: 'ready' | 'unavailable'; logicalRoot: string }
  login?: LoginStatus
}

export interface DesktopBridge {
  chooseWorkspace(): Promise<void>
  getStatus(): Promise<DesktopStatus>
  quit(): Promise<void>
  startRuntime(): Promise<void>
  stopRuntime(): Promise<void>
  beginLogin(server: string, deviceName: string): Promise<void>
  chat(command: ChatCommand): Promise<ChatSnapshot>
}

export type ChatCommand =
  | { action: 'state' | 'refresh' }
  | { action: 'create'; scope: string; agentId: string; skillId?: string }
  | { action: 'open' | 'reconnect'; scope: string; threadId: string }
  | { action: 'send'; scope: string; threadId: string; turnId: string; text: string }
  | { action: 'answer'; scope: string; threadId: string; turnId: string; requestId: string; text?: string; optionId?: string }

export interface HumanInputRequest {
  version: 1 | 2
  kind: 'human_input_request'
  source: string
  request_id: string
  question: string
  title?: string
  context?: string
  input_mode: 'free_text' | 'single_choice' | 'choice_with_other' | 'form'
  options?: { id: string; label: string; value: string }[]
  fields?: { name: string; label: string; type: string; required: boolean; options?: { id: string; label: string; value: string }[] }[]
}
export interface ChatMessage {
  id: string
  role: 'human' | 'ai' | 'tool'
  text: string
  name: string
  request?: HumanInputRequest | null
  response?: { request_id: string } | null
}
export interface ChatSnapshot {
  scope: string
  resources: { id: string; type: 'agent' | 'skill'; name: string; visibility: string; version: number | null; available: boolean; reason: string }[]
  threads: { id: string; title: string; status: string }[]
  thread: { id: string; status: string; agentId: string; skillId: string } | null
  messages: ChatMessage[]
  run: { id: string; status: string; selection: Record<string, unknown> } | null
  events: { id: string; event: string; detail: string }[]
  stream: 'idle' | 'streaming' | 'disconnected' | 'uncertain'
  error: string
  lastEventId: string
}
