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
  /** Issue 95: the bound device id while authenticated — lets history views
   * mark records from another device as 仅原设备. Identity fact only. */
  deviceId?: string
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
/** Issue 81: honest device-side parse record kept with one imported document. */
export interface KnowledgeImportParseAnchor {
  kind: string
  page: number | null
  table: number | null
  title: string | null
  line: number
  lines: number
}
export interface KnowledgeImportDocumentParseView {
  status: string
  parser: string
  parserVersion: string
  pages: number
  tables: number
  truncated: boolean
  errorCode: string
  layout?: KnowledgeImportParseAnchor[]
}
export interface KnowledgeImportDocumentView {
  filename: string
  sha256: string
  bytes: number
  mime: string
  parse?: KnowledgeImportDocumentParseView
}
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
/** Issue 120: one package member in the upload scope, bound to its frozen hash.
 * Issue 82: script members carry their declared language (empty for the
 * other roles and for members outside the four-language mapping). */
export type SkillScriptLanguage = 'python' | 'js' | 'shell' | 'executable'
export interface SkillPackageFileView {
  path: string
  role: 'body' | 'script' | 'reference' | 'attachment'
  bytes: number
  sha256: string
  language: SkillScriptLanguage | ''
}
/** Issue 82: the package's declared execution environment, normalized to the
 * frozen wire grammar (target + the five requirement dimensions). */
