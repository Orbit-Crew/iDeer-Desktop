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
export interface LocalResultView {
  task_id: string
  run_id: string
  thread_id: string
  capability: string
  logical_root: string
  logical_path: string
  name: string
  sha256: string
  bytes: number
  artifact_ref: string
  uploaded_at: string
}
export interface PlatformArtifact { artifact_id: string; name: string; sha256: string; bytes: number }
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
  installDrain?: boolean
  activeTasks?: number
}

export interface UpdatePendingView {
  kind: 'patch' | 'full'
  source: 'online' | 'offline'
  verifiedAt: string
  advice: string
  desktopVersion: string
  runtimePython: string
  serverCompatibility: { minProtocol: number; notes: string }
  fileCount: number
  deletionCount: number
}
export interface UpdateCheckResult { ok: boolean; error: string; pending: UpdatePendingView | null }
export interface CompatibilityView {
  level: 'compatible' | 'capability' | 'core'
  disabledCapabilities: string[]
  notes: string
  advice: string
  candidateCombo: { desktop: string; runtime: string; server: string }
}
export interface RecoveryView {
  state: 'applied-pending-verify' | 'updated' | 'rolled-back' | 'recovery-failed'
  detail: string
  desktopVersion: string
  runtimePython: string
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
  checkUpdates(): Promise<UpdateCheckResult>
  importUpdate(): Promise<UpdateCheckResult>
  installUpdate(): Promise<InstallOutcome>
  recoveryState(): Promise<RecoveryView | null>
  refreshCompatibility(): Promise<CompatibilityView | { error: string }>
}

export interface InstallOutcome {
  installed: boolean
  stage: 'confirmed' | 'draining' | 'ready' | 'stopped' | 'applied' | 'launched' | 'blocked' | 'canceled' | 'failed'
  detail: string
}

export type ChatCommand =
  | { action: 'state' | 'refresh' }
  | { action: 'create'; scope: string; agentId: string; skillId?: string }
  | { action: 'open' | 'reconnect'; scope: string; threadId: string }
  | { action: 'stop'; scope: string; threadId: string; runId: string }
  | { action: 'send'; scope: string; threadId: string; turnId: string; text: string }
  | { action: 'answer'; scope: string; threadId: string; turnId: string; requestId: string; text?: string; optionId?: string }
  | { action: 'consent'; scope: string; threadId: string; runId: string; taskId: string; requestHash: string; decision: 'allow' | 'allow-directory' | 'deny' }
  | { action: 'upload'; scope: string; threadId: string; runId: string; taskId: string; decision: 'allow' }

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
  stop?: { runId: string; state: 'requested' | 'uncertain' } | null
  taskError?: string
  localTasks?: { task_id: string; run_id: string; tool_call_id?: string; capability: string; logical_target: string;
    status: string; stop_requested?: boolean; receipt_pending?: boolean; error_code?: string;
    receipt?: { status?: string; result_hash?: string; error_code?: string } | null;
    local?: { status: string; delivery_state: string; error_code?: string; receipt_hash?: string } | null;
    artifacts?: PlatformArtifact[];
    localResult?: LocalResultView | null }[]
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
