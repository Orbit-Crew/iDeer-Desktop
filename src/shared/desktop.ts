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
/** Issue 112: device-local display fact for one explicit knowledge import. */
export interface KnowledgeImportDocumentView { filename: string; sha256: string; bytes: number; mime: string }
export interface KnowledgeImportView {
  id: string
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  documentCount: number
  status: 'registered' | 'failed'
  errorCode: string
  createdAt: string
  documents: KnowledgeImportDocumentView[]
}
export interface KnowledgeImportOutcome {
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  documentCount: number
}
/** Issue 115: device-local display fact for one explicit server publication. */
export interface KnowledgePublicationView {
  id: string
  kbId: string
  revisionId: string
  copyResourceId: string
  copySlug: string
  copyRevisionId: string
  status: 'published' | 'failed'
  errorCode: string
  documentCount: number
  createdAt: string
}
export interface KnowledgePublishDestination {
  kind: string
  displayName: string
  slug: string
  visibility: string
  governance: string
}
export interface KnowledgePublishPreview {
  confirmed: false
  kbId: string
  revisionId: string
  destination: KnowledgePublishDestination
  documents: KnowledgeImportDocumentView[]
}
export interface KnowledgePublishOutcome {
  confirmed: true
  kbId: string
  revisionId: string
  copyResourceId: string
  copySlug: string
  copyRevisionId: string
  status: string
  failureCode: string
  documentCount: number
}
/** Issue 116: controlled knowledge-graph facts for one frozen revision. */
export interface KnowledgeGraphSource {
  documentId: string
  filename: string
  contentHash: string
  status: string
  errorCode: string
}
export interface KnowledgeGraphEntity { name: string; type: string; documentId: string; filename: string }
export interface KnowledgeGraphRelation { source: string; target: string; relation: string; documentId: string; filename: string }
export interface KnowledgeGraphView {
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  status: 'not_generated' | 'completed' | 'partial' | 'failed'
  generated: number
  failed: number
  entities: KnowledgeGraphEntity[]
  relations: KnowledgeGraphRelation[]
  sources: KnowledgeGraphSource[]
}
/** Issue 116: device-local locate answer; the path never leaves this device. */
export interface KnowledgeGraphSourceLocation {
  kbId: string
  revisionId: string
  documentId: string
  filename?: string
  logicalPath?: string
  missing?: boolean
  reason?: string
}
export interface KnowledgeGraphCommand {
  action: 'view' | 'generate' | 'locate' | 'search' | 'ask'
  kbId: string
  revisionId: string
  documentId?: string
  documentIds?: string[]
  query?: string
}
/** Issue 117: one selected document inside a scoped query/ask, with its frozen source. */
export interface KnowledgeGraphScopeRow {
  documentId: string
  filename: string
  contentHash: string
  status: string
  errorCode: string
}
/** Issue 117: sourced entity/relation rows inside the selected scope. */
export interface KnowledgeGraphScopedEntity { name: string; type: string; documentId: string; filename: string; contentHash: string }
export interface KnowledgeGraphScopedRelation { source: string; target: string; relation: string; documentId: string; filename: string; contentHash: string }
/** Issue 117: scoped entity/relation retrieval bound to the frozen revision. */
export interface KnowledgeGraphQueryResult {
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  status: KnowledgeGraphView['status']
  query: string
  scope: KnowledgeGraphScopeRow[]
  entities: KnowledgeGraphScopedEntity[]
  relations: KnowledgeGraphScopedRelation[]
}
/** Issue 117: scoped ask answer with the per-document sources it was built from. */
export interface KnowledgeGraphAskResult {
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  status: KnowledgeGraphView['status']
  question: string
  answerAvailable: boolean
  answer: string
  errorCode: string
  scope: KnowledgeGraphScopeRow[]
}
/** Issue 118: one wiki page in the page list, bound to its frozen document source. */
export interface WikiPageSummary {
  documentId: string
  filename: string
  title: string
  contentHash: string
  status: 'completed' | 'skipped' | 'failed' | 'not_generated'
  errorCode: string
}
/** Issue 118: the page list with its progress, skips, and frozen sources (never bodies). */
export interface WikiView {
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  status: KnowledgeGraphView['status']
  generated: number
  failed: number
  skipped: number
  pages: WikiPageSummary[]
}
/** Issue 118: one read page; a body only ever travels with a completed page. */
export interface WikiPage {
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  documentId: string
  filename: string
  title: string
  contentHash: string
  status: WikiPageSummary['status']
  errorCode: string
  body: string
}
/** Issue 119: one resolved link or backlink row; the target names its honest page status. */
export interface WikiLink {
  documentId: string
  title: string
  status: WikiPageSummary['status']
}
/** Issue 119: one index page with its resolved links, missing targets, and backlinks. */
export interface WikiNavigationPage extends WikiPageSummary {
  links: WikiLink[]
  missingLinks: string[]
  backlinks: WikiLink[]
}
/** Issue 119: the association graph, reusing the stored #116 rows with frozen sources. */
export interface WikiAssociationSource {
  documentId: string
  filename: string
  contentHash: string
  status: string
  errorCode: string
}
export interface WikiAssociationEntity { name: string; type: string; documentId: string; filename: string; contentHash: string }
export interface WikiAssociationRelation { source: string; target: string; relation: string; documentId: string; filename: string; contentHash: string }
export interface WikiAssociations {
  status: KnowledgeGraphView['status']
  generated: number
  failed: number
  sources: WikiAssociationSource[]
  entities: WikiAssociationEntity[]
  relations: WikiAssociationRelation[]
}
/** Issue 119: the wiki index — pages with links/backlinks plus the association graph. */
export interface WikiNavigation extends Omit<WikiView, 'pages'> {
  pages: WikiNavigationPage[]
  associations: WikiAssociations
}
export interface WikiCommand {
  action: 'view' | 'generate' | 'read' | 'navigate'
  kbId: string
  revisionId: string
  documentId?: string
}
/** Issue 120: one package member in the upload scope, bound to its frozen hash. */
export interface SkillPackageFileView {
  path: string
  role: 'body' | 'script' | 'reference' | 'attachment'
  bytes: number
  sha256: string
}
export interface SkillImportDestination { resourceType: string; visibility: string; ownerId?: string }
/** Issue 120: the read-only device-side preview; nothing uploads in this step. */
export interface SkillImportPreview {
  confirmed: false
  origin: 'markdown' | 'zip' | 'directory'
  name: string
  description: string
  bodyExcerpt: string
  files: SkillPackageFileView[]
  fileCount: number
  totalBytes: number
  packageHash: string
  destination: SkillImportDestination
}
/** Issue 120: the confirmed import lands as the account's private draft, never published here. */
export interface SkillImportOutcome {
  confirmed: true
  resourceId: string
  slug: string
  revision: number
  contentHash: string
  fileCount: number
  totalBytes: number
}
/** Issue 120: the version copy produced by the existing platform publish flow. */
export interface SkillPublishOutcome { resourceId: string; version: number; contentHash: string }
export type SkillCommand =
  | { action: 'import'; kind: 'markdown' | 'zip' | 'directory' }
  | { action: 'publish'; resourceId: string; expectedDraftRevision: number }
