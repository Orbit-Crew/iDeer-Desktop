export interface DesktopStatus {
  version: string
  server: 'not-configured' | 'connecting' | 'connected' | 'offline' | 'paused' | 'error'
  runtime: RuntimeStatus
}

export interface RuntimeTask { taskId: string; runId: string; capability: string; state: string }
export interface ReceiptHistory {
  rows: { task_id: string; run_id: string; tool_call_id: string; capability: string; status: string;
    user_id: string; device_id: string; delivery_state: string; receipt_id: string; receipt_hash: string | null;
    logical_target: string; error_code: string }[]
  total: number
  pending: number
  confirmed: number
  uncertain: number
  cleaned: number
  storageError: string
}
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
  receiptStorageError?: string
  receiptScope?: string
  directoryGrants?: { id: string; directory: string; operation: string; userId: string; deviceId: string; createdAt: string }[]
}

export interface DesktopBridge {
  manage(action: 'logout' | 'switch-account' | 'revoke', grantId?: string): Promise<void>
  chooseWorkspace(): Promise<void>
  getStatus(): Promise<DesktopStatus>
  quit(): Promise<void>
  startRuntime(): Promise<void>
  stopRuntime(): Promise<void>
  beginLogin(server: string, deviceName: string): Promise<void>
  chat(command: ChatCommand): Promise<ChatSnapshot>
  receipts(action: 'history' | 'clear-confirmed', offset?: number): Promise<ReceiptHistory>
}

export type ChatCommand =
  | { action: 'state' | 'refresh' }
  | { action: 'create'; scope: string; agentId: string; skillId?: string }
  | { action: 'open' | 'reconnect'; scope: string; threadId: string }
  | { action: 'send'; scope: string; threadId: string; turnId: string; text: string }
  | { action: 'answer'; scope: string; threadId: string; turnId: string; requestId: string; text?: string; optionId?: string }
  | { action: 'consent'; scope: string; threadId: string; runId: string; taskId: string; requestHash: string; decision: 'allow' | 'allow-directory' | 'deny' }

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
  localConsents?: { taskId: string; runId: string; threadId: string; requestHash: string; path: string; content: string; directory?: string }[]
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