export interface SkillImportEnvironmentView {
  target: 'server' | 'user_device'
  os: string[]
  dependencies: string[]
  software: string[]
  tools: string[]
  data: string[]
}
/** Issue 82: the permissions a package declares, as shown at import. */
export interface SkillImportPermissionsView { network: boolean; subprocess: boolean }
export interface SkillImportDestination { resourceType: string; visibility: string; ownerId?: string }
/** Issue 120: the read-only device-side preview; nothing uploads in this step. */
export interface SkillImportPreview {
  confirmed: false
  origin: 'markdown' | 'zip' | 'directory'
  name: string
  description: string
  bodyExcerpt: string
  environment: SkillImportEnvironmentView | null
  permissions: SkillImportPermissionsView
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

/** Issue 72: one platform thread as the sidebar shows it — identity facts and
 * the Server's own recency timestamp; no local roster is ever built. Issue 91:
 * `projectId` mirrors the Server's own membership stamp (empty = 散会话). */
export interface ThreadRowView { id: string; title: string; status: string; updatedAt: string; projectId: string }
/** Issue 72: the account's own Thread capabilities as the Server states them. */
export interface ThreadPermissionsView { canRename: boolean; canDelete: boolean }
/** Issue 72: list/search/rename/delete/move share one wire shape. Every reply
 * carries the account's thread permissions plus the platform's own post-action
 * list, so the sidebar re-reads authoritative state in the same round; a
 * rename, delete or move also carries its outcome flag. The Server-side
 * permission and owner checks stay authoritative — the renderer only grays
 * out early. Issue 91: `move` names the target project and rides the Server's
 * own move endpoint; moving back out to loose is not a desktop action here. */
export type ThreadCommand =
  | { action: 'list' }
  | { action: 'search'; query: string }
  | { action: 'rename'; threadId: string; title: string }
  | { action: 'delete'; threadId: string }
  | { action: 'move'; threadId: string; projectId: string }
export interface ThreadView {
  threads: ThreadRowView[]
  permissions: ThreadPermissionsView
  renamed?: boolean
  deleted?: boolean
  moved?: boolean
}

/** Issue 91: one platform project as the management surface shows it —
 * identity facts only; instructions and presentation stay platform-side. */
export interface ProjectView { id: string; name: string; status: 'active' | 'archived'; createdAt: string; updatedAt: string }
/** Issue 91: the account's own Project capabilities as the Server states them.
 * Create, rename and the archive/restore flip share `projects:write`; only
 * deletion carries its own `projects:delete`. */
export interface ProjectPermissionsView { canWrite: boolean; canDelete: boolean }
/** Issue 91: list/create/rename/archive/restore/delete share one wire shape.
 * Every reply carries the account's project permissions plus the platform's
 * own post-action list, so the surface re-reads authoritative state in the
 * same round and no second project roster is ever kept on this device. The
 * Server-side permission and owner checks stay authoritative — the renderer
 * only grays out early. Deleting or archiving never touches local files or
 * directory grants; the Server clears Thread membership itself. */
export type ProjectCommand =
  | { action: 'list' }
  | { action: 'create'; name: string }
  | { action: 'rename'; projectId: string; name: string }
  | { action: 'archive'; projectId: string }
  | { action: 'restore'; projectId: string }
  | { action: 'delete'; projectId: string }
export interface ProjectOperationView {
  projects: ProjectView[]
  permissions: ProjectPermissionsView
  created?: boolean
  renamed?: boolean
  archived?: boolean
  restored?: boolean
  deleted?: boolean
}

/** Issue 102: one parsed sheet's recorded facts — schema summary, counts and
 * a content fingerprint. Row data never rides this surface. */
export interface DatasetSheetView {
  name: string
  fingerprint: string
  /** The inferred schema summary (`列名:类型` pairs, bounded display fact). */
  schema: string
  rowCount: number
  colCount: number
  truncated: boolean
  /** Honest marker for sheets that held more columns than the recorded cap. */
  columnsTruncated: boolean
}
/** Issue 102: one imported table dataset as this device records it — a
 * device-local display fact bound to the importing identity. The original
 * file stays on this machine (`sourcePath` names the 原件); the record keeps
 * identity, schema, counts and content fingerprints only, never row data.
 * `format` is '' exactly when the row is a failure that never recognized a
 * supported format — an unknown format is stated, never guessed.
 * `projectId` mirrors the renderer's current project selection at import
 * time; the platform has no dataset endpoint, so the association is recorded
 * on the device with the row and the platform-side directory record remains
 * an explicit platform dependency. */
export interface DatasetView {
  id: string
  filename: string
  sourcePath: string
  format: 'xlsx' | 'csv' | ''
  fileSha256: string
  sheets: DatasetSheetView[]
  rowCount: number
  projectId: string
  deviceId: string
  status: 'ready' | 'failed'
  errorCode: string
  createdAt: string
}
/**
 * Issue 102: 表格数据集导入. The renderer names the action and the project
 * association only — the file is located by the trusted main process's
 * native dialog and both actions are confirmed there. Deleting removes the
 * registry row only and never the original file.
 */
export type DatasetCommand =
  | { action: 'import'; projectId: string }
  | { action: 'delete'; datasetId: string }
/** Main-internal: the confirmed import over the main-process-picked path;
 * the renderer never supplies a path. */
export type DatasetImportCommand = { action: 'import'; path: string; projectId: string }
/** Issue 102: one wire shape for both actions. Every reply carries the
 * identity's own bounded post-action list plus its honest outcome flag: a
 * duplicate import answers `duplicate` with the existing row's id instead of
 * writing a second row, and a failed import answers `failed` with the fixed
 * reason its row records. */
export interface DatasetOperationView {
  datasets: DatasetView[]
  imported?: boolean
  duplicate?: boolean
  failed?: boolean
  deleted?: boolean
  datasetId?: string
  duplicateOf?: string
  errorCode?: string
}

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

/** Issue 73: one authorized model row — the Server's own permission-filtered
 * catalog, projected with display facts only. No provider, endpoint or key
 * field exists anywhere in this family. */
export interface ModelRowView {
  name: string
  displayName: string
  description: string
  supportsThinking: boolean
}
/**
 * Issue 73: the model settings view. `accountDefault` is the platform
 * account preference the Web writes (empty string = platform default);
 * `fallback` is the device-local 备用模型 choice (empty string = none).
 * Every reply re-reads the Server, so it always carries post-action truth.
 */
export interface ModelSettingsView {
  models: ModelRowView[]
  accountDefault: string
  fallback: string
  canRead: boolean
  reason: string
}
/** Issue 73: the settings-page actions. Clearing rides the empty string. */
export type ModelCommand =
  | { action: 'list' }
  | { action: 'set-default'; modelName: string }
  | { action: 'set-fallback'; modelName: string }

/** Issue 85: one device-local 补跑/跳过 marking for a planned point. The
 * platform contract has no missed-run semantics, so the catch-up marking is
 * device-local display truth keyed by the planned point itself. */
export interface ScheduleMarkView {
  plannedAt: string
  status: string
  reason: string
  error: string
  markedAt: string
}
/** Issue 85: one platform scheduled task as the management card shows it —
 * the platform's own post-action row plus the device's skip policy and 补跑
 * marks. nextRunAt is the platform-computed exact instant. */
export interface ScheduleTaskView {
  id: string
  title: string
  prompt: string
  status: string
  scheduleType: string
  scheduleSpec: { cron?: string; everySeconds?: number; runAt?: string }
  timezone: string
  assistantId: string
  contextMode: string
  threadId: string
  nextRunAt: string
  createdAt: string
  updatedAt: string
  skipOnMissed: boolean
  missedMarks: ScheduleMarkView[]
}
/** Issue 85: one platform execution record. plannedFor is the planned point
 * when the run row names one; catchUp carries the device's 补跑 mark when the
 * record covers a point this device caught up. */
export interface ScheduleRunView {
  id: string
  status: string
  plannedFor: string
  trigger: string
  /** 会话关联: the session the execution belongs to, as the platform names it. */
  threadId: string
  createdAt: string
  error: string
  catchUp: ScheduleMarkView | null
}
/** Issue 85: the platform's own cron preview — instants and wall clocks as
 * the Server computed them ("same semantics as scheduling"); the device only
 * supplies the local timezone and renders them, never recomputes. */
export interface SchedulePreviewView {
  cron: string
  timezone: string
  occurrences: { runAt: string; localTime: string }[]
}
/** Issue 85: the create draft. contextMode 'reuse_thread' requires threadId;
 * assistantId '' means the platform default (lead_agent). */
export interface ScheduleDraftCommand {
  title: string
  prompt: string
  scheduleType: 'cron' | 'interval' | 'once'
  scheduleSpec: { cron: string } | { everySeconds: number } | { runAt: string }
  timezone: string
  assistantId: string
  contextMode: 'fresh_thread_per_run' | 'reuse_thread'
  threadId: string
}
/** Issue 85: an update patch; scheduleType rides only for spec validation and
 * is never sent (the pinned endpoint keeps the type immutable). */
export type SchedulePatchCommand = Partial<ScheduleDraftCommand> & { scheduleType?: 'cron' | 'interval' | 'once' }
export type ScheduleCommand =
  | { action: 'list' }
  | { action: 'get'; taskId: string }
  | { action: 'create'; task: ScheduleDraftCommand }
  | { action: 'update'; taskId: string; task: SchedulePatchCommand }
  | { action: 'pause'; taskId: string }
  | { action: 'resume'; taskId: string }
  | { action: 'trigger'; taskId: string }
  | { action: 'delete'; taskId: string }
  | { action: 'runs'; taskId: string; limit: number; offset: number }
  | { action: 'set-skip'; taskId: string; skipOnMissed: boolean }
  | { action: 'preview'; cron: string; timezone: string; count: number }
/** Issue 85: one reply per action, discriminated by the caller's action. */
export type SchedulesOutcome =
  | { action: 'list'; tasks: ScheduleTaskView[] }
  | { action: 'get' | 'create' | 'update' | 'pause' | 'resume'; task: ScheduleTaskView }
  | { action: 'trigger'; taskId: string; triggered: true }
  | { action: 'delete'; taskId: string; deleted: true }
  | { action: 'runs'; runs: ScheduleRunView[] }
  | { action: 'set-skip'; taskId: string; skipOnMissed: boolean }
  | { action: 'preview'; cron: string; timezone: string; occurrences: SchedulePreviewView['occurrences'] }
/** Issue 84: one prompt template row as the plaza shows it — the Server's
 * own account-scoped asset, projected with display and prefill facts only.
 * The content rides the row because a plaza click prefills the composer from
 * it; nothing here executes or sends. */
export interface TemplateRowView {
  id: string
  name: string
  category: string
  content: string
  usageCount: number
  visibility: string
  updatedAt: string
}
/**
 * Issue 84: the plaza's one wire shape. Every reply carries the Server's own
 * post-action list, so the panel re-reads authoritative state in the same
 * round; a mutation also carries its outcome flag. New templates land
 * private on the Server (visibility stays the Server's decision); the
 * Desktop never widens it and never sends a prefilled draft by itself.
 */
export interface TemplateView {
  templates: TemplateRowView[]
  created?: boolean
  updated?: boolean
  deleted?: boolean
  used?: boolean
}
/** Issue 84: the plaza actions. `use` records one prefill (usage +1); the
 * prefill itself is a renderer-local draft edit and never auto-sends. */
export type TemplateCommand =
  | { action: 'list' }
  | { action: 'create'; name: string; category: string; content: string }
  | { action: 'update'; templateId: string; name?: string; category?: string; content?: string }
  | { action: 'delete'; templateId: string }
  | { action: 'use'; templateId: string }

/** Issue 106: one official template row as the welcome page shows it — the
 * platform's published selection, projected read-only. No usage count and
 * no visibility fact exists on the official rows, so none is invented for
 * display; copying a row into the account's own templates is the plain
 * create on `templates`, and this read stays live on every mount, so the
 * facade follows platform updates without any local snapshot. */
export interface OfficialTemplateRowView {
  id: string
  name: string
  category: string
  content: string
  updatedAt: string
}
/** Issue 106: the official read's own reply — never the account list and
 * never a mutation flag. */
export interface OfficialTemplatesView { official: OfficialTemplateRowView[] }
/** Issue 106: the welcome page's one read command; no ids, no fields. */
export type OfficialTemplateCommand = { action: 'official-list' }

/** Issue 84: the `{{变量}}` placeholders a template prefill asks the user to
 * fill, in first-appearance order, deduplicated. Pure display extraction —
 * the composer keeps the raw text; filling stays a manual user edit. */
export function extractTemplateVariables(content: string): string[] {
  const names: string[] = []
  for (const match of content.matchAll(/\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g)) {
    const name = match[1]
    if (!names.includes(name)) names.push(name)
    if (names.length >= 32) break
  }
  return names
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
  knowledgeImports?: KnowledgeImportView[]
  knowledgeImportStorageError?: string
  /** Issue 102: this identity's own dataset registry rows (bounded) plus the
   * honest storage error; the rows ride the same 0.5 s status snapshot. */
  datasets?: DatasetView[]
  datasetsStorageError?: string
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
  /** Issue 77: the runs the user left behind by switching sessions; the
   * bounded observation ledger only, never a concurrency limit. */
  backgroundRuns?: { threadId: string; runId: string }[]
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

/**
 * Issue 110: the human terminal bridge (decision #59: a desktop-local process
 * in the Electron main, real PTY semantics, no Runtime). This is a separate
 * minimal seam next to — never inside — the trusted desktop:* bridge: the
 * surface is exactly spawn/write/resize/kill plus the data/exit push events,
 * with no filesystem or shell-wrapper capability. Terminal output is content,
 * not trusted UI, and never rides `window.ideer`.
 */
export interface TerminalSpawnView { sessionId: string }
export interface TerminalDataEvent { sessionId: string; data: string }
export interface TerminalExitEvent { sessionId: string; exitCode: number }
export interface TerminalBridge {
  /** Spawns one desktop-local PTY; the start dir is resolved in the trusted
   * main process (project-bound folder, user home as fallback) — the renderer
   * supplies no path, no command and receives no path back. */
  spawn(): Promise<TerminalSpawnView>
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  kill(sessionId: string): Promise<void>
  /** One push channel for all sessions; payloads name their session. */
  onData(listener: (event: TerminalDataEvent) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}
/** Bounded number of concurrent human terminal sessions. */
export const MAX_TERMINAL_SESSIONS = 12
/** Bounded bytes for one write (keystrokes or a paste), enforced in main. */
export const MAX_TERMINAL_WRITE = 1024 * 1024

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
  /** Issue 73: the model settings surface — the platform's authorized list,
   * the account default it shares with the Web, and the device-local
   * fallback pick. No provider or credential field crosses this bridge. */
  models(command: ModelCommand): Promise<ModelSettingsView>
  /** Issue 72: search, rename and delete platform threads, always re-reading
   * the Server's own list; deleting never clears local unconfirmed receipts.
   * Issue 91: `move` names the project a session joins, per the Server's own
   * move endpoint. */
  threads(command: ThreadCommand): Promise<ThreadView>
  /** Issue 91: platform project management — create, rename, archive,
   * restore and delete ride the Server's own Project API and every reply
   * re-reads its list; the desktop keeps no second roster and no local
   * state is bound to or cleared by a project operation. */
  projects(command: ProjectCommand): Promise<ProjectOperationView>
  /** Issue 102: 表格数据集导入 — the device parses XLSX/CSV into a real
   * registered dataset (multi-sheet, inferred column types), dedups by
   * content fingerprint and records the platform project association with
   * the row. File picking and confirmation stay in the trusted main
   * process; the original file never leaves the machine and a delete
   * removes the registry row only. */
  datasets(command: DatasetCommand): Promise<DatasetOperationView>
  /** Issue 85: the platform scheduled-tasks management surface. The renderer
   * names the action and the task fields only; the platform owns timing,
   * previews and execution records, and a delete is confirmed in the trusted
   * main process. 补跑/跳过 facts are device-local display truth keyed by the
   * planned point. */
  schedules(command: ScheduleCommand): Promise<SchedulesOutcome>
  /** Issue 84: the prompt-template plaza — account-scoped CRUD, categories,
   * usage counts and the `use` prefill record, all on the Server's own
   * endpoints. A click prefills the composer and never sends; new templates
   * are the Server's private rows, visible only to their creator. */
  templates(command: TemplateCommand): Promise<TemplateView>
  /** Issue 106: the welcome page's read-only official template selection,
   * always read live from the platform's own endpoint. Copying a row into
   * the account's own templates is the plain `templates` create — the two
   * surfaces share the one wire family but never each other's replies. */
  officialTemplates(command: OfficialTemplateCommand): Promise<OfficialTemplatesView>
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
  /** Issue 77: the notification center's one query/settle entry. */
  notifications(command: NotificationCommand): Promise<NotificationCenterView>
  /** Issue 94: the human file-browsing seam. list/read return guarded views
   * of the confirmed workspace; open/reveal resolve the physical path only in
   * the trusted main process and return nothing to the renderer. */
  files(command: FilesCommand): Promise<FilesListView | FilesPreview | void>
  /** Issue 115: the CAD viewer's read entry. The renderer names a
   * workspace-logical model file; the mesh conversion (OCCT for STEP, local
   * parsers for STL/OBJ) happens in the trusted main process and returns one
   * bounded geometry payload — never the file bytes or a physical path. */
  cad(command: CadCommand): Promise<CadMeshView>
  /** Issue 107: the browser pane's partition clear; the confirmation dialog
   * stays in the trusted main process, so an accidental click never wipes
   * login state on its own. */
  browser(command: BrowserCommand): Promise<void>
  /** Issue 77: the main process pushes the full bounded center list after
   * every change; the renderer replaces its view instead of merging. */
  onNotifications(listener: (view: NotificationCenterView) => void): () => void
  /** Issue 77: a notification (toast or center row) asked to open a session. */
  onNotificationActivate(listener: (payload: { id: string; threadId: string }) => void): () => void
  /** Issue 109: the remote browser entry's fixed command set (stream
   * open/close, input forwarding, explicit remote-file retrieval). The
   * stream socket and its platform credential stay inside the Runtime. */
  remoteBrowser(command: RemoteBrowserCommand): Promise<RemoteBrowserReply>
  /** Issue 109: the remote browser's one push channel — bounded display
   * facts only (pixel frames, url/tabs, honest errors); nothing is sent back. */
  onRemoteBrowserEvents(listener: (event: RemoteBrowserEvent) => void): () => void
  /** Issue 107: the main process pushes the bounded browser-pane facts; the
   * renderer renders them as-is and never synthesizes an event of its own. */
  onBrowserEvents(listener: (event: BrowserPaneEvent) => void): () => void
}

export interface InstallOutcome {
  installed: boolean
  stage: 'confirmed' | 'draining' | 'ready' | 'stopped' | 'applied' | 'launched' | 'blocked' | 'canceled' | 'failed'
  detail: string
}

/**
 * Issue 77: one background-session fact the owned Runtime reports on its
 * status stdout — a Run the user left running by switching sessions that has
 * since reached an end state, or a device approval ask on a session the user
 * cannot currently see. Identity facts only; payload bytes never ride it.
 * The union is the notification center's reuse seam: later tickets (tray
 * badge, installs, updates) extend it instead of rebuilding the surface.
 */
export type RuntimeNotifyEvent =
  | { kind: 'run-finished'; threadId: string; runId: string; status: string; title: string }
  | { kind: 'approval-required'; threadId: string; runId: string; taskId: string; approval: string; summary: string; title: string }

/** Issue 77: one recorded notification as the center shows it. `summary` is
 * the finished run's own status or the approval ask's one bounded line. */
export interface NotificationRecordView {
  id: string
  kind: RuntimeNotifyEvent['kind']
  threadId: string
  runId: string
  taskId?: string
  approval?: string
  title: string
  summary: string
  createdAt: string
  read: boolean
}

/** Issue 77: the full bounded center list plus its unread count; every reply
 * carries both so the renderer never merges local state. */
export interface NotificationCenterView { notifications: NotificationRecordView[]; unread: number }

/** Issue 77: the one Chinese fact wording both the OS toast (main) and the
 * notification center pane (renderer) read, so a label drift can never split
 * the two surfaces. Unmatched values fall back to the raw wire fact. */
export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  success: '成功', error: '出错', failed: '失败', interrupted: '已中断'
}
export const NOTIFICATION_APPROVAL_LABELS: Record<string, string> = {
  'file-write': '文件写入', 'skill-script': 'Skill 脚本', 'skill-dependencies': '技能依赖安装',
  'knowledge-material': '知识取材', 'browser-control': '本机浏览器控制'
}

/** Issue 77: list or settle the device's own notification ledger. */
export type NotificationCommand =
  | { action: 'list' }
  | { action: 'read'; id: string }
  | { action: 'read-all' }
  | { action: 'clear' }

/**
 * Issue 94: the human file-browsing seam over the confirmed workspace. The
 * renderer names a workspace-logical path plus one action only: a guarded
 * directory listing, a read-only preview, or an external open/reveal. The
 * paths stay logical end to end — the physical mapping is the Runtime's own
 * guarded resolution, `open`/`reveal` resolve in the trusted main process,
 * and no consent or approval fact appears anywhere on this surface (a human
 * looking at their own bound folder is free; the Agent's material-taking
 * keeps its approval flow).
 */
export type FilesCommand =
  | { action: 'list'; path: string }
  | { action: 'read'; path: string }
  | { action: 'open'; path: string }
  | { action: 'reveal'; path: string }

/** One guarded child entry of the workspace tree; `size` is bytes for files. */
export interface FilesEntry { name: string; kind: 'dir' | 'file'; size: number }

/** Bounded directory listing; `truncated` proves the cap instead of hiding it. */
export interface FilesListView { entries: FilesEntry[]; truncated: boolean }

/** Read-only preview facts: strict UTF-8 text or one sanctioned image form. */
export type FilesPreview =
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image'; mime: string; data: string }

/**
 * Issue 115: the CAD viewer's one invoke entry. The renderer names a
 * workspace-logical model file plus the fixed `read-mesh` action; the
 * workspace containment stays the Runtime's own guarded `locate` resolution,
 * the physical path and file bytes never reach the renderer, and the honest
 * caps (file size, triangle budget) are enforced in the trusted main process
 * — an over-cap model is refused with explicit counts, never silently
 * degraded. Geometry editing is out of scope by issue: the channel only reads.
 */
export type CadCommand = { action: 'read-mesh'; path: string }

/** Issue 115: which local parser produced the mesh (the original's format
 * subset: STL and OBJ parse directly, STEP triangulates through OCCT). */
export type CadMeshFormat = 'stl' | 'obj' | 'step'

/**
 * Issue 115: one converted mesh payload. `positions` is the flat xyz vertex
 * array and `indices` the triangle list; `stats` reports the loaded facts
 * (parts, vertices, triangles) so the pane can show the real size instead of
 * inventing one. Typed arrays ride the structured clone intact.
 */
export interface CadMeshView {
  format: CadMeshFormat
  positions: Float32Array
  indices: Uint32Array
  stats: CadMeshStats
}

/** Issue 115: the honest size facts of one loaded model. `meshes` counts the
 * parts the converter produced (1 for direct STL/OBJ parses). */
export interface CadMeshStats { meshes: number; vertices: number; triangles: number }

/**
 * Issue 115: the CAD viewer's caps, shared by the trusted main service that
 * enforces them and the pane whose refusal texts state them — one vocabulary,
 * so the enforced number and the displayed number can never drift.
 * The file cap is the original viewer's STEP limit, now covering every
 * format; the triangle budget is the software-render policy on the
 * disabled-GPU baseline (docs/porting.md, 2026-11-07).
 */
export const CAD_MAX_FILE_BYTES = 100 * 1024 * 1024
export const CAD_MAX_TRIANGLES = 1_000_000

/**
 * Issue 107: the local browser pane's one fixed session partition. Login
 * state, cookies and site data live here — never in the app's default session
 * (which carries the device's own surfaces) and never in the system browser.
 * The renderer may only attach webviews with exactly this partition, and the
 * trusted main process validates that at attachment time.
 */
export const BROWSER_PARTITION = 'persist:browser-pane'

/** Issue 107: the browser pane's one invoke entry — clearing the partition.
 * The confirmation dialog stays in the trusted main process. */
export type BrowserCommand = { action: 'clear' }

/**
 * Issue 107: the bounded facts the main process pushes while the browser pane
 * is in use. Every entry is one observable device-side fact (a denied
 * permission ask, one download's phase, a blocked navigation, a new-window
 * request routed to the owning pane, a finished partition clear); nothing
 * here carries page content, and the pane renders exactly what happened.
 * Issue 108 adds the agent-control fact: one announce line per consented
 * agent action on this pane (开工前标示), naming intent and target only.
 */
export type BrowserPaneEvent =
  | { kind: 'permission'; permission: string; origin: string }
  | { kind: 'download'; phase: 'started' | 'completed' | 'canceled' | 'interrupted' | 'rejected'; filename: string; reason?: string }
  | { kind: 'navigation-blocked'; url: string }
  | { kind: 'window-open'; contentsId: number; url: string }
  | { kind: 'agent-control'; intent: 'observe' | 'input' | 'submit' | 'download'; action: string; url: string }
  | { kind: 'cleared' }

/** Issue 107: the one Chinese permission wording the pane reads; unmatched
 * values fall back to the raw wire fact, exactly like the notification labels. */
export const BROWSER_PERMISSION_LABELS: Record<string, string> = {
  media: '摄像头/麦克风', geolocation: '地理位置', notifications: '通知',
  openExternal: '打开外部应用', pointerLock: '鼠标指针锁定', fullScreen: '全屏',
  'clipboard-read': '读取剪贴板', 'clipboard-sanitized-write': '写入剪贴板',
  'display-capture': '屏幕捕捉', midiSysex: 'MIDI 设备', mediaKeySystem: '受保护内容(DRM)'
}

/**
 * Issue 107: the external-content scheme boundary, shared by the renderer's
 * address bar and the main process's navigation chokepoint. Only http(s)
 * documents load in the browser pane; `file:` and every other scheme are not
 * a browser-pane navigation, because a document outside the web would turn
 * the pane into a local-file viewer.
 */
export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Issue 107: the address-bar grammar. A full http(s) URL goes as-is; a bare
 * host (dotted name, `localhost`, IPv4, optional port/path) becomes an
 * https:// URL. Anything else — search text, `file:` paths, `javascript:` —
 * is rejected with no search-engine fallback: the pane navigates where the
 * user actually names, and inventing a search provider would fabricate a
 * destination the user never chose.
 */
export function sanitizeAddress(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return isWebUrl(trimmed) ? trimmed : null
  if (/\s|\\/.test(trimmed)) return null
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?([/?#].*)?$/i.test(trimmed)) return null
  const candidate = `https://${trimmed}`
  return isWebUrl(candidate) ? candidate : null
}

/** Issue 74: the three session permission tiers; a loaded session always
 * starts at the lowest one and a tier choice never outlives the session. */
export type SessionTierValue = 'ask_first' | 'autonomous' | 'full'

/** The tier values in ascending order; the single source the main-process
 * validator and the chat switcher both read. */
export const SESSION_TIERS: readonly SessionTierValue[] = ['ask_first', 'autonomous', 'full']

/** Issue 75: the mounted-Skill bound one composer carries per message. The
 * platform injects at most one explicit Skill per run (the first chip); the
 * bound exists so the wire stays finite, not to fake a wider seam. */
export const MAX_MESSAGE_SKILLS = 8

/** Issue 78: the bound on one branch command's turn group — the assistant
 * message ids of the single turn the user branches from. */
export const MAX_BRANCH_TURN_MESSAGES = 64

/** Issue 93: 对话附件去向选择器。每条附件的去向由用户显式选择，默认
 * "发送解析文本"（设备侧解析，原件不出电脑），显式可选"上传原件"（平台
 * Thread 附件、跨设备可见）；"仅本机查看"是独立的 attachment-view 命令，
 * 从不随消息发送。去向绝不默默执行。 */
export const MAX_MESSAGE_ATTACHMENTS = 8
/** The device-local path bound on one attachment fact; generous enough for
 * deep Windows paths, still a wire bound. */
export const MAX_ATTACHMENT_PATH = 4096
export const MAX_ATTACHMENT_NAME = 256
export type ChatAttachmentDestination = 'parsed-text' | 'upload'
/** The destination the composer carries per chip; `local-view` executes the
 * attachment-view command immediately and never rides a send. */
export type ChatAttachmentChoice = ChatAttachmentDestination | 'local-view'
export interface ChatAttachment {
  id: string
  path: string
  name: string
  destination: ChatAttachmentDestination
}
export const ATTACHMENT_DESTINATION_LABELS: Record<ChatAttachmentChoice, string> = {
  'parsed-text': '发送解析文本（默认）', upload: '上传原件（平台附件）', 'local-view': '仅本机查看'
}

/** Issue 75: the at-mention delegation and slash-skill semantics ride the
 * send command as structured, optional facts. `delegateAgentId` names the
 * agent the user at-mentioned for THIS message: the platform sub-agent
 * delegation stays inside the current session (the main Agent and Thread are
 * unchanged, in contrast to `create`, which opens a new session). `skillIds`
 * carries the skills the user explicitly mounted in the composer, first chip
 * first: the runtime maps the first onto the platform's per-run explicit
 * Skill seam (must-use, never trigger-guessed) and records the whole mount
 * on the run. The account's own trigger-preference injection applies only on
 * runs without an explicit Skill, and only the Server ever matches it.
 * Issue 76: `collab` is the composer's mode switch, sent as an explicit
 * boolean on every send. It maps onto the platform's own delegation seam
 * (`context.subagent_enabled`) — true lets the lead Agent dispatch parallel
 * sub-agents for this run, false is the single-Agent mode. The platform's
 * own silent default is delegation OFF, matching the Web client's mode
 * switch, so "on" must be said explicitly; the team composition still stays
 * the lead Agent's own configuration and no local orchestration channel
 * exists. */
export type ChatCommand =
  | { action: 'state' | 'refresh' | 'compatibility' }
  // Issue 91: `projectId` names the selected project a new session belongs
  // to, riding the Server's own project assignment; absent stays the
  // loose-session path. The Server fails closed on a missing, foreign or
  // archived project.
  | { action: 'create'; scope: string; agentId: string; skillId?: string; projectId?: string }
  | { action: 'open' | 'reconnect'; scope: string; threadId: string }
  | { action: 'stop'; scope: string; threadId: string; runId: string }
  | { action: 'send'; scope: string; threadId: string; turnId: string; text: string;
    delegateAgentId?: string; skillIds?: string[]; collab?: boolean;
    /** Issue 93: the per-attachment destinations the user picked in the
     * composer. Paths are device-local facts for the Runtime to read and
     * parse; no content ever rides the command. */
    attachments?: ChatAttachment[] }
  | { action: 'set-model'; scope: string; threadId: string; modelName: string }
  | { action: 'answer'; scope: string; threadId: string; turnId: string; requestId: string; text?: string; optionId?: string }
  | { action: 'consent'; scope: string; threadId: string; runId: string; taskId: string; requestHash: string;
    decision: 'allow' | 'allow-directory' | 'deny'; rememberScript?: boolean }
  | { action: 'upload'; scope: string; threadId: string; runId: string; taskId: string; decision: 'allow' }
  | { action: 'download'; scope: string; threadId: string; artifactId: string }
  // Issue 79: the conversation export. The renderer names the mode and target
  // only; the document is derived in the trusted main process from the
  // Runtime's own state reply, and the destination stays a native dialog.
  | { action: 'export'; scope: string; threadId: string; mode: 'session' | 'message'; messageId?: string }
  | { action: 'tier'; scope: string; threadId: string; tier: SessionTierValue; confirm?: true }
  /** Issue 78: 消息级分支. The renderer names the target turn only — one
   * assistant message plus, when the transcript groups more than one, the
   * rest of that turn's assistant ids. The Runtime resolves the branch on
   * the platform's own Thread branch endpoint and reopens the new Thread;
   * no title, no content and no local copy ever ride this command. */
  | { action: 'branch'; scope: string; threadId: string; messageId: string; messageIds?: string[] }
  /** Issue 93: 仅本机查看. The composer dispatches it the moment the user
   * picks that destination for one attachment; the Runtime parses on the
   * device and answers with a bounded read-only display record. Nothing is
   * uploaded, no run is created and nothing enters the conversation. */
  | { action: 'attachment-view'; scope: string; threadId: string; id: string; path: string; name: string }

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
/** Issue 79: the card title and the export section heading must stay the same
 * words — the export mirrors the interface by construction, not by assertion. */
export function messageRoleLabel(message: Pick<ChatMessage, 'role' | 'name'>): string {
  return message.role === 'human' ? '你' : message.role === 'ai' ? 'Agent' : `工具 ${message.name}`
}

/** Issue 76: one parallel sub-agent the platform's lead Agent dispatched
 * through its own task tool. Every field is a bounded projection of the
 * platform's own task_* custom events (or the parent AI message's published
 * tool_calls for the type name) — the desktop renders exactly the states the
 * platform pushed and never invents a transition, so a task whose start was
 * seen but whose end was not stays `running`. `step`/`totalSteps` mirror the
 * platform's own message_index/total_messages; usage is the platform's
 * cumulative snapshot, replaced per event. */
export interface ChatSubagent {
  taskId: string
  description: string
  agent: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  step?: number | null
  totalSteps?: number | null
  model: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  result: string
  resultTruncated: boolean
  error: string
  errorTruncated: boolean
}
/** Issue 76/112: the platform's task_* status vocabulary in display form —
 * one shared map (antd Tag tokens included) so the chat progress card and
 * the office pane can never drift apart; a state the platform never pushed
 * has no view to borrow. */
export const SUBAGENT_STATUS_VIEWS: Record<ChatSubagent['status'], { label: string; color: string }> = {
  running: { label: '执行中', color: 'processing' }, completed: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' }, cancelled: { label: '已取消', color: 'warning' },
  timed_out: { label: '已超时', color: 'warning' }
}
/** Issue 39: one pending device decision the Desktop chat can settle — a
 * file write (#102), a Skill script run (#122), a knowledge material read
 * (#116), a Skill dependency install (#104), or an inline code run (#105).
 * Skill-script cards carry identity and scope facts only; a file write and
 * an inline code run show the exact bytes approval would put on disk or
 * execute, because those bytes are the decision. */
export interface LocalConsentView {
  taskId: string
  runId: string
  threadId: string
  requestHash: string
  kind: 'file-write' | 'skill-script' | 'skill-dependencies' | 'knowledge-material' | 'inline-code' | 'browser-control'
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
  /** Issue 104: the locked dependency entries and the configured source the
   * install ask names — the source is the only network destination the
   * approval covers. */
  entries?: { entry: string; name: string; version: string }[]
  source?: { kind: string; location: string }
  /** Issue 105: the inline task's pinned language and target root, plus the
   * full code the user is asked to approve. */
  language?: 'python' | 'node'
  workingRoot?: string
  script?: string
  /** Issue 108: the browser-control ask names the intent and the page
   * target; page content never rides the card. */
  intent?: 'observe' | 'input' | 'submit' | 'download'
  action?: string
  url?: string
}
/** Issue 73: the chat-side model facts. `model` names the resolved choice
 * for the next submission, its honest availability, and — after a fallback
 * switch — the displayed story of what happened. `modelOptions` mirrors the
 * platform's authorized list for the in-session selector. */
export interface ChatModelView {
  name: string
  source: 'session-override' | 'account-default' | 'platform-default'
  available: boolean
  reason: string
  notice: string
  switchedFrom: string
}
/** Issue 80: the last observed platform reachability, recorded at the
 * Runtime's one transport seam. An unreachable platform is an explicit
 * paused state — new Turns are refused with a named reason and recovery
 * reconnects by itself; before the first observation the display stays
 * optimistic (`reachable: true`). */
export interface PlatformReachabilityView {
  reachable: boolean
  detail: string
}
/** Issue 93: one attachment's destination outcome on a send reply. `parsed`
 * means the extracted text went into the conversation with the original
 * bytes never leaving the device; `uploaded` names the platform artifact;
 * `failed`/`skipped` carry the engine's own reason code. Identity facts
 * only — never content. */
export interface ChatAttachmentStatus {
  id: string
  name: string
  destination: ChatAttachmentDestination
  status: 'parsed' | 'uploaded' | 'failed' | 'skipped'
  sha256?: string
  artifactId?: string
  truncated?: boolean
  errorCode?: string
}
/** Issue 93: the bounded read-only display record for 仅本机查看. The text
 * comes from the device-side parse engine and its summary reuses the import
 * display record's facts (parser identity/version, page/table counts). */
export interface ChatAttachmentView {
  id: string
  name: string
  status: 'parsed' | 'failed' | 'skipped'
  text: string
  truncated: boolean
  errorCode?: string
  summary?: KnowledgeImportDocumentParseView
}
export interface ChatSnapshot {
  compatibility?: CompatibilityView
  /** Issue 80: present on every snapshot the Runtime returns. */
  platform?: PlatformReachabilityView
  artifacts?: PlatformArtifact[]
  /** Issue 93: the per-attachment destination outcomes on a send's own
   * reply snapshot — transient like exportStatus and never part of the
   * Runtime's own state. The composed message text is the durable record. */
  attachmentStatuses?: ChatAttachmentStatus[]
  /** Issue 93: the read-only display record on an attachment-view's own
   * reply; bounded device-side and never persisted anywhere. */
  attachmentView?: ChatAttachmentView
  /** Runtime-to-main only. Main consumes and removes bytes before returning IPC. */
  download?: PlatformArtifact & { content: string }
  downloadStatus?: 'saved' | 'cancelled'
  /** Issue 79: main-process export outcome on the reply snapshot; transient
   * like downloadStatus and never part of the Runtime's own state. A refusal
   * carries its code in exportError so the card can explain it locally
   * instead of presenting it as a Runtime or Server outage. */
  exportStatus?: 'saved' | 'cancelled' | 'failed'
  exportError?: string
  stop?: { runId: string; state: 'requested' | 'uncertain' } | null
  taskError?: string
  localTasks?: { task_id: string; run_id: string; tool_call_id?: string; capability: string; logical_target: string;
    status: string; stop_requested?: boolean; receipt_pending?: boolean; error_code?: string;
    receipt?: { status?: string; result_hash?: string; error_code?: string } | null;
    local?: { status: string; delivery_state: string; error_code?: string; receipt_hash?: string } | null;
    artifacts?: PlatformArtifact[];
    localResult?: LocalResultView | null }[]
  localConsents?: LocalConsentView[]
  /** Issue 74: this session's permission tier; absent means the lowest tier. */
  localTier?: SessionTierValue
  scope: string
  resources: { id: string; type: 'agent' | 'skill'; name: string; visibility: string; version: number | null; available: boolean; reason: string }[]
  threads: { id: string; title: string; status: string }[]
  thread: { id: string; status: string; agentId: string; skillId: string } | null
  messages: ChatMessage[]
  run: { id: string; status: string; selection: Record<string, unknown> } | null
  events: { id: string; event: string; detail: string }[]
  model?: ChatModelView
  modelOptions?: ModelRowView[]
  /** Issue 76: the current run's parallel sub-agents, as reported by the
   * platform's own task_* events; empty outside a dispatched run. */
  subagents: ChatSubagent[]
  stream: 'idle' | 'streaming' | 'disconnected' | 'uncertain'
  error: string
  lastEventId: string
}

/** Issue 109: one input event the remote browser pane forwards to the
 * platform's live browser stream (backend browser.py client->server input
 * events: click, move, down, up, wheel, key, text, navigate; back/forward/
 * activate_tab ride the same dispatch on the server). Coordinates are the
 * session's own viewport pixels; nothing else rides the wire. */
export type RemoteBrowserInputEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; dx: number; dy: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'activate_tab'; index: number }

/** Issue 109: the remote browser bridge commands. The stream belongs to an
 * authenticated platform Thread (identity facts ride open/retrieve); input
 * forwarding needs no identity of its own. Retrieval is the explicit
 * "fetch a remote file to this device" step and lands through the trusted
 * main process's native save dialog — the bytes never enter the renderer. */
export type RemoteBrowserCommand =
  | { action: 'open'; threadId: string; scope: string }
  | { action: 'close' }
  | { action: 'input'; event: RemoteBrowserInputEvent }
  | { action: 'retrieve'; threadId: string; artifactId: string; scope: string }

export interface RemoteBrowserTabRow { index: number; title: string; url: string; active: boolean }

/** Issue 109: the one push channel's events. A frame is a base64 JPEG of the
 * remote screen (external content rendered as pixels); every other kind is a
 * bounded display fact. The renderer can never send anything back on this
 * channel — commands ride the invoke only. */
export type RemoteBrowserEvent =
  | { kind: 'state'; state: 'connecting' | 'open' | 'closed'; code?: number; category?: string }
  | { kind: 'frame'; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'tabs'; tabs: RemoteBrowserTabRow[] }
  | { kind: 'nav-rejected'; url: string; message: string }
  | { kind: 'stream-error'; category: string; message: string }

export interface RemoteBrowserRetrieveResult { status: 'saved' | 'cancelled' }

export type RemoteBrowserReply = { streamId: string } | { acknowledged: true } | RemoteBrowserRetrieveResult