/** Issue 121: one account Skill with its Server-side trigger preference. */
export interface SkillTriggerPreferenceView {
  skillId: string
  slug: string
  displayName: string
  latestVersion: number
  available: boolean
  enabled: boolean
  keywords: string[]
  alwaysInject: boolean
  applicableAgentIds: string[]
  priority: number
}
/** Issue 121: the account's preference projection; matching happens only on the Server. */
export interface SkillPreferencesView { skills: SkillTriggerPreferenceView[] }
export type SkillPreferenceCommand =
  | { action: 'list' }
  | { action: 'set'; skillId: string; enabled: boolean; keywords: string[]; alwaysInject: boolean; applicableAgentIds: string[]; priority: number }
  | { action: 'clear'; skillId: string }
/** Issue 120: device-local display fact for one explicit skill import or publication. */
export interface SkillImportView {
  id: string
  resourceId: string
  slug: string
  revision: number
  contentHash: string
  version: number
  origin: string
  fileCount: number
  totalBytes: number
  status: 'imported' | 'published' | 'failed'
  errorCode: string
  createdAt: string
}
/** Issue 122: one remembered device-local Skill script grant (exact content + scope). */
export interface SkillScriptAuthorizationView {
  id: string
  resourceId: string
  slug: string
  version: number
  contentHash: string
  scriptPath: string
  scriptSha256: string
  requirementsHash: string
  status: 'granted'
  createdAt: string
}
/** Issue 122: list or revoke the device's remembered Skill script grants.
 * A revoke response carries `revoked` (false when the identity was already
 * gone) plus the post-revoke grant list, so one wire shape serves both
 * actions and the renderer can drop the row without a second IPC round. */
export type SkillScriptCommand =
  | { action: 'list' }
  | { action: 'revoke'; authorizationId: string }
export interface SkillScriptView { authorizations: SkillScriptAuthorizationView[]; revoked?: boolean }

/** Issue 123: one installed connector — identity facts only, never a runnable binding. */
export interface ConnectorView {
  slug: string
  displayName: string
  version: string
  entry: string
  manifestHash: string
  packageHash: string
  serverConnectorId: string
  state: 'installed'
  createdAt: string
}
/** Issue 123: the read-only projection of a candidate connector package. */
export interface ConnectorInstallPreview {
  slug: string
  displayName: string
  version: string
  manifestHash: string
  packageHash: string
  fileCount: number
  entry: string
  installed: boolean
  unchanged?: boolean
}
/**
 * Issue 123: the renderer names the action only; the candidate directory is
 * located in the trusted main process. A confirmed install/remove is sent
 * after the owner confirmed in a dialog — the wire always carries
 * confirmed=true for them, and preview rides main-internal calls with the
 * located path, which never routes through the renderer.
 */
export type ConnectorCommand =
  | { action: 'install' }
  | { action: 'remove'; slug: string }
  | { action: 'list' }
/**
 * Main-internal: the read-only preview over a package path located in the
 * trusted main process. Never accepted from the renderer.
 */
export type ConnectorPreviewCommand = { action: 'preview'; path: string }
/** Main-internal: the confirmed install over the same located path. */
export type ConnectorInstallCommand = { action: 'install'; path: string }
export type ConnectorOutcome =
  | { action: 'install'; installed: true; slug: string; displayName: string; version: string
      manifestHash: string; packageHash: string; fileCount: number; entry: string
      serverConnectorId: string; state: 'installed' }
  | { action: 'remove'; removed: true; slug: string; displayName: string }
  | { action: 'list'; connectors: ConnectorView[] }
export type ConnectorInternalOutcome =
  | { action: 'preview' } & ConnectorInstallPreview
  | ConnectorOutcome

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
  knowledgeImports?: KnowledgeImportView[]
  knowledgeImportStorageError?: string
  knowledgePublications?: KnowledgePublicationView[]
  knowledgePublishStorageError?: string
  skillImports?: SkillImportView[]
  skillImportStorageError?: string
  skillScriptAuthorizations?: SkillScriptAuthorizationView[]
  skillScriptStorageError?: string
  connectors?: ConnectorView[]
  connectorStorageError?: string
  installDrain?: boolean
  activeTasks?: number
  unknownWriteEffects?: number
  compatibility?: CompatibilityView
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
  actualCombo?: { desktop: string; runtime: string; server: string }
  error?: string
  declarationHash?: string
  legacy?: boolean
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
  /** Issue 112: explicit local import; the main process picks files and confirms. */
  importKnowledge(kbId: string): Promise<KnowledgeImportOutcome>
  /** Issue 115: explicit server publication; file picking and confirmation stay in main. */
  publishKnowledge(kbId: string, revisionId: string): Promise<KnowledgePublishOutcome>
  /** Issue 116: controlled graph view/generate plus device-local source locate. */
  knowledgeGraph(command: KnowledgeGraphCommand): Promise<KnowledgeGraphView | KnowledgeGraphSourceLocation | KnowledgeGraphQueryResult | KnowledgeGraphAskResult>
  /** Issue 118: controlled wiki page list, generation, and single-page reading. */
  knowledgeWiki(command: WikiCommand): Promise<WikiView | WikiPage | WikiNavigation>
  /** Issue 120: skill package preview import; picking and confirmation stay in main. */
  skills(command: SkillCommand): Promise<SkillImportPreview | SkillImportOutcome | SkillPublishOutcome>
  /** Issue 121: configure Skill trigger preferences; the Server matches, the Desktop never does. */
  skillPreferences(command: SkillPreferenceCommand): Promise<SkillPreferencesView>
  /** Issue 122: list or revoke the device's remembered Skill script grants. */
  skillScripts(command: SkillScriptCommand): Promise<SkillScriptView>
  /**
   * Issue 123: optional local connector install; picking and confirmation
   * stay in main. The renderer calls it with the renderer-facing ConnectorCommand
   * shapes only; the path-carrying preview/confirmed-install forms are
   * main-internal and typed here so the preload bridge can implement them.
   */
  connectors(command: ConnectorCommand | ConnectorPreviewCommand | ConnectorInstallCommand): Promise<ConnectorInternalOutcome>
  checkUpdates(mode?: 'staged'): Promise<UpdateCheckResult>
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
  | { action: 'state' | 'refresh' | 'compatibility' }
  | { action: 'create'; scope: string; agentId: string; skillId?: string }
  | { action: 'open' | 'reconnect'; scope: string; threadId: string }
  | { action: 'stop'; scope: string; threadId: string; runId: string }
  | { action: 'send'; scope: string; threadId: string; turnId: string; text: string }
  | { action: 'answer'; scope: string; threadId: string; turnId: string; requestId: string; text?: string; optionId?: string }
  | { action: 'consent'; scope: string; threadId: string; runId: string; taskId: string; requestHash: string;
    decision: 'allow' | 'allow-directory' | 'deny'; rememberScript?: boolean }
  | { action: 'upload'; scope: string; threadId: string; runId: string; taskId: string; decision: 'allow' }
  | { action: 'download'; scope: string; threadId: string; artifactId: string }

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
/** Issue 39: one pending device decision the Desktop chat can settle — a
 * file write (#102), a Skill script run (#122), or a knowledge material read
 * (#116). Identity and scope facts only; bytes never cross to the renderer. */
export interface LocalConsentView {
  taskId: string
  runId: string
  threadId: string
  requestHash: string
  kind: 'file-write' | 'skill-script' | 'knowledge-material'
  path?: string
  content?: string
  directory?: string
  skill?: string
  scriptPath?: string
  version?: string
  scriptSha256?: string
  requirementsSha256?: string
  revisionId?: string
  manifestHash?: string
  documents?: { filename: string; contentHash: string }[]
}
export interface ChatSnapshot {
  compatibility?: CompatibilityView
  artifacts?: PlatformArtifact[]
  /** Runtime-to-main only. Main consumes and removes bytes before returning IPC. */
  download?: PlatformArtifact & { content: string }
  downloadStatus?: 'saved' | 'cancelled'
  stop?: { runId: string; state: 'requested' | 'uncertain' } | null
  taskError?: string
  localTasks?: { task_id: string; run_id: string; tool_call_id?: string; capability: string; logical_target: string;
    status: string; stop_requested?: boolean; receipt_pending?: boolean; error_code?: string;
    receipt?: { status?: string; result_hash?: string; error_code?: string } | null;
    local?: { status: string; delivery_state: string; error_code?: string; receipt_hash?: string } | null;
    artifacts?: PlatformArtifact[];
    localResult?: LocalResultView | null }[]
  localConsents?: LocalConsentView[]
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
