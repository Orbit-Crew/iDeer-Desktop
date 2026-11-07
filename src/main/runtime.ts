import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatCommand, ChatSnapshot, ConnectorCommand, ConnectorInstallCommand, ConnectorInternalOutcome, ConnectorOutcome, ConnectorPreviewCommand, ConnectorView, DatasetCommand, DatasetImportCommand, DatasetOperationView, DatasetSheetView, DatasetView, FilesListView, FilesPreview, KnowledgeCleanupOutcome, KnowledgeDeleteOutcome, KnowledgeFolderJobView, KnowledgeGraphAskResult, KnowledgeGraphCommand, KnowledgeGraphQueryResult, KnowledgeGraphScopeRow, KnowledgeGraphSourceLocation, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeImportView, KnowledgeIndexJobView, KnowledgeIndexView, KnowledgePublicationView, KnowledgeSimilarityView, KnowledgePublishOutcome, KnowledgePublishPreview, LoginStatus, ModelCommand, ModelRowView, ModelSettingsView, OfficialTemplateCommand, OfficialTemplateRowView, OfficialTemplatesView, ProjectBindingView, ProjectBindCommand, ProjectCommand, ProjectOperationView, ProjectPermissionsView, ProjectView, ReceiptHistory, RuntimeNotifyEvent, RuntimeStatus, RuntimeTask, ScheduleCommand, ScheduleMarkView, ScheduleRunView, ScheduleTaskView, SchedulesOutcome, SessionTierValue, SkillImportEnvironmentView, SkillImportOutcome, SkillImportPermissionsView, SkillImportPreview, SkillImportView, SkillPackageFileView, SkillPreferenceCommand, SkillPreferencesView, SkillPublishOutcome, SkillScriptAuthorizationView, SkillScriptCommand, SkillScriptView, SkillTriggerPreferenceView, TemplateCommand, TemplateRowView, TemplateView, ThreadCommand, ThreadPermissionsView, ThreadRowView, ThreadView, WikiCommand, WikiNavigation, WikiPage, WikiPageSummary, WikiView } from '../shared/desktop'
import { MAX_ATTACHMENT_NAME, MAX_ATTACHMENT_PATH, MAX_BRANCH_TURN_MESSAGES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_SKILLS, SESSION_TIERS } from '../shared/desktop'
import { parseNotifyEvent } from './notifications'
import { agentBrowserResultWire, parseAgentBrowserCommandWire } from './agentBrowser'
import { parseRemoteBrowserStreamWire, validateRemoteBrowserInput, type RemoteBrowserStreamAck, type RemoteBrowserStreamMessage, type RemoteBrowserWireCommand } from './remoteBrowser'

/** Issue 102: one dataset sheet's bounded wire facts, shared by the status
 * snapshot and the family reply so a drift can never split the two. Exported
 * for the regression test that pins the registry's real wire shapes. */
export const toDatasetSheet = (input: unknown): DatasetSheetView => {
  const sheet = input as Record<string, unknown>
  if (!sheet || typeof sheet.name !== 'string' || typeof sheet.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sheet.fingerprint) || typeof sheet.schema !== 'string' ||
      !Number.isSafeInteger(sheet.rowCount) || !Number.isSafeInteger(sheet.colCount) ||
      typeof sheet.truncated !== 'boolean' || typeof sheet.columnsTruncated !== 'boolean') {
    throw new Error('Invalid dataset sheet')
  }
  return { name: sheet.name.slice(0, 128), fingerprint: sheet.fingerprint,
    schema: sheet.schema.slice(0, 500), rowCount: sheet.rowCount as number,
    colCount: sheet.colCount as number, truncated: sheet.truncated as boolean,
    columnsTruncated: sheet.columnsTruncated as boolean }
}
/** Issue 102: one device-local dataset row as the registry records it —
 * identity, schema and fingerprints only; a failed row always names its
 * fixed reason. Exported for the regression test that pins the registry's
 * real wire shapes. */
export const toDatasetView = (input: unknown): DatasetView => {
  const row = input as Record<string, unknown>
  const projectIdPattern = /^[A-Za-z0-9_-]{1,128}$/
  if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) ||
      typeof row.filename !== 'string' || typeof row.sourcePath !== 'string' ||
      typeof row.status !== 'string' || !['ready', 'failed'].includes(row.status) ||
      // A failed row that never recognized a supported format has no format:
      // '' is an honest fact for failed rows only (review finding, #102).
      ((row.format !== 'xlsx' && row.format !== 'csv') &&
        !(row.status === 'failed' && row.format === '')) ||
      typeof row.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.fileSha256) ||
      !Array.isArray(row.sheets) || !Number.isSafeInteger(row.rowCount) ||
      typeof row.projectId !== 'string' || (row.projectId && !projectIdPattern.test(row.projectId)) ||
      typeof row.deviceId !== 'string' ||
      (row.status === 'failed' ? typeof row.errorCode !== 'string' || !row.errorCode : false) ||
      typeof row.createdAt !== 'string') throw new Error('Invalid dataset row')
  // Issue 101: the optional knowledge revision binding reads exactly when it
  // was recorded; a partial one reads as unbound, never as a made-up identity.
  let revision: DatasetView['revision'] = null
  if (row.revision && typeof row.revision === 'object') {
    const bound = row.revision as Record<string, unknown>
    if (typeof bound.kbId === 'string' && bound.kbId && typeof bound.revisionId === 'string' &&
        bound.revisionId && Number.isSafeInteger(bound.revisionNo)) {
      revision = { kbId: bound.kbId.slice(0, 128), revisionId: bound.revisionId.slice(0, 128),
        revisionNo: bound.revisionNo as number }
    }
  }
  return { id: row.id, filename: row.filename.slice(0, 256), sourcePath: row.sourcePath.slice(0, 4096),
    format: row.format === 'xlsx' ? 'xlsx' : row.format === 'csv' ? 'csv' : '',
    fileSha256: row.fileSha256,
    sheets: row.sheets.slice(0, 32).map(toDatasetSheet),
    rowCount: row.rowCount as number, projectId: row.projectId, deviceId: row.deviceId.slice(0, 128),
    status: row.status === 'failed' ? 'failed' : 'ready',
    revision,
    errorCode: typeof row.errorCode === 'string' ? row.errorCode : '', createdAt: row.createdAt }
}

/** Owns one fixed, bundled executable. No renderer-supplied paths or commands. */
export class RuntimeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private snapshot: RuntimeStatus = { process: 'stopped', connection: 'offline', tasks: [] }
  private selectionScope = ''
  workspaceScope(): string { return this.selectionScope }
  private workspaceRequest: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null
  private stopping: Promise<void> | null = null
  private loginRequest: { origin: string; resolve: (url: string) => void; reject: (error: Error) => void } | null = null
  private loginOrigin = ''
  /** Origin of the currently authenticated pairing, including restored logins. */
  serverOrigin(): string { return this.loginOrigin }
  private chatRequests = new Map<string, { resolve: (state: ChatSnapshot) => void; reject: (error: Error) => void }>()
  private receiptRequests = new Map<string, { resolve: (state: ReceiptHistory) => void; reject: (error: Error) => void }>()
  private receiptScope = ''
  private knowledgeRequests = new Map<string, { resolve: (outcome: KnowledgeImportOutcome) => void; reject: (error: Error) => void }>()
  private knowledgePublishRequests = new Map<string, { resolve: (outcome: KnowledgePublishPreview | KnowledgePublishOutcome) => void; reject: (error: Error) => void }>()
  // Issue 96: the doc library's folder import (one background job) and the
  // batch management of the import records (delete, retry).
  private knowledgeFolderRequests = new Map<string, { resolve: (job: KnowledgeFolderJobView) => void; reject: (error: Error) => void }>()
  private knowledgeFolderCancelRequests = new Map<string, { resolve: (result: { canceled: boolean }) => void; reject: (error: Error) => void }>()
  // Issue 97: the index rebuild's single-slot request maps.
  private knowledgeIndexRequests = new Map<string, { resolve: (job: KnowledgeIndexJobView) => void; reject: (error: Error) => void }>()
  private knowledgeIndexCancelRequests = new Map<string, { resolve: (result: { canceled: boolean }) => void; reject: (error: Error) => void }>()
  private knowledgeDeleteRequests = new Map<string, { resolve: (result: { deleted: number }) => void; reject: (error: Error) => void }>()
  private knowledgeRetryRequests = new Map<string, { resolve: (outcome: KnowledgeImportOutcome) => void; reject: (error: Error) => void }>()
  // Issue 101: 删除=库新版本 (the successor revision a document-level delete
  // registered) and the separate physical cleanup (purge + 原件已不在).
  private knowledgeRevisionDeleteRequests = new Map<string, { resolve: (outcome: KnowledgeDeleteOutcome) => void; reject: (error: Error) => void }>()
  private knowledgeCleanupRequests = new Map<string, { resolve: (outcome: KnowledgeCleanupOutcome) => void; reject: (error: Error) => void }>()
  private knowledgeGraphRequests = new Map<string, { resolve: (view: KnowledgeGraphView | KnowledgeGraphSourceLocation | KnowledgeGraphQueryResult | KnowledgeGraphAskResult | KnowledgeSimilarityView) => void; reject: (error: Error) => void; action: KnowledgeGraphCommand['action'] }>()
  private knowledgeWikiRequests = new Map<string, { resolve: (view: WikiView | WikiPage | WikiNavigation) => void; reject: (error: Error) => void; action: WikiCommand['action'] }>()
  private skillImportRequests = new Map<string, { resolve: (outcome: SkillImportPreview | SkillImportOutcome) => void; reject: (error: Error) => void; phase: 'preview' | 'confirm' }>()
  private skillPublishRequests = new Map<string, { resolve: (outcome: SkillPublishOutcome) => void; reject: (error: Error) => void }>()
  private skillPreferenceRequests = new Map<string, { resolve: (view: SkillPreferencesView) => void; reject: (error: Error) => void }>()
  private skillScriptRequests = new Map<string, { resolve: (view: SkillScriptView) => void; reject: (error: Error) => void; action: SkillScriptCommand['action'] }>()
  private modelRequests = new Map<string, { resolve: (view: ModelSettingsView) => void; reject: (error: Error) => void }>()
  private threadRequests = new Map<string, { resolve: (view: ThreadView) => void; reject: (error: Error) => void; action: ThreadCommand['action'] }>()
  private projectRequests = new Map<string, { resolve: (view: ProjectOperationView) => void; reject: (error: Error) => void; action: ProjectCommand['action'] }>()
  /** Issue 102: the device-local dataset family's single in-flight round. */
  private datasetRequests = new Map<string, { resolve: (view: DatasetOperationView) => void; reject: (error: Error) => void; action: (DatasetCommand | DatasetImportCommand)['action'] }>()
  /** Issue 85: bounded in-flight management round-trips; the card drives
   * list + runs + preview concurrently, so it caps instead of serializing. */
  private schedulesRequests = new Map<string, { resolve: (view: SchedulesOutcome) => void; reject: (error: Error) => void; action: ScheduleCommand['action'] }>()
  private templateRequests = new Map<string, { resolve: (view: TemplateView | OfficialTemplatesView) => void; reject: (error: Error) => void; action: TemplateCommand['action'] | OfficialTemplateCommand['action'] }>()
  /** Issue 72: the chat session identity the owned Runtime last reported; the
   * sidebar's Thread management rides the same identity fence. */
  private chatScope = ''
  private connectorRequests = new Map<string, { resolve: (outcome: ConnectorInternalOutcome) => void; reject: (error: Error) => void; action: (ConnectorCommand | ConnectorPreviewCommand)['action'] }>()
  /** Issue 94: the human browsing seam's bounded in-flight set; the tree and
   * the preview drive it concurrently, so unlike the single-slot families it
   * caps instead of serializing. */
  private filesRequests = new Map<string, { resolve: (view: FilesListView | FilesPreview | { physical: string }) => void; reject: (error: Error) => void }>()
  private managementRequest: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null
  private healthRequest: { id: string; resolve: (value: { python: string; pid: number; echo: string }) => void; reject: (error: Error) => void } | null = null
  /** Issue 109: the remote browser stream's open/close rides one slot like
   * the other session families; input forwarding is high-rate by design and
   * stays a bounded map instead. */
  private browserStreamRequest: { id: string; action: 'open' | 'close'; resolve: (ack: RemoteBrowserStreamAck) => void; reject: (error: Error) => void } | null = null
  private browserInputRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  private remoteBrowserHandler: ((message: { streamId: string; event: RemoteBrowserStreamMessage['event'] }) => void) | null = null
  onRemoteBrowserEvent(handler: (message: RemoteBrowserStreamMessage) => void): void { this.remoteBrowserHandler = handler }
  /** Issue 108: the agent's consented local-browser actions the Runtime forwards. */
  private agentBrowserHandler: ((id: string, command: Record<string, unknown>) => void) | null = null
  onAgentBrowserCommand(handler: (id: string, command: Record<string, unknown>) => void): void { this.agentBrowserHandler = handler }
  /** Issue 77: background-session facts the Runtime reports between polls. */
  private notifyHandler: ((event: RuntimeNotifyEvent) => void) | null = null
  onNotify(handler: (event: RuntimeNotifyEvent) => void): void { this.notifyHandler = handler }
  receiptOwnershipScope(): string { return this.receiptScope }

  /** Issue 108: begin or abort the update drain on the owned Runtime. */
  async installDrain(action: 'begin' | 'abort'): Promise<void> {
    if (!['begin', 'abort'].includes(action)) throw new Error('DRAIN_ACTION_INVALID')
    if (!this.child || this.stopping || this.managementRequest || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.managementRequest = null; reject(new Error('DRAIN_TIMEOUT')) }, 30000)
      this.managementRequest = { id,
        resolve: () => { clearTimeout(timer); this.managementRequest = null; if (action === 'abort') this.maintenance = false; resolve() },
        reject: (error) => { clearTimeout(timer); this.managementRequest = null; reject(error) } }
      this.child!.stdin.write(JSON.stringify({ type: 'install-drain', id, action, scope: this.selectionScope }) + '\n')
    })
  }
  constructor(private readonly directory: string, private readonly profile: string, private maintenance = false,
    private readonly desktopVersion = '0.1.0') {}

  status(): RuntimeStatus {
    return structuredClone(this.snapshot)
  }

  async health(): Promise<{ python: string; pid: number; echo: string }> {
    if (!this.child || this.stopping || this.healthRequest) throw new Error('RUNTIME_HEALTH_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.healthRequest = null; reject(new Error('RUNTIME_HEALTH_TIMEOUT')) }, 10000)
      this.healthRequest = { id, resolve: value => { clearTimeout(timer); this.healthRequest = null; resolve(value) },
        reject: error => { clearTimeout(timer); this.healthRequest = null; reject(error) } }
      this.child!.stdin.write(JSON.stringify({ type: 'health', id, echo: 'ideer-update-health-v1' }) + '\n')
    })
  }

  /** Installation may proceed only after a graceful exit, never a forced timeout. */
  async stopForInstall(timeoutMs = 15000): Promise<void> {
    if (!this.child || this.stopping || this.snapshot.installDrain !== true || this.snapshot.activeTasks !== 0 ||
        this.snapshot.unknownWriteEffects !== 0 || this.snapshot.receiptStorageError) throw new Error('RUNTIME_STOP_NOT_SAFE')
    const child = this.child
    this.stopping = new Promise<void>((resolve, reject) => {
      const closed = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { child.removeListener('close', closed); reject(new Error('RUNTIME_STOP_UNCONFIRMED')) }, timeoutMs)
      child.once('close', closed)
      child.stdin.end('{"type":"shutdown"}\n')
    })
    try { await this.stopping } finally { this.stopping = null }
    if (this.child) throw new Error('RUNTIME_STOP_UNCONFIRMED')
    this.snapshot = { process: 'stopped', connection: 'offline', tasks: [] }
  }

  async manage(action: 'logout' | 'switch-account' | 'revoke', grantId = ''): Promise<void> {
    if (!['logout', 'switch-account', 'revoke'].includes(action) || typeof grantId !== 'string' ||
        (action === 'revoke' ? !/^[0-9a-f-]{36}$/.test(grantId) : grantId !== '')) throw new Error('MANAGEMENT_INVALID')
    if (!this.child || this.stopping || this.managementRequest || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.managementRequest = null; reject(new Error('MANAGEMENT_TIMEOUT')) }, 30000)
      this.managementRequest = { id,
        resolve: () => { clearTimeout(timer); this.managementRequest = null; resolve() },
        reject: (error) => { clearTimeout(timer); this.managementRequest = null; reject(error) } }
      this.child!.stdin.write(JSON.stringify({ type: 'manage', id, action, grantId, scope: this.selectionScope }) + '\n')
    })
  }

  async receipts(action: 'history' | 'clear-confirmed', offset = 0, expectedScope = this.receiptScope): Promise<ReceiptHistory> {
    if (!['history', 'clear-confirmed'].includes(action)) throw new Error('RECEIPT_ACTION_INVALID')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000000) throw new Error('RECEIPT_OFFSET_INVALID')
    if (action === 'clear-confirmed' && (!expectedScope || expectedScope !== this.receiptScope)) throw new Error('RECEIPT_BINDING_CHANGED')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    if (this.receiptRequests.size) throw new Error('RECEIPT_BUSY')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.receiptRequests.delete(id); reject(new Error('RECEIPT_TIMEOUT')) }, 15000)
      this.receiptRequests.set(id, {
        resolve: (state) => { clearTimeout(timer); this.receiptRequests.delete(id); resolve(state) },
        reject: (error) => { clearTimeout(timer); this.receiptRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'receipts', id, action, offset, scope: expectedScope }) + '\n')
    })
  }

  async selectWorkspace(path: string, scope: string): Promise<void> {
    if (!this.child || this.stopping || this.snapshot.login?.state !== 'authenticated') throw new Error('WORKSPACE_UNAVAILABLE')
    if (this.workspaceRequest) throw new Error('WORKSPACE_BUSY')
    if (!scope || scope !== this.selectionScope) throw new Error('WORKSPACE_BINDING_CHANGED')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.workspaceRequest = null; reject(new Error('WORKSPACE_TIMEOUT')) }, 30000)
      this.workspaceRequest = { id,
        resolve: () => { clearTimeout(timer); this.workspaceRequest = null; resolve() },
        reject: (error) => { clearTimeout(timer); this.workspaceRequest = null; reject(error) }
      }
      this.child!.stdin.write(JSON.stringify({ type: 'workspace', id, path, scope, confirmed: true }) + '\n')
    })
  }

  /**
   * Issue 94: the human file-browsing seam. `list`/`read` return guarded
   * views of the confirmed workspace; `locate` resolves the workspace's own
   * physical path for the trusted main process's external open and is never
   * forwarded to the renderer. The logical-path shape here only mirrors the
   * Runtime's gate — its store still owns the real containment decision.
   */
  async files(action: 'list' | 'read' | 'locate', path: string):
      Promise<FilesListView | FilesPreview | { physical: string }> {
    if (!['list', 'read', 'locate'].includes(action)) throw new Error('FILES_ACTION_INVALID')
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') ||
        path.includes('\0') || path.startsWith('//') || path.split('/').some((part) => part === '..') ||
        path.split('/').some((part) => part.includes(':')) || path.length > 4096) throw new Error('FILES_PATH_INVALID')
    if (this.filesRequests.size >= 8) throw new Error('FILES_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' ||
        this.snapshot.login?.state !== 'authenticated' || !this.selectionScope) throw new Error('WORKSPACE_UNAVAILABLE')
    if (this.snapshot.workspace?.state !== 'ready') throw new Error('WORKSPACE_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.filesRequests.delete(id); reject(new Error('FILES_TIMEOUT')) }, 30000)
      this.filesRequests.set(id, {
        resolve: (view) => { clearTimeout(timer); this.filesRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.filesRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'files', id, action, path, scope: this.selectionScope }) + '\n')
    })
  }

  /**
   * Issue 109: the remote browser stream's control path. The socket, the
   * access-token cookie and the paired origin all live inside the bundled
   * Runtime; main only names the fixed action set. Open/close ride one slot
   * (like the other session families) and shape-check before anything else;
   * input forwarding is high-rate by design and skips the single-slot gate.
   */
  async remoteBrowser(command: RemoteBrowserWireCommand): Promise<RemoteBrowserStreamAck> {
    if (!command || typeof command !== 'object') throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
    if (command.kind === 'stream') {
      if (command.action !== 'open' && command.action !== 'close') throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      if (command.action === 'open') {
        if (typeof command.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.threadId)) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
        if (typeof command.scope !== 'string' || command.scope.length < 1 || command.scope.length > 128) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      }
      if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
      if (this.snapshot.login?.state !== 'authenticated') throw new Error('REMOTE_BROWSER_UNAUTHENTICATED')
      if (this.browserStreamRequest) throw new Error('REMOTE_BROWSER_BUSY')
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.browserStreamRequest = null; reject(new Error('REMOTE_BROWSER_TIMEOUT')) }, 15000)
        this.browserStreamRequest = {
          id,
          action: command.action,
          resolve: (ack) => { clearTimeout(timer); this.browserStreamRequest = null; resolve(ack) },
          reject: (error) => { clearTimeout(timer); this.browserStreamRequest = null; reject(error) }
        }
        const wire: Record<string, unknown> = { type: 'browser-stream', id, action: command.action }
        if (command.action === 'open') { wire.threadId = command.threadId; wire.scope = command.scope }
        this.child!.stdin.write(JSON.stringify(wire) + '\n')
      })
    }
    if (command.kind === 'input') {
      if (typeof command.streamId !== 'string' || command.streamId.length < 1 || command.streamId.length > 64) throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
      validateRemoteBrowserInput(command.event)
      if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
      // The bounded in-flight set mirrors the Runtime's own input queue; a
      // flood overflows into an explicit error instead of unbounded memory.
      if (this.browserInputRequests.size >= 256) throw new Error('REMOTE_BROWSER_BUSY')
      const id = randomUUID()
      return new Promise<RemoteBrowserStreamAck>((resolve, reject) => {
        const timer = setTimeout(() => { this.browserInputRequests.delete(id); reject(new Error('REMOTE_BROWSER_TIMEOUT')) }, 15000)
        this.browserInputRequests.set(id, {
          resolve: () => { clearTimeout(timer); this.browserInputRequests.delete(id); resolve({ acknowledged: true }) },
          reject: (error) => { clearTimeout(timer); this.browserInputRequests.delete(id); reject(error) }
        })
        this.child!.stdin.write(JSON.stringify({ type: 'browser-input', id, streamId: command.streamId, event: command.event }) + '\n')
      })
    }
    throw new Error('REMOTE_BROWSER_COMMAND_INVALID')
  }

  /**
   * Issue 108: answer one consented local-browser action. The reply rides
   * stdin back to the Runtime's reader; the waiting task validates the
   * bounds itself, so an unknown or stale id is simply dropped there.
   */
  agentBrowserReply(id: string, result: unknown, error: string): void {
    if (!this.child || this.stopping) throw new Error('RUNTIME_UNAVAILABLE')
    if (typeof id !== 'string' || id.length < 1 || id.length > 64) throw new Error('AGENT_BROWSER_ID_INVALID')
    this.child.stdin.write(JSON.stringify(agentBrowserResultWire(id, result, error)) + '\n')
  }

  /** Issue 112: one explicit local import; identity manifest only, never content. */
  async importKnowledge(kbId: string, paths: string[]): Promise<KnowledgeImportOutcome> {
    if (typeof kbId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(kbId)) throw new Error('KNOWLEDGE_IMPORT_KB_INVALID')
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 200 ||
        paths.some((path) => typeof path !== 'string' || !path || path.length > 32768)) throw new Error('KNOWLEDGE_IMPORT_PATHS_INVALID')
    if (this.knowledgeRequests.size) throw new Error('KNOWLEDGE_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 60000)
      this.knowledgeRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.knowledgeRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.knowledgeRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-import', id, kbId, paths, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 96: start the doc library's background folder import. The reply is
   * the job's running view; progress and the honest outcome ride the status
   * snapshot, so the bridge never holds the job's lifetime open. */
  async importKnowledgeFolder(kbId: string, folder: string): Promise<KnowledgeFolderJobView> {
    if (typeof kbId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(kbId)) throw new Error('KNOWLEDGE_IMPORT_KB_INVALID')
    if (typeof folder !== 'string' || !folder || folder.length > 32768) throw new Error('KNOWLEDGE_IMPORT_PATHS_INVALID')
    if (this.knowledgeFolderRequests.size) throw new Error('KNOWLEDGE_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeFolderRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 60000)
      this.knowledgeFolderRequests.set(id, {
        resolve: (job) => { clearTimeout(timer); this.knowledgeFolderRequests.delete(id); resolve(job) },
        reject: (error) => { clearTimeout(timer); this.knowledgeFolderRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-folder-import', id, kbId, path: folder, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 96: cancel the running folder import at the next file or batch. */
  async cancelKnowledgeFolder(): Promise<{ canceled: boolean }> {
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeFolderCancelRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 15000)
      this.knowledgeFolderCancelRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); this.knowledgeFolderCancelRequests.delete(id); resolve(result) },
        reject: (error) => { clearTimeout(timer); this.knowledgeFolderCancelRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-folder-import-cancel', id }) + '\n')
    })
  }

  /** Issue 97: start one registered revision's background index rebuild. The
   * reply is the job's running view; progress and the honest outcome ride the
   * status snapshot, and the Runtime re-verifies every frozen digest. */
  async rebuildKnowledgeIndex(kbId: string, revisionId: string, manifestHash: string): Promise<KnowledgeIndexJobView> {
    if (typeof kbId !== 'string' || !kbId || kbId.length > 64) throw new Error('KNOWLEDGE_INDEX_KB_INVALID')
    if (typeof revisionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revisionId)) throw new Error('KNOWLEDGE_INDEX_REVISION_INVALID')
    if (typeof manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error('KNOWLEDGE_INDEX_MANIFEST_INVALID')
    if (this.knowledgeIndexRequests.size) throw new Error('KNOWLEDGE_INDEX_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeIndexRequests.delete(id); reject(new Error('KNOWLEDGE_INDEX_TIMEOUT')) }, 30000)
      this.knowledgeIndexRequests.set(id, {
        resolve: (job) => { clearTimeout(timer); this.knowledgeIndexRequests.delete(id); resolve(job) },
        reject: (error) => { clearTimeout(timer); this.knowledgeIndexRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-index-rebuild', id, kbId, revisionId, manifestHash, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 97: cancel the running index rebuild at the next document. */
  async cancelKnowledgeIndexRebuild(): Promise<{ canceled: boolean }> {
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeIndexCancelRequests.delete(id); reject(new Error('KNOWLEDGE_INDEX_TIMEOUT')) }, 15000)
      this.knowledgeIndexCancelRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); this.knowledgeIndexCancelRequests.delete(id); resolve(result) },
        reject: (error) => { clearTimeout(timer); this.knowledgeIndexCancelRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-index-rebuild-cancel', id }) + '\n')
    })
  }

  /** Issue 96: batch-delete selected import records (device-local rows only). */
  async deleteKnowledgeImports(ids: string[]): Promise<{ deleted: number }> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
        ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) throw new Error('KNOWLEDGE_IMPORT_IDS_INVALID')
    if (this.knowledgeDeleteRequests.size) throw new Error('KNOWLEDGE_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeDeleteRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 30000)
      this.knowledgeDeleteRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); this.knowledgeDeleteRequests.delete(id); resolve(result) },
        reject: (error) => { clearTimeout(timer); this.knowledgeDeleteRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-imports-delete', id, ids, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 96: re-import one failed record's stored files (one per command;
   * the renderer retries a multi-selection sequentially). */
  async retryKnowledgeImport(recordId: string): Promise<KnowledgeImportOutcome> {
    if (typeof recordId !== 'string' || !/^[0-9a-f]{64}$/.test(recordId)) throw new Error('KNOWLEDGE_IMPORT_ID_INVALID')
    if (this.knowledgeRetryRequests.size) throw new Error('KNOWLEDGE_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeRetryRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 60000)
      this.knowledgeRetryRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.knowledgeRetryRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.knowledgeRetryRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-import-retry', id, recordId, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 101: 删除=库新版本 — drop documents from one registered revision
   * (named by their frozen content hashes) by registering the surviving
   * frozen documents as the successor revision. The reply carries the new
   * revision identity and the historical record it supersedes; progress
   * facts ride the status snapshot as usual. */
  async deleteKnowledgeDocuments(kbId: string, revisionId: string, contentHashes: string[]): Promise<KnowledgeDeleteOutcome> {
    if (typeof kbId !== 'string' || !kbId || kbId.length > 64) throw new Error('KNOWLEDGE_INDEX_KB_INVALID')
    if (typeof revisionId !== 'string' || !revisionId || revisionId.length > 64) throw new Error('KNOWLEDGE_INDEX_REVISION_INVALID')
    if (!Array.isArray(contentHashes) || contentHashes.length < 1 || contentHashes.length > 200 ||
        contentHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) throw new Error('KNOWLEDGE_DELETE_DOCUMENTS_INVALID')
    if (this.knowledgeRevisionDeleteRequests.size) throw new Error('KNOWLEDGE_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeRevisionDeleteRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 60000)
      this.knowledgeRevisionDeleteRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.knowledgeRevisionDeleteRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.knowledgeRevisionDeleteRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-revision-delete-documents', id, kbId, revisionId,
        contentHashes, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 101: the user's separate physical cleanup — purge one revision's
   * device index rows and offline snapshots and mark its references 原件已不
   * 在. The renderer names the frozen identity only; the confirmation stays
   * in the trusted main process. */
  async cleanupKnowledgeRevision(kbId: string, revisionId: string, manifestHash: string): Promise<KnowledgeCleanupOutcome> {
    if (typeof kbId !== 'string' || !kbId || kbId.length > 64) throw new Error('KNOWLEDGE_INDEX_KB_INVALID')
    if (typeof revisionId !== 'string' || !revisionId || revisionId.length > 64) throw new Error('KNOWLEDGE_INDEX_REVISION_INVALID')
    if (typeof manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error('KNOWLEDGE_INDEX_MANIFEST_INVALID')
    if (this.knowledgeCleanupRequests.size) throw new Error('KNOWLEDGE_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeCleanupRequests.delete(id); reject(new Error('KNOWLEDGE_IMPORT_TIMEOUT')) }, 30000)
      this.knowledgeCleanupRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.knowledgeCleanupRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.knowledgeCleanupRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-revision-cleanup', id, kbId, revisionId,
        manifestHash, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 96: the bounded display view of the one background folder job;
   * anything malformed reads as absent instead of impersonating a state. */
  private parseKnowledgeFolderJob(raw: unknown): KnowledgeFolderJobView | null {
    if (!raw || typeof raw !== 'object') return null
    const job = raw as Record<string, unknown>
    if (!['running', 'completed', 'canceled', 'failed'].includes(job.state as string)) return null
    const count = (field: unknown): number => Number.isSafeInteger(field) && (field as number) >= 0 ? field as number : 0
    return {
      state: job.state as KnowledgeFolderJobView['state'],
      kbId: typeof job.kbId === 'string' ? job.kbId : '',
      folder: typeof job.folder === 'string' ? job.folder : '',
      totalFiles: count(job.totalFiles), processedFiles: count(job.processedFiles),
      registeredBatches: count(job.registeredBatches), registeredDocuments: count(job.registeredDocuments),
      failedBatches: count(job.failedBatches),
      skippedDuplicates: count(job.skippedDuplicates), skippedUnsupported: count(job.skippedUnsupported),
      skippedLinks: count(job.skippedLinks),
      truncated: job.truncated === true,
      error: typeof job.error === 'string' ? job.error : '',
      failures: Array.isArray(job.failures) ? job.failures.slice(0, 50).map((failure: { filename?: unknown; errorCode?: unknown }) => ({
        filename: typeof failure?.filename === 'string' ? failure.filename : '',
        errorCode: typeof failure?.errorCode === 'string' ? failure.errorCode : ''
      })) : []
    }
  }

  /** Issue 97: the bounded display view of the one background index rebuild
   * job; anything malformed reads as absent instead of impersonating a state. */
  private parseKnowledgeIndexJob(raw: unknown): KnowledgeIndexJobView | null {
    if (!raw || typeof raw !== 'object') return null
    const job = raw as Record<string, unknown>
    if (!['running', 'completed', 'canceled', 'failed'].includes(job.state as string)) return null
    const count = (field: unknown): number => Number.isSafeInteger(field) && (field as number) >= 0 ? field as number : 0
    return {
      state: job.state as KnowledgeIndexJobView['state'],
      kbId: typeof job.kbId === 'string' ? job.kbId : '',
      revisionId: typeof job.revisionId === 'string' ? job.revisionId : '',
      manifestHash: typeof job.manifestHash === 'string' ? job.manifestHash : '',
      totalDocuments: count(job.totalDocuments), processedDocuments: count(job.processedDocuments),
      indexedDocuments: count(job.indexedDocuments), driftedDocuments: count(job.driftedDocuments),
      unavailableDocuments: count(job.unavailableDocuments),
      error: typeof job.error === 'string' ? job.error : ''
    }
  }

  /** Issue 97: one revision's derived index facts on an import record; a
   * malformed view reads as absent instead of impersonating a state. */
  private parseKnowledgeIndexView(raw: unknown): KnowledgeIndexView | null {
    if (!raw || typeof raw !== 'object') return null
    const view = raw as Record<string, unknown>
    if (!['ready', 'partial', 'missing', 'failed'].includes(view.state as string)) return null
    const count = (field: unknown): number => Number.isSafeInteger(field) && (field as number) >= 0 ? field as number : 0
    return {
      state: view.state as KnowledgeIndexView['state'],
      documents: count(view.documents), indexedDocuments: count(view.indexedDocuments),
      servableDocuments: count(view.servableDocuments), driftedDocuments: count(view.driftedDocuments),
      builtAt: typeof view.builtAt === 'string' ? view.builtAt : '',
      error: typeof view.error === 'string' ? view.error : ''
    }
  }

  /** Issue 115: one explicit server publication step (preview or confirmed upload). */
  async publishKnowledge(kbId: string, revisionId: string, paths: string[], confirmed: boolean):
      Promise<KnowledgePublishPreview | KnowledgePublishOutcome> {
    if (typeof kbId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(kbId)) throw new Error('KNOWLEDGE_PUBLISH_KB_INVALID')
    if (typeof revisionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revisionId)) throw new Error('KNOWLEDGE_PUBLISH_REVISION_INVALID')
    if (typeof confirmed !== 'boolean') throw new Error('KNOWLEDGE_PUBLISH_CONFIRMATION_INVALID')
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 200 ||
        paths.some((path) => typeof path !== 'string' || !path || path.length > 32768)) throw new Error('KNOWLEDGE_PUBLISH_PATHS_INVALID')
    if (this.knowledgePublishRequests.size) throw new Error('KNOWLEDGE_PUBLISH_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgePublishRequests.delete(id); reject(new Error('KNOWLEDGE_PUBLISH_TIMEOUT')) }, confirmed ? 60000 : 30000)
      this.knowledgePublishRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.knowledgePublishRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.knowledgePublishRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'knowledge-publish', id, kbId, revisionId, paths, confirmed, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 116/117/99: one controlled-graph step (view / generate / source locate / scoped search / scoped ask / device similarity). */
  async knowledgeGraph(command: KnowledgeGraphCommand): Promise<KnowledgeGraphView | KnowledgeGraphSourceLocation | KnowledgeGraphQueryResult | KnowledgeGraphAskResult | KnowledgeSimilarityView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('KNOWLEDGE_GRAPH_COMMAND_INVALID')
    if (!['view', 'generate', 'locate', 'search', 'ask', 'similarity'].includes(command.action)) throw new Error('KNOWLEDGE_GRAPH_ACTION_INVALID')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (typeof command.kbId !== 'string' || !uuid.test(command.kbId)) throw new Error('KNOWLEDGE_GRAPH_KB_INVALID')
    if (typeof command.revisionId !== 'string' || !uuid.test(command.revisionId)) throw new Error('KNOWLEDGE_GRAPH_REVISION_INVALID')
    if (command.action === 'locate' && (typeof command.documentId !== 'string' || !/^[0-9a-fA-Z-]{1,64}$/.test(command.documentId))) throw new Error('KNOWLEDGE_GRAPH_DOCUMENT_INVALID')
    // Issue 117: the selected frozen-document scope and bounded text are the
    // caller's contract; the Server re-validates membership against the
    // manifest, so nothing here can widen into a whole-revision query.
    const scoped = command.action === 'search' || command.action === 'ask'
    if (scoped) {
      const limit = command.action === 'search' ? 512 : 4000
      if (!Array.isArray(command.documentIds) || command.documentIds.length < 1 || command.documentIds.length > 50 ||
          command.documentIds.some((id) => typeof id !== 'string' || !uuid.test(id))) throw new Error('KNOWLEDGE_GRAPH_SCOPE_INVALID')
      if (typeof command.query !== 'string' || command.query.trim().length < 1 || command.query.length > limit) throw new Error('KNOWLEDGE_GRAPH_QUERY_INVALID')
    }
    if (this.knowledgeGraphRequests.size) throw new Error('KNOWLEDGE_GRAPH_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeGraphRequests.delete(id); reject(new Error('KNOWLEDGE_GRAPH_TIMEOUT')) }, 60000)
      this.knowledgeGraphRequests.set(id, {
        resolve: (view) => { clearTimeout(timer); this.knowledgeGraphRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.knowledgeGraphRequests.delete(id); reject(error) },
        action: command.action
      })
      const wire: Record<string, unknown> = { type: 'knowledge-graph', id, kbId: command.kbId, revisionId: command.revisionId, action: command.action, scope: this.selectionScope }
      if (command.action === 'locate') wire.documentId = command.documentId
      if (scoped) { wire.documentIds = command.documentIds; wire.query = command.query }
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /** Issue 118/119: one controlled-wiki step (page list / generate / single-page read / index navigation). */
  async knowledgeWiki(command: WikiCommand): Promise<WikiView | WikiPage | WikiNavigation> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('KNOWLEDGE_WIKI_COMMAND_INVALID')
    if (!['view', 'generate', 'read', 'navigate'].includes(command.action)) throw new Error('KNOWLEDGE_WIKI_ACTION_INVALID')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (typeof command.kbId !== 'string' || !uuid.test(command.kbId)) throw new Error('KNOWLEDGE_WIKI_KB_INVALID')
    if (typeof command.revisionId !== 'string' || !uuid.test(command.revisionId)) throw new Error('KNOWLEDGE_WIKI_REVISION_INVALID')
    // Issue 118: the requested page must name a well-formed frozen document
    // id; the Server re-validates membership against the manifest, so an
    // out-of-scope page can never leak a title or a body.
    if (command.action === 'read' && (typeof command.documentId !== 'string' || !/^[0-9a-zA-Z_-]{1,64}$/.test(command.documentId))) throw new Error('KNOWLEDGE_WIKI_DOCUMENT_INVALID')
    if (this.knowledgeWikiRequests.size) throw new Error('KNOWLEDGE_WIKI_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running' || !this.selectionScope) throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.knowledgeWikiRequests.delete(id); reject(new Error('KNOWLEDGE_WIKI_TIMEOUT')) }, 60000)
      this.knowledgeWikiRequests.set(id, {
        resolve: (view) => { clearTimeout(timer); this.knowledgeWikiRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.knowledgeWikiRequests.delete(id); reject(error) },
        action: command.action
      })
      const wire: Record<string, unknown> = { type: 'knowledge-wiki', id, kbId: command.kbId, revisionId: command.revisionId, action: command.action, scope: this.selectionScope }
      if (command.action === 'read') wire.documentId = command.documentId
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /** Issue 120: one skill package step — the device-side preview or the confirmed upload. */
  async importSkill(kind: 'markdown' | 'zip' | 'directory',
      paths: string[], confirmed: boolean): Promise<SkillImportPreview | SkillImportOutcome> {
    if (!['markdown', 'zip', 'directory'].includes(kind)) throw new Error('SKILL_COMMAND_INVALID')
    if (!Array.isArray(paths) || paths.length !== 1 ||
        paths.some((path) => typeof path !== 'string' || !path || path.length > 32768)) throw new Error('SKILL_COMMAND_INVALID')
    if (typeof confirmed !== 'boolean') throw new Error('SKILL_COMMAND_INVALID')
    if (this.skillImportRequests.size) throw new Error('SKILL_IMPORT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.skillImportRequests.delete(id); reject(new Error('SKILL_IMPORT_TIMEOUT')) }, confirmed ? 120000 : 30000)
      this.skillImportRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.skillImportRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.skillImportRequests.delete(id); reject(error) },
        phase: confirmed ? 'confirm' : 'preview'
      })
      this.child!.stdin.write(JSON.stringify({ type: 'skills', id, action: 'import', kind, paths, confirmed, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 120: publish one confirmed import's draft through the platform's own flow. */
  async publishSkill(resourceId: string, expectedDraftRevision: number): Promise<SkillPublishOutcome> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (typeof resourceId !== 'string' || !uuid.test(resourceId)) throw new Error('SKILL_COMMAND_INVALID')
    if (!Number.isSafeInteger(expectedDraftRevision) || expectedDraftRevision < 1 || expectedDraftRevision > 1000000) throw new Error('SKILL_COMMAND_INVALID')
    if (this.skillPublishRequests.size) throw new Error('SKILL_PUBLISH_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.skillPublishRequests.delete(id); reject(new Error('SKILL_PUBLISH_TIMEOUT')) }, 60000)
      this.skillPublishRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.skillPublishRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.skillPublishRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'skills', id, action: 'publish', resourceId, expectedDraftRevision, scope: this.selectionScope }) + '\n')
    })
  }

  /** Issue 121: configure per-Skill trigger preferences. The command only
   * travels to the owned Runtime and on to the Server endpoints; the Desktop
   * never matches keywords and never drives the model. */
  async skillPreferences(command: SkillPreferenceCommand): Promise<SkillPreferencesView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('SKILL_PREFERENCE_COMMAND_INVALID')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const wire: Record<string, unknown> = { type: 'skill-preferences', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('SKILL_PREFERENCE_COMMAND_INVALID')
    } else {
      if (typeof command.skillId !== 'string' || !uuid.test(command.skillId)) throw new Error('SKILL_PREFERENCE_COMMAND_INVALID')
      wire.skillId = command.skillId
      if (command.action === 'clear') {
        if (Object.keys(command).length !== 2) throw new Error('SKILL_PREFERENCE_COMMAND_INVALID')
      } else {
        const bounds =
          Object.keys(command).length === 7 &&
          typeof command.enabled === 'boolean' &&
          typeof command.alwaysInject === 'boolean' &&
          typeof command.priority === 'number' && Number.isSafeInteger(command.priority) && command.priority >= -1000 && command.priority <= 1000 &&
          Array.isArray(command.keywords) && command.keywords.length <= 16 && command.keywords.every((keyword) => typeof keyword === 'string' && keyword.trim() !== '' && keyword.length <= 64) &&
          Array.isArray(command.applicableAgentIds) && command.applicableAgentIds.length <= 32 && command.applicableAgentIds.every((agentId) => typeof agentId === 'string' && uuid.test(agentId))
        if (!bounds) throw new Error('SKILL_PREFERENCE_COMMAND_INVALID')
        wire.enabled = command.enabled
        wire.keywords = command.keywords
        wire.alwaysInject = command.alwaysInject
        wire.applicableAgentIds = command.applicableAgentIds
        wire.priority = command.priority
      }
    }
    if (this.skillPreferenceRequests.size) throw new Error('SKILL_PREFERENCE_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.selectionScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.skillPreferenceRequests.delete(id); reject(new Error('SKILL_PREFERENCE_TIMEOUT')) }, 30000)
      this.skillPreferenceRequests.set(id, {
        resolve: (view) => { clearTimeout(timer); this.skillPreferenceRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.skillPreferenceRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /** Issue 122: list or revoke the device's remembered Skill script grants.
   * The registry lives in the owned Runtime and is binding-scoped; the
   * Desktop never grants execution from here — approvals happen in the
   * consent flow only. */
  async skillScripts(command: SkillScriptCommand): Promise<SkillScriptView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('SKILL_SCRIPT_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'skill-scripts', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('SKILL_SCRIPT_COMMAND_INVALID')
    } else {
      if (typeof command.authorizationId !== 'string' || !command.authorizationId || command.authorizationId.length > 128) throw new Error('SKILL_SCRIPT_COMMAND_INVALID')
      if (Object.keys(command).length !== 2) throw new Error('SKILL_SCRIPT_COMMAND_INVALID')
      wire.authorizationId = command.authorizationId
    }
    if (this.skillScriptRequests.size) throw new Error('SKILL_SCRIPT_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.selectionScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.skillScriptRequests.delete(id); reject(new Error('SKILL_SCRIPT_TIMEOUT')) }, 30000)
      this.skillScriptRequests.set(id, {
        action: command.action,
        resolve: (view) => { clearTimeout(timer); this.skillScriptRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.skillScriptRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /** Issue 73: the model settings surface. The command is a fixed per-action
   * key set that only reaches the owned Runtime and on to the platform's own
   * model/preference endpoints; no provider, Base URL or key field exists in
   * the family, and the account default rides the same setting the Web uses. */
  async models(command: ModelCommand): Promise<ModelSettingsView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('MODEL_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'models', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('MODEL_COMMAND_INVALID')
    } else {
      if (!['set-default', 'set-fallback'].includes(command.action)) throw new Error('MODEL_COMMAND_INVALID')
      if (typeof command.modelName !== 'string' || command.modelName.length > 200 ||
          Object.keys(command).length !== 2) throw new Error('MODEL_COMMAND_INVALID')
      wire.modelName = command.modelName
    }
    if (this.modelRequests.size) throw new Error('MODEL_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.selectionScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.modelRequests.delete(id); reject(new Error('MODEL_TIMEOUT')) }, 30000)
      this.modelRequests.set(id, {
        resolve: (view) => { clearTimeout(timer); this.modelRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.modelRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /**
   * Issue 72: the session sidebar's Thread management. The wire command is a
   * fixed per-action key set and always carries the chat session scope the
   * Runtime itself last reported, so a stale identity can never act on the
   * platform. Every reply carries the Server's own post-action list and the
   * account's Thread permissions; deletion happens only after a confirmed
   * main-process dialog and never touches the local receipt ledger.
   * Issue 91: `move` names the target project and rides the Server's own
   * move endpoint — the Server fails closed on a missing, foreign or
   * archived project.
   */
  async threads(command: ThreadCommand): Promise<ThreadView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('THREADS_COMMAND_INVALID')
    if (!['list', 'search', 'rename', 'delete', 'move'].includes(command.action)) throw new Error('THREADS_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'threads', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('THREADS_COMMAND_INVALID')
    } else if (command.action === 'search') {
      if (typeof command.query !== 'string' || command.query.length > 128 || Object.keys(command).length !== 2) throw new Error('THREADS_COMMAND_INVALID')
      wire.query = command.query
    } else if (command.action === 'move') {
      if (typeof command.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.threadId) ||
          typeof command.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId) ||
          Object.keys(command).length !== 3) throw new Error('THREADS_COMMAND_INVALID')
      wire.threadId = command.threadId
      wire.projectId = command.projectId
    } else {
      if (typeof command.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.threadId)) throw new Error('THREADS_COMMAND_INVALID')
      if (command.action === 'rename') {
        const title = typeof command.title === 'string' ? command.title.trim() : ''
        if (!title || title.length > 200 || Object.keys(command).length !== 3) throw new Error('THREADS_COMMAND_INVALID')
        wire.threadId = command.threadId
        wire.title = title
      } else {
        if (Object.keys(command).length !== 2) throw new Error('THREADS_COMMAND_INVALID')
        wire.threadId = command.threadId
      }
    }
    if (this.threadRequests.size) throw new Error('THREADS_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.chatScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.threadRequests.delete(id); reject(new Error('THREADS_TIMEOUT')) }, 30000)
      this.threadRequests.set(id, {
        action: command.action,
        resolve: (view) => { clearTimeout(timer); this.threadRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.threadRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /**
   * Issue 91: platform project management. The wire command is a fixed
   * per-action key set and always carries the chat session scope the Runtime
   * itself last reported; every reply re-reads the Server's own project list
   * and the account's project permissions. Deletion happens only after a
   * confirmed main-process dialog, and no operation here touches local files
   * or directory grants — the desktop keeps no second project roster.
   * Issue 92: the device-local binding actions join the family. bind-folder's
   * path is resolved and confirmed in the trusted main process; every reply
   * also carries this device's own binding rows.
   */
  async projects(command: ProjectCommand | ProjectBindCommand): Promise<ProjectOperationView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('PROJECTS_COMMAND_INVALID')
    if (!['list', 'create', 'rename', 'archive', 'restore', 'delete', 'bind-folder', 'unbind-folder'].includes(command.action)) throw new Error('PROJECTS_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'projects', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('PROJECTS_COMMAND_INVALID')
    } else if (command.action === 'create') {
      const name = typeof command.name === 'string' ? command.name.trim() : ''
      if (!name || name.length > 128 || Object.keys(command).length !== 2) throw new Error('PROJECTS_COMMAND_INVALID')
      wire.name = name
    } else if (command.action === 'rename') {
      const name = typeof command.name === 'string' ? command.name.trim() : ''
      if (typeof command.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId) ||
          !name || name.length > 128 || Object.keys(command).length !== 3) throw new Error('PROJECTS_COMMAND_INVALID')
      wire.projectId = command.projectId
      wire.name = name
    } else if (command.action === 'bind-folder') {
      const path = (command as ProjectBindCommand).path
      if (typeof command.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId) ||
          typeof path !== 'string' || !path || path.length > 1024 ||
          path.includes('\0') || Object.keys(command).length !== 3) throw new Error('PROJECTS_COMMAND_INVALID')
      wire.projectId = command.projectId
      wire.path = path
    } else {
      if (typeof command.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId) ||
          Object.keys(command).length !== 2) throw new Error('PROJECTS_COMMAND_INVALID')
      wire.projectId = command.projectId
    }
    if (this.projectRequests.size) throw new Error('PROJECTS_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.chatScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.projectRequests.delete(id); reject(new Error('PROJECTS_TIMEOUT')) }, 30000)
      this.projectRequests.set(id, {
        action: command.action,
        resolve: (view) => { clearTimeout(timer); this.projectRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.projectRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /**
   * Issue 102: 表格数据集导入. The wire command is a fixed per-action key set
   * that only reaches the owned Runtime and its device-local registry: import
   * names the main-process-picked file plus the renderer's selected project
   * (empty = unassociated), delete names the registry row. The scope rides
   * the workspace identity the Runtime itself last reported — the same fence
   * the other device-local families use — and the original file is only ever
   * read, never moved or removed.
   */
  async datasets(command: DatasetCommand | DatasetImportCommand): Promise<DatasetOperationView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('DATASETS_COMMAND_INVALID')
    if (!['import', 'delete'].includes(command.action)) throw new Error('DATASETS_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'datasets', id: '', action: command.action }
    if (command.action === 'import') {
      // The renderer-facing import command carries no path; only the
      // main-internal DatasetImportCommand reaches this far. The union is
      // not action-discriminable here, so the import shape is asserted and
      // every field is re-validated below. Issue 101: the optional knowledge
      // revision binding (three more keys) rides along — kb and revision
      // stand or fall together and the number is a bounded display fact.
      const picked = command as DatasetImportCommand
      const keyCount = Object.keys(command).length
      if (typeof picked.path !== 'string' || !picked.path || picked.path.length > 32768 ||
          typeof picked.projectId !== 'string' || picked.projectId.length > 128 ||
          (picked.projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(picked.projectId)) ||
          (keyCount !== 3 && keyCount !== 6)) throw new Error('DATASETS_COMMAND_INVALID')
      if (keyCount === 6 && (typeof picked.kbId !== 'string' || !picked.kbId ||
          picked.kbId.length > 128 || typeof picked.revisionId !== 'string' || !picked.revisionId ||
          picked.revisionId.length > 128 || !Number.isSafeInteger(picked.revisionNo) ||
          (picked.revisionNo as number) < 0 || (picked.revisionNo as number) > 1000000)) {
        throw new Error('DATASETS_COMMAND_INVALID')
      }
      wire.path = picked.path
      wire.projectId = picked.projectId
      if (keyCount === 6) {
        wire.kbId = picked.kbId
        wire.revisionId = picked.revisionId
        wire.revisionNo = picked.revisionNo
      }
    } else {
      if (typeof command.datasetId !== 'string' || !/^[0-9a-f]{64}$/.test(command.datasetId) ||
          Object.keys(command).length !== 2) throw new Error('DATASETS_COMMAND_INVALID')
      wire.datasetId = command.datasetId
    }
    if (this.datasetRequests.size) throw new Error('DATASETS_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.selectionScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.datasetRequests.delete(id); reject(new Error('DATASETS_TIMEOUT')) }, 60000)
      this.datasetRequests.set(id, {
        action: command.action,
        resolve: (view) => { clearTimeout(timer); this.datasetRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.datasetRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /**
   * Issue 85: the platform scheduled-tasks management surface. The wire
   * command is a fixed per-action key set that only reaches the owned Runtime
   * and on to the platform's own scheduled-tasks endpoints — the platform
   * owns timing, cron previews and execution records, so nothing here
   * computes or estimates a run time. The scope rides the same chat session
   * identity the threads family uses; the Runtime's facade is the fence.
   */
  async schedules(command: ScheduleCommand): Promise<SchedulesOutcome> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('SCHEDULES_COMMAND_INVALID')
    if (!['list', 'get', 'create', 'update', 'pause', 'resume', 'trigger', 'delete', 'runs', 'set-skip', 'preview'].includes(command.action)) throw new Error('SCHEDULES_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'schedules', id: '', action: command.action }
    const taskId = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('SCHEDULES_COMMAND_INVALID')
      return value
    }
    const draft = (value: unknown, required: readonly string[]): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCHEDULES_COMMAND_INVALID')
      const allowed = ['title', 'prompt', 'scheduleType', 'scheduleSpec', 'timezone', 'assistantId', 'contextMode', 'threadId']
      const keys = Object.keys(value)
      if (!keys.every((key) => allowed.includes(key)) || !required.every((key) => keys.includes(key))) throw new Error('SCHEDULES_COMMAND_INVALID')
      const row = value as Record<string, unknown>
      if ('title' in row && (typeof row.title !== 'string' || !row.title.trim() || row.title.trim().length > 200)) throw new Error('SCHEDULES_COMMAND_INVALID')
      if ('prompt' in row && (typeof row.prompt !== 'string' || row.prompt.length < 1 || row.prompt.length > 16000)) throw new Error('SCHEDULES_COMMAND_INVALID')
      if ('assistantId' in row) {
        if (typeof row.assistantId !== 'string' || row.assistantId.length > 128) throw new Error('SCHEDULES_COMMAND_INVALID')
        // Mirror the Runtime's normalization (trim, lowercase, _→-) and its
        // charset rule; '' means the platform default agent.
        const assistant = row.assistantId.trim().toLowerCase().replace(/_/g, '-')
        if (assistant && !/^[a-z0-9-]{1,128}$/.test(assistant)) throw new Error('SCHEDULES_COMMAND_INVALID')
      }
      if ('contextMode' in row && row.contextMode !== 'fresh_thread_per_run' && row.contextMode !== 'reuse_thread') throw new Error('SCHEDULES_COMMAND_INVALID')
      if ('threadId' in row) {
        if (typeof row.threadId !== 'string') throw new Error('SCHEDULES_COMMAND_INVALID')
        const threadOk = /^[A-Za-z0-9_-]{1,128}$/.test(row.threadId)
        if (row.contextMode === 'reuse_thread' ? !threadOk
          : row.contextMode === 'fresh_thread_per_run' ? row.threadId !== ''
          // Without the mode in the same patch the device cannot see the
          // task's context mode: mirror the platform's own ThreadId rule and
          // let the Server own mode consistency (empty is never useful — the
          // pinned update drops None).
          : !threadOk) throw new Error('SCHEDULES_COMMAND_INVALID')
      }
      if ('timezone' in row && (typeof row.timezone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,128}$/.test(row.timezone))) throw new Error('SCHEDULES_COMMAND_INVALID')
      if ('scheduleType' in row && row.scheduleType !== 'cron' && row.scheduleType !== 'interval' && row.scheduleType !== 'once') throw new Error('SCHEDULES_COMMAND_INVALID')
      if ('scheduleSpec' in row) {
        // A patch must name the type it edits against; the type itself never
        // reaches the platform (the pinned endpoint keeps it immutable).
        if (!('scheduleType' in row)) throw new Error('SCHEDULES_COMMAND_INVALID')
        if (!row.scheduleSpec || typeof row.scheduleSpec !== 'object' || Array.isArray(row.scheduleSpec)) throw new Error('SCHEDULES_COMMAND_INVALID')
        const spec = row.scheduleSpec as Record<string, unknown>
        const shape = Object.keys(spec).length === 1 &&
          ((row.scheduleType === 'cron' && typeof spec.cron === 'string' && spec.cron.length >= 1 && spec.cron.length <= 256) ||
            (row.scheduleType === 'interval' && Number.isSafeInteger(spec.everySeconds) && (spec.everySeconds as number) >= 60 && (spec.everySeconds as number) <= 2592000) ||
            // The pinned endpoint requires an aware datetime; the deep parse
            // stays on the Runtime side, this only mirrors its tz rule.
            (row.scheduleType === 'once' && typeof spec.runAt === 'string' && spec.runAt.length >= 1 && spec.runAt.length <= 64 &&
              !Number.isNaN(Date.parse(spec.runAt)) && /(Z|[+-]\d{2}:?\d{2})$/.test(spec.runAt)))
        if (!shape) throw new Error('SCHEDULES_COMMAND_INVALID')
      }
      return row
    }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('SCHEDULES_COMMAND_INVALID')
    } else if (command.action === 'get' || command.action === 'pause' || command.action === 'resume' || command.action === 'trigger' || command.action === 'delete') {
      wire.taskId = taskId(command.taskId)
      if (Object.keys(command).length !== 2) throw new Error('SCHEDULES_COMMAND_INVALID')
    } else if (command.action === 'create') {
      wire.task = draft(command.task, ['title', 'prompt', 'scheduleType', 'scheduleSpec', 'timezone', 'assistantId', 'contextMode', 'threadId'])
      if (Object.keys(command).length !== 2) throw new Error('SCHEDULES_COMMAND_INVALID')
    } else if (command.action === 'update') {
      wire.taskId = taskId(command.taskId)
      wire.task = draft(command.task, [])
      // scheduleType only validates the spec shape; a patch must carry at
      // least one field the pinned endpoint can actually update.
      const mappable = ['title', 'prompt', 'scheduleSpec', 'timezone', 'assistantId', 'contextMode', 'threadId']
      if (Object.keys(command).length !== 3 ||
          !Object.keys(wire.task as Record<string, unknown>).some((key) => mappable.includes(key))) throw new Error('SCHEDULES_COMMAND_INVALID')
    } else if (command.action === 'runs') {
      wire.taskId = taskId(command.taskId)
      if (!Number.isSafeInteger(command.limit) || (command.limit as number) < 1 || (command.limit as number) > 200 ||
          !Number.isSafeInteger(command.offset) || (command.offset as number) < 0 || (command.offset as number) > 1000000 ||
          Object.keys(command).length !== 4) throw new Error('SCHEDULES_COMMAND_INVALID')
      wire.limit = command.limit
      wire.offset = command.offset
    } else if (command.action === 'set-skip') {
      wire.taskId = taskId(command.taskId)
      if (typeof command.skipOnMissed !== 'boolean' || Object.keys(command).length !== 3) throw new Error('SCHEDULES_COMMAND_INVALID')
      wire.skipOnMissed = command.skipOnMissed
    } else {
      if (typeof command.cron !== 'string' || command.cron.length < 1 || command.cron.length > 256 ||
          typeof command.timezone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,128}$/.test(command.timezone) ||
          !Number.isSafeInteger(command.count) || (command.count as number) < 1 || (command.count as number) > 10 ||
          Object.keys(command).length !== 4) throw new Error('SCHEDULES_COMMAND_INVALID')
      wire.cron = command.cron
      wire.timezone = command.timezone
      wire.count = command.count
    }
    if (this.schedulesRequests.size >= 4) throw new Error('SCHEDULES_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.chatScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.schedulesRequests.delete(id); reject(new Error('SCHEDULES_TIMEOUT')) }, 60000)
      this.schedulesRequests.set(id, {
        action: command.action,
        resolve: (view) => { clearTimeout(timer); this.schedulesRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.schedulesRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /**
   * Issue 84: the prompt-template plaza. The wire command is a fixed
   * per-action key set that only reaches the owned Runtime and on to the
   * platform's own template endpoints, and always carries the chat session
   * scope the Runtime itself last reported so Python can re-fence the
   * identity. Every reply carries the Server's own post-action list; the
   * renderer's prefill is a local draft edit and the `use` action only
   * records the usage count — no text rides back to the platform as a send
   * from this family.
   */
  async templates(command: TemplateCommand): Promise<TemplateView> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('TEMPLATE_COMMAND_INVALID')
    if (!['list', 'create', 'update', 'delete', 'use'].includes(command.action)) throw new Error('TEMPLATE_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'templates', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('TEMPLATE_COMMAND_INVALID')
    } else if (command.action === 'create') {
      const name = typeof command.name === 'string' ? command.name.trim() : ''
      if (!name || name.length > 200 || typeof command.category !== 'string' || command.category.length > 64 ||
          typeof command.content !== 'string' || !command.content.trim() || command.content.length > 16000 ||
          Object.keys(command).length !== 4) throw new Error('TEMPLATE_COMMAND_INVALID')
      wire.name = name
      wire.category = command.category
      wire.content = command.content
    } else if (command.action === 'update') {
      if (typeof command.templateId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.templateId)) throw new Error('TEMPLATE_COMMAND_INVALID')
      const fields: Record<string, string> = {}
      let provided = 0
      if (command.name !== undefined) {
        const name = typeof command.name === 'string' ? command.name.trim() : ''
        if (!name || name.length > 200) throw new Error('TEMPLATE_COMMAND_INVALID')
        fields.name = name
        provided += 1
      }
      if (command.category !== undefined) {
        if (typeof command.category !== 'string' || command.category.length > 64) throw new Error('TEMPLATE_COMMAND_INVALID')
        fields.category = command.category
        provided += 1
      }
      if (command.content !== undefined) {
        if (typeof command.content !== 'string' || !command.content.trim() || command.content.length > 16000) throw new Error('TEMPLATE_COMMAND_INVALID')
        fields.content = command.content
        provided += 1
      }
      if (provided === 0 || Object.keys(command).length !== 2 + provided) throw new Error('TEMPLATE_COMMAND_INVALID')
      wire.templateId = command.templateId
      Object.assign(wire, fields)
    } else {
      if (typeof command.templateId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.templateId) ||
          Object.keys(command).length !== 2) throw new Error('TEMPLATE_COMMAND_INVALID')
      wire.templateId = command.templateId
    }
    return this.sendTemplateWire(command.action, wire) as Promise<TemplateView>
  }

  /**
   * Issue 106: the welcome page's one official-template read. It rides the
   * same single-slot template family — same scope fencing, same bounds —
   * against the platform's own official endpoint, and the reply carries the
   * official rows only. The read stays live on every mount, so the display
   * follows platform updates; copying a row into the account's own
   * templates is the plain create on `templates`, never this family.
   */
  async officialTemplates(command: OfficialTemplateCommand): Promise<OfficialTemplatesView> {
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        command.action !== 'official-list' || Object.keys(command).length !== 1) throw new Error('TEMPLATE_COMMAND_INVALID')
    return this.sendTemplateWire(command.action, { type: 'templates', id: '', action: command.action }) as Promise<OfficialTemplatesView>
  }

  /** Issue 84/106: the template family's one single-slot round trip — the
   * busy gate, the live-child check, the 30s timeout and the scoped wire
   * write are shared by every action in the family; only the parse branch
   * distinguishes the replies. The union return narrows at the two call
   * sites because each action's reply is produced by its own branch below. */
  private sendTemplateWire(action: TemplateCommand['action'] | OfficialTemplateCommand['action'],
                           wire: Record<string, unknown>): Promise<TemplateView | OfficialTemplatesView> {
    if (this.templateRequests.size) throw new Error('TEMPLATE_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.chatScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.templateRequests.delete(id); reject(new Error('TEMPLATE_TIMEOUT')) }, 30000)
      this.templateRequests.set(id, {
        action,
        resolve: (view) => { clearTimeout(timer); this.templateRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.templateRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  /**
   * Issue 123: the device's connector installer. The wire command is a
   * fixed per-action key set; the candidate path arrives only for the
   * main-internal preview/confirmed-install calls and never routes through
   * the renderer. Fixed CONNECTOR_* categories come back as rejections.
   */
  async connectors(command: ConnectorCommand): Promise<ConnectorOutcome>
  async connectors(command: ConnectorPreviewCommand | ConnectorInstallCommand): Promise<ConnectorInternalOutcome>
  async connectors(command: ConnectorCommand | ConnectorPreviewCommand | ConnectorInstallCommand): Promise<ConnectorInternalOutcome> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('CONNECTOR_COMMAND_INVALID')
    if (!['preview', 'install', 'remove', 'list'].includes(command.action)) throw new Error('CONNECTOR_COMMAND_INVALID')
    const wire: Record<string, unknown> = { type: 'connectors', id: '', action: command.action }
    if (command.action === 'list') {
      if (Object.keys(command).length !== 1) throw new Error('CONNECTOR_COMMAND_INVALID')
    } else if (command.action === 'remove') {
      if (typeof command.slug !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(command.slug) || Object.keys(command).length !== 2) throw new Error('CONNECTOR_COMMAND_INVALID')
      wire.slug = command.slug
      wire.confirmed = true
    } else {
      // Preview and the confirmed install both carry the located path; an
      // install without one (renderer-shaped) is not a runtime command.
      const path = (command as { path?: unknown }).path
      if (typeof path !== 'string' || !path || path.length > 32768 || Object.keys(command).length !== 2) throw new Error('CONNECTOR_COMMAND_INVALID')
      wire.path = path
      wire.confirmed = command.action === 'install'
    }
    if (this.connectorRequests.size) throw new Error('CONNECTOR_BUSY')
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    const id = randomUUID()
    wire.id = id
    wire.scope = this.selectionScope
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.connectorRequests.delete(id); reject(new Error('CONNECTOR_TIMEOUT')) }, 30000)
      this.connectorRequests.set(id, {
        resolve: (outcome) => { clearTimeout(timer); this.connectorRequests.delete(id); resolve(outcome) },
        reject: (error) => { clearTimeout(timer); this.connectorRequests.delete(id); reject(error) },
        action: command.action
      })
      this.child!.stdin.write(JSON.stringify(wire) + '\n')
    })
  }

  async chat(command: ChatCommand): Promise<ChatSnapshot> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('CHAT_COMMAND_INVALID')
    const keys: Record<string, string[]> = {
      state: ['action'], refresh: ['action'], compatibility: ['action'], create: ['action', 'scope', 'agentId', 'skillId', 'projectId'],
      open: ['action', 'scope', 'threadId'], reconnect: ['action', 'scope', 'threadId'],
      stop: ['action', 'scope', 'threadId', 'runId'],
      send: ['action', 'scope', 'threadId', 'turnId', 'text', 'delegateAgentId', 'skillIds', 'collab', 'attachments'],
      // Issue 73: the session's temporary model choice; '' clears back to the
      // account default resolution chain. The model name is bounded at the
      // same 200 characters the platform preference accepts.
      'set-model': ['action', 'scope', 'threadId', 'modelName'],
      answer: ['action', 'scope', 'threadId', 'turnId', 'requestId', 'text', 'optionId'],
      consent: ['action', 'scope', 'threadId', 'runId', 'taskId', 'requestHash', 'decision'],
      upload: ['action', 'scope', 'threadId', 'runId', 'taskId', 'decision'],
      download: ['action', 'scope', 'threadId', 'artifactId'],
      // Issue 74: confirm may ride a full-tier switch only; the main process
      // adds it after its own confirmation dialog, the renderer never does.
      tier: ['action', 'scope', 'threadId', 'tier', 'confirm'],
      // Issue 78: the branch names the target turn only; the Runtime resolves
      // it on the platform's own Thread branch endpoint.
      branch: ['action', 'scope', 'threadId', 'messageId', 'messageIds'],
      // Issue 93: 仅本机查看 names one composer-picked attachment; the Runtime
      // parses it on the device and answers with a bounded display record.
      'attachment-view': ['action', 'scope', 'threadId', 'id', 'path', 'name']
    }
    const allowed = keys[command.action]
    // Issue 93: one attachment's identity facts are bounded strings — the
    // shared check for the send list and the local-view command.
    const boundedAttachmentFact = (value: unknown, max: number): value is string =>
      typeof value === 'string' && value.length > 0 && value.length <= max
    if (command.action === 'stop' && (Object.keys(command).length !== 4 || !command.scope || !command.threadId || !command.runId)) throw new Error('CHAT_COMMAND_INVALID')
    // Issue 39: a script approval may carry rememberScript; nothing else may
    // add keys to the fixed consent shape.
    const consentKeys = Object.keys(command).length - (command.action === 'consent' && (command as { rememberScript?: unknown }).rememberScript === true ? 1 : 0)
    if (command.action === 'consent' && (consentKeys !== 7 || !['allow', 'allow-directory', 'deny'].includes(command.decision) ||
        ((command as { rememberScript?: unknown }).rememberScript !== undefined && typeof (command as { rememberScript?: unknown }).rememberScript !== 'boolean') ||
        !/^[0-9a-f]{64}$/.test(command.requestHash))) throw new Error('CHAT_COMMAND_INVALID')
    // Issue 74: a tier switch names exactly one tier; only the full tier may
    // carry the confirm flag, and only as the literal true the main process
    // signs after its own dialog.
    if (command.action === 'tier') {
      const tierCommand = command as unknown as { tier?: unknown; confirm?: unknown }
      if (!SESSION_TIERS.includes(tierCommand.tier as SessionTierValue) ||
          (tierCommand.tier === 'full'
            ? (tierCommand.confirm !== true || Object.keys(command).length !== 5)
            : (tierCommand.confirm !== undefined || Object.keys(command).length !== 4))) throw new Error('CHAT_COMMAND_INVALID')
    }
    // Issue 75: the at-mention delegation and the mounted skills ride the
    // send command as structured facts. The delegate is one bounded resource
    // id; the mounted skills are 1..MAX_MESSAGE_SKILLS unique resource ids in
    // pick order (first chip first — the Runtime maps it onto the platform's
    // one explicit Skill per run). Both are optional; absent means a plain
    // message with no per-message input commands. Issue 76: `collab` is the
    // composer's collab mode switch, boolean whenever the composer sends.
    if (command.action === 'send') {
      const inputCommand = command as unknown as { delegateAgentId?: unknown; skillIds?: unknown; collab?: unknown; attachments?: unknown }
      const resourceId = (value: unknown): value is string =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
      if (inputCommand.delegateAgentId !== undefined && !resourceId(inputCommand.delegateAgentId)) throw new Error('CHAT_COMMAND_INVALID')
      if (inputCommand.skillIds !== undefined) {
        const skillIds = inputCommand.skillIds
        if (!Array.isArray(skillIds) || skillIds.length === 0 || skillIds.length > MAX_MESSAGE_SKILLS ||
            new Set(skillIds).size !== skillIds.length || !skillIds.every(resourceId)) throw new Error('CHAT_COMMAND_INVALID')
      }
      if (inputCommand.collab !== undefined && typeof inputCommand.collab !== 'boolean') throw new Error('CHAT_COMMAND_INVALID')
      // Issue 93: the per-attachment destinations are explicit user picks.
      // At most MAX_MESSAGE_ATTACHMENTS entries with unique bounded ids; a
      // bounded device-local path and display name; and only the two
      // destinations that ride a send — 仅本机查看 is its own command. No
      // content ever rides the command, so every field stays a bounded
      // string.
      if (inputCommand.attachments !== undefined) {
        const attachments = inputCommand.attachments as unknown
        if (!Array.isArray(attachments) || attachments.length === 0 ||
            attachments.length > MAX_MESSAGE_ATTACHMENTS) throw new Error('CHAT_COMMAND_INVALID')
        const seen = new Set<string>()
        for (const row of attachments) {
          const item = row as { id?: unknown; path?: unknown; name?: unknown; destination?: unknown }
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('CHAT_COMMAND_INVALID')
          if (Object.keys(item).length !== 4 || !boundedAttachmentFact(item.id, 128) || seen.has(item.id) ||
              !boundedAttachmentFact(item.path, MAX_ATTACHMENT_PATH) ||
              !boundedAttachmentFact(item.name, MAX_ATTACHMENT_NAME) ||
              item.destination !== 'parsed-text' && item.destination !== 'upload') throw new Error('CHAT_COMMAND_INVALID')
          seen.add(item.id)
        }
      }
    }
    // Issue 78: the branch target is one bounded platform message id plus,
    // optionally, the rest of that turn's assistant ids — unique, bounded in
    // count. No title or content rides the command; the Server's own default
    // naming applies to the branch.
    if (command.action === 'branch') {
      const branchCommand = command as unknown as { messageId?: unknown; messageIds?: unknown }
      const messageId = (value: unknown): value is string =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
      if (!messageId(branchCommand.messageId)) throw new Error('CHAT_COMMAND_INVALID')
      if (branchCommand.messageIds !== undefined) {
        const messageIds = branchCommand.messageIds
        if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > MAX_BRANCH_TURN_MESSAGES ||
            new Set(messageIds).size !== messageIds.length || !messageIds.every(messageId)) throw new Error('CHAT_COMMAND_INVALID')
      }
    }
    // Issue 93: 仅本机查看 is an exact six-key command; the attachment facts
    // keep the same bounded identity the send list carries. The path rides
    // the generic loop's own path exception below (non-empty, within
    // MAX_ATTACHMENT_PATH).
    if (command.action === 'attachment-view') {
      const viewCommand = command as unknown as { id?: unknown; path?: unknown; name?: unknown }
      if (Object.keys(command).length !== 6 || !boundedAttachmentFact(viewCommand.id, 128) ||
          !boundedAttachmentFact(viewCommand.name, MAX_ATTACHMENT_NAME)) throw new Error('CHAT_COMMAND_INVALID')
    }
    // The only upload decision the renderer may send is an explicit allow;
    // everything else stays a malformed command.
    if (command.action === 'upload' && (Object.keys(command).length !== 6 || command.decision !== 'allow')) throw new Error('CHAT_COMMAND_INVALID')
    if (command.action === 'download' && (Object.keys(command).length !== 4 || !command.scope ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(command.threadId) || !/^[A-Za-z0-9_-]{1,128}$/.test(command.artifactId))) throw new Error('CHAT_COMMAND_INVALID')
    if (!allowed || Object.entries(command).some(([key, value]) => {
      // The two documented boolean flags are part of their command's fixed
      // shape even though they are not string-valued (#39 rememberScript,
      // #74 confirm); the #75 mounted-skill list is validated as a whole
      // above, and the #76 collab switch is a plain boolean. Everything else
      // must be a bounded string on the command's own key list.
      if ((key === 'confirm' || key === 'rememberScript') && value === true) return false
      if (key === 'skillIds' && Array.isArray(value) && allowed.includes('skillIds')) return false
      if (key === 'messageIds' && Array.isArray(value) && allowed.includes('messageIds')) return false
      if (key === 'collab' && typeof value === 'boolean' && allowed.includes('collab')) return false
      // The #93 attachment list and view command validate their longer
      // device-local path facts as a whole above.
      if (key === 'attachments' && Array.isArray(value) && allowed.includes('attachments')) return false
      if (key === 'path' && allowed.includes('path') && typeof value === 'string') return value.length > MAX_ATTACHMENT_PATH || value.length === 0
      return !allowed.includes(key) || typeof value !== 'string' || value.length > (key === 'text' ? 16000 : key === 'modelName' ? 200 : 256)
    })) {
      throw new Error('CHAT_COMMAND_INVALID')
    }
    if (!this.child || this.stopping || this.snapshot.process !== 'running') throw new Error('RUNTIME_UNAVAILABLE')
    if (this.chatRequests.size >= 8) throw new Error('CHAT_BUSY')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.chatRequests.delete(id)
        reject(new Error('CHAT_REQUEST_TIMEOUT'))
      }, 30000)
      this.chatRequests.set(id, {
        resolve: (state) => { clearTimeout(timer); this.chatRequests.delete(id); resolve(state) },
        reject: (error) => { clearTimeout(timer); this.chatRequests.delete(id); reject(error) }
      })
      this.child!.stdin.write(JSON.stringify({ type: 'chat', id, command }) + '\n')
    })
  }

  async beginLogin(server: string, deviceName: string): Promise<string> {
    let origin: URL
    try {
      if (typeof server !== 'string' || server.length > 2048) throw new Error()
      origin = new URL(server)
      if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
          !['https:', 'http:'].includes(origin.protocol) ||
          (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error()
    } catch { throw new Error('LOGIN_ORIGIN_INVALID') }
    if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 255) throw new Error('LOGIN_DEVICE_NAME_INVALID')
    if (this.loginRequest || this.snapshot.login?.state === 'awaiting-confirmation') throw new Error('LOGIN_IN_PROGRESS')
    await this.start()
    if (this.loginRequest || this.status().login?.state === 'awaiting-confirmation') throw new Error('LOGIN_IN_PROGRESS')
    if (!this.child || this.stopping) throw new Error('RUNTIME_UNAVAILABLE')
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginRequest = null
        reject(new Error('LOGIN_START_TIMEOUT'))
      }, 15000)
      this.loginRequest = { origin: origin.origin,
        resolve: (url) => { clearTimeout(timer); this.loginRequest = null; resolve(url) },
        reject: (error) => { clearTimeout(timer); this.loginRequest = null; reject(error) } }
      this.child!.stdin.write(JSON.stringify({ type: 'login', serverUrl: origin.origin, deviceName: deviceName.trim() }) + '\n')
    })
  }

  async start(): Promise<void> {
    if (this.child || this.stopping) return
    const executable = join(this.directory, 'python.exe')
    if (!existsSync(executable)) {
      this.snapshot = { process: 'missing', connection: 'offline', tasks: [] }
      return
    }
    mkdirSync(this.profile, { recursive: true })
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    // Both ends of the owned JSON pipe use UTF-8 regardless of the Windows code page.
    // Issue 105: `process.execPath` hands the runtime the app's own binary as the
    // pinned Node interpreter for inline code — under ELECTRON_RUN_AS_NODE the
    // packaged Electron exe behaves as plain Node, and the dev server's Node does
    // the same job. The runtime uses it only for user-approved inline tasks; a
    // renderer can never change it (it never supplies paths or commands).
    const child = spawn(executable, ['-I', '-u', '-X', 'utf8', '-m', 'core.desktop', '--config', join(this.profile, 'settings.json'), '--desktop-version', this.desktopVersion,
      '--node-executable', process.execPath,
      ...(this.maintenance ? ['--update-health'] : [])], {
      cwd: this.directory, env, windowsHide: true, stdio: 'pipe', shell: false
    })
    this.child = child
    this.snapshot = { process: 'starting', connection: 'offline', tasks: [], pid: child.pid }
    let buffer = ''
    let lastStatus = Date.now()
    const watch = setInterval(() => {
      if (Date.now() - lastStatus > 5000) {
        this.snapshot = { process: 'unresponsive', connection: 'offline', tasks: [], pid: child.pid }
      }
    }, 1000)
    watch.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) { child.kill(); return }
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        try {
          const value = JSON.parse(line)
          if (value.v === 1 && value.type === 'health') {
            const pending = this.healthRequest
            if (pending && value.id === pending.id && value.echo === 'ideer-update-health-v1' &&
                /^\d+\.\d+\.\d+$/.test(value.python) && value.pid === child.pid) pending.resolve(value)
            continue
          }
          if (value.v === 1 && (value.type === 'manage' || value.type === 'install-drain')) {
            const pending = this.managementRequest
            if (pending && value.id === pending.id) {
              if (value.error) pending.reject(new Error(value.type === 'install-drain' ? 'DRAIN_FAILED' : 'MANAGEMENT_FAILED'))
              else pending.resolve()
            }
            continue
          }
          if (value.v === 1 && value.type === 'receipts') {
            if (value.error) this.receiptRequests.get(value.id)?.reject(new Error(value.error === 'RECEIPT_BINDING_CHANGED' ? value.error : 'RECEIPT_STORAGE_UNAVAILABLE'))
            else if (value.result && Array.isArray(value.result.rows) && value.result.rows.length <= 20 &&
                ['total', 'pending', 'confirmed', 'uncertain', 'cleaned'].every((key) => Number.isSafeInteger(value.result[key]) && value.result[key] >= 0) &&
                typeof value.result.storageError === 'string') this.receiptRequests.get(value.id)?.resolve(value.result)
            else throw new Error('Invalid receipt response')
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-import') {
            const pending = this.knowledgeRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            if (!outcome || typeof outcome.kbId !== 'string' || typeof outcome.revisionId !== 'string' ||
                !Number.isSafeInteger(outcome.revisionNo) || typeof outcome.manifestHash !== 'string' ||
                !/^[0-9a-f]{64}$/.test(outcome.manifestHash) || !Number.isSafeInteger(outcome.documentCount)) {
              this.knowledgeRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_IMPORT_FAILED'))
              continue
            }
            pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
              manifestHash: outcome.manifestHash, documentCount: outcome.documentCount })
            continue
          }
          // Issue 96: the doc library's folder job and record management. A
          // refused start returns the fixed category; the job's own progress
          // and outcome ride the status snapshot.
          if (value.v === 1 && value.type === 'knowledge-folder-import') {
            const pending = this.knowledgeFolderRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeFolderRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const job = this.parseKnowledgeFolderJob(value.result)
            if (!job) { this.knowledgeFolderRequests.delete(value.id); pending.reject(new Error('KNOWLEDGE_IMPORT_FAILED')); continue }
            pending.resolve(job)
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-folder-import-cancel') {
            const pending = this.knowledgeFolderCancelRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeFolderCancelRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            pending.resolve({ canceled: value.result?.canceled === true })
            continue
          }
          // Issue 97: the index rebuild's start/cancel replies; the job's own
          // progress and outcome ride the status snapshot.
          if (value.v === 1 && value.type === 'knowledge-index-rebuild') {
            const pending = this.knowledgeIndexRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeIndexRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const job = this.parseKnowledgeIndexJob(value.result)
            if (!job) { this.knowledgeIndexRequests.delete(value.id); pending.reject(new Error('KNOWLEDGE_INDEX_FAILED')); continue }
            pending.resolve(job)
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-index-rebuild-cancel') {
            const pending = this.knowledgeIndexCancelRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeIndexCancelRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            pending.resolve({ canceled: value.result?.canceled === true })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-imports-delete') {
            const pending = this.knowledgeDeleteRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeDeleteRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            if (!value.result || !Number.isSafeInteger(value.result.deleted) || value.result.deleted < 0) {
              this.knowledgeDeleteRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_IMPORT_FAILED'))
              continue
            }
            pending.resolve({ deleted: value.result.deleted })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-import-retry') {
            const pending = this.knowledgeRetryRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeRetryRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            if (!outcome || typeof outcome.kbId !== 'string' || typeof outcome.revisionId !== 'string' ||
                !Number.isSafeInteger(outcome.revisionNo) || typeof outcome.manifestHash !== 'string' ||
                !/^[0-9a-f]{64}$/.test(outcome.manifestHash) || !Number.isSafeInteger(outcome.documentCount)) {
              this.knowledgeRetryRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_IMPORT_FAILED'))
              continue
            }
            pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
              manifestHash: outcome.manifestHash, documentCount: outcome.documentCount })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-revision-delete-documents') {
            const pending = this.knowledgeRevisionDeleteRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeRevisionDeleteRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            // Issue 101: the successor revision must be a complete frozen
            // identity, or the delete never happened and nothing may
            // impersonate it.
            const revision = outcome?.revision
            if (!outcome || typeof outcome.kbId !== 'string' ||
                !Number.isSafeInteger(outcome.removedDocuments) || outcome.removedDocuments < 0 ||
                !revision || typeof revision.kbId !== 'string' || typeof revision.revisionId !== 'string' ||
                !Number.isSafeInteger(revision.revisionNo) || typeof revision.manifestHash !== 'string' ||
                !/^[0-9a-f]{64}$/.test(revision.manifestHash) || !Number.isSafeInteger(revision.documentCount) ||
                typeof outcome.supersededRecordId !== 'string' ||
                !/^[0-9a-f]{64}$/.test(outcome.supersededRecordId)) {
              this.knowledgeRevisionDeleteRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_IMPORT_FAILED'))
              continue
            }
            pending.resolve({ kbId: outcome.kbId, removedDocuments: outcome.removedDocuments,
              revision: { kbId: revision.kbId, revisionId: revision.revisionId, revisionNo: revision.revisionNo,
                manifestHash: revision.manifestHash, documentCount: revision.documentCount },
              supersededRecordId: outcome.supersededRecordId })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-revision-cleanup') {
            const pending = this.knowledgeCleanupRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeCleanupRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            if (!outcome || typeof outcome.kbId !== 'string' || typeof outcome.revisionId !== 'string' ||
                (outcome.indexPurged !== true && outcome.indexPurged !== false) ||
                !Number.isSafeInteger(outcome.snapshotsPurged) || outcome.snapshotsPurged < 0) {
              this.knowledgeCleanupRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_IMPORT_FAILED'))
              continue
            }
            pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId,
              indexPurged: outcome.indexPurged === true, snapshotsPurged: outcome.snapshotsPurged })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-publish') {
            const pending = this.knowledgePublishRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgePublishRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            if (!outcome || typeof outcome.kbId !== 'string' || typeof outcome.revisionId !== 'string' ||
                typeof outcome.confirmed !== 'boolean') {
              this.knowledgePublishRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_PUBLISH_FAILED'))
              continue
            }
            if (outcome.confirmed === false) {
              // Preview: identity facts plus the platform's stated destination.
              if (!outcome.destination || typeof outcome.destination.displayName !== 'string' ||
                  typeof outcome.destination.slug !== 'string' || outcome.destination.visibility !== 'private' ||
                  !Array.isArray(outcome.documents)) {
                this.knowledgePublishRequests.delete(value.id)
                pending.reject(new Error('KNOWLEDGE_PUBLISH_FAILED'))
                continue
              }
              pending.resolve({ confirmed: false, kbId: outcome.kbId, revisionId: outcome.revisionId,
                destination: { kind: String(outcome.destination.kind ?? 'server_copy'),
                  displayName: outcome.destination.displayName, slug: outcome.destination.slug,
                  visibility: outcome.destination.visibility,
                  governance: String(outcome.destination.governance ?? 'visibility_application_required') },
                documents: outcome.documents.slice(0, 200).map((document: { filename?: unknown; sha256?: unknown; bytes?: unknown; mime?: unknown }) => ({
                  filename: typeof document?.filename === 'string' ? document.filename : '',
                  sha256: typeof document?.sha256 === 'string' ? document.sha256 : '',
                  bytes: Number.isSafeInteger(document?.bytes) ? document.bytes : 0,
                  mime: typeof document?.mime === 'string' ? document.mime : '' })) })
              continue
            }
            // Confirmed outcome: the derived platform status, never a fabricated one.
            if (typeof outcome.copyResourceId !== 'string' || !outcome.copyResourceId ||
                typeof outcome.copySlug !== 'string' || typeof outcome.status !== 'string' ||
                !Number.isSafeInteger(outcome.documentCount) || typeof outcome.failureCode !== 'string') {
              this.knowledgePublishRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_PUBLISH_FAILED'))
              continue
            }
            pending.resolve({ confirmed: true, kbId: outcome.kbId, revisionId: outcome.revisionId,
              copyResourceId: outcome.copyResourceId, copySlug: outcome.copySlug,
              copyRevisionId: typeof outcome.copyRevisionId === 'string' ? outcome.copyRevisionId : '',
              status: outcome.status, failureCode: outcome.failureCode, documentCount: outcome.documentCount })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-graph') {
            const pending = this.knowledgeGraphRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeGraphRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            if (!outcome || typeof outcome.kbId !== 'string' || typeof outcome.revisionId !== 'string') {
              this.knowledgeGraphRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_GRAPH_FAILED'))
              continue
            }
            const text = (input: unknown, limit: number): string => typeof input === 'string' && input.length > 0 && input.length <= limit ? input : ''
            if (pending.action === 'search' || pending.action === 'ask') {
              // Issue 117: only the Server's own scoped facts are projected;
              // a refusal stays a refusal (no answer text is invented).
              if (typeof outcome.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.manifestHash) ||
                  !Number.isSafeInteger(outcome.revisionNo) ||
                  !['not_generated', 'completed', 'partial', 'failed'].includes(outcome.status) ||
                  !Array.isArray(outcome.scope)) {
                this.knowledgeGraphRequests.delete(value.id)
                pending.reject(new Error('KNOWLEDGE_GRAPH_FAILED'))
                continue
              }
              const scope: KnowledgeGraphScopeRow[] = outcome.scope.slice(0, 200).map((row: Record<string, unknown>) => ({
                documentId: text(row?.documentId, 64), filename: text(row?.filename, 255),
                contentHash: text(row?.contentHash, 64), status: text(row?.status, 32), errorCode: text(row?.errorCode, 64)
              })).filter((row: KnowledgeGraphScopeRow) => row.documentId !== '')
              this.knowledgeGraphRequests.delete(value.id)
              if (pending.action === 'ask') {
                const answerAvailable = outcome.answerAvailable === true
                const answer = answerAvailable ? text(outcome.answer, 8000) : ''
                if (answerAvailable && !answer) {
                  pending.reject(new Error('KNOWLEDGE_GRAPH_FAILED'))
                  continue
                }
                pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
                  manifestHash: outcome.manifestHash, status: outcome.status,
                  question: text(outcome.question, 4000), answerAvailable, answer,
                  errorCode: text(outcome.errorCode, 64), scope })
                continue
              }
              pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
                manifestHash: outcome.manifestHash, status: outcome.status, query: text(outcome.query, 512), scope,
                entities: Array.isArray(outcome.entities) ? outcome.entities.slice(0, 200).map((row: Record<string, unknown>) => ({
                  name: text(row?.name, 200), type: text(row?.type, 64),
                  documentId: text(row?.documentId, 64), filename: text(row?.filename, 255),
                  contentHash: text(row?.contentHash, 64) })).filter((row: { name: string }) => row.name !== '') : [],
                relations: Array.isArray(outcome.relations) ? outcome.relations.slice(0, 200).map((row: Record<string, unknown>) => ({
                  source: text(row?.source, 200), target: text(row?.target, 200), relation: text(row?.relation, 200),
                  documentId: text(row?.documentId, 64), filename: text(row?.filename, 255),
                  contentHash: text(row?.contentHash, 64) }))
                  .filter((row: { source: string; target: string; relation: string }) => row.source !== '' && row.target !== '' && row.relation !== '') : []
              })
              continue
            }
            if (pending.action === 'locate') {
              // Locate answer: the workspace path stays a local display fact;
              // a locate answer always names its source document.
              if (typeof outcome.documentId !== 'string' || !outcome.documentId) {
                this.knowledgeGraphRequests.delete(value.id)
                pending.reject(new Error('KNOWLEDGE_GRAPH_FAILED'))
                continue
              }
              pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, documentId: outcome.documentId,
                filename: typeof outcome.filename === 'string' ? outcome.filename : undefined,
                logicalPath: typeof outcome.logicalPath === 'string' ? outcome.logicalPath : undefined,
                missing: outcome.missing === true ? true : undefined,
                reason: typeof outcome.reason === 'string' ? outcome.reason : undefined })
              continue
            }
            // Graph view: only the Server's own entity/relation/source facts.
            if (typeof outcome.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.manifestHash) ||
                !Number.isSafeInteger(outcome.revisionNo) ||
                !['not_generated', 'completed', 'partial', 'failed'].includes(outcome.status) ||
                !Number.isSafeInteger(outcome.generated) || !Number.isSafeInteger(outcome.failed) ||
                !Array.isArray(outcome.entities) || !Array.isArray(outcome.relations) || !Array.isArray(outcome.sources)) {
              this.knowledgeGraphRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_GRAPH_FAILED'))
              continue
            }
            pending.resolve({
              kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
              manifestHash: outcome.manifestHash, status: outcome.status,
              generated: outcome.generated, failed: outcome.failed,
              // Issue 101: the 离线快照 annotation rides only when the Runtime
              // served the cached copy; a live view never claims it.
              offline: outcome.offline === true ? true : undefined,
              capturedAt: typeof outcome.capturedAt === 'string' ? outcome.capturedAt : undefined,
              entities: outcome.entities.slice(0, 200).map((row: Record<string, unknown>) => ({
                name: text(row?.name, 200), type: text(row?.type, 64),
                documentId: text(row?.documentId, 64), filename: text(row?.filename, 255) })),
              relations: outcome.relations.slice(0, 200).map((row: Record<string, unknown>) => ({
                source: text(row?.source, 200), target: text(row?.target, 200), relation: text(row?.relation, 200),
                documentId: text(row?.documentId, 64), filename: text(row?.filename, 255) })),
              sources: outcome.sources.slice(0, 200).map((row: Record<string, unknown>) => ({
                documentId: text(row?.documentId, 64), filename: text(row?.filename, 255),
                contentHash: text(row?.contentHash, 64), status: text(row?.status, 32), errorCode: text(row?.errorCode, 64) }))
            })
            continue
          }
          if (value.v === 1 && value.type === 'knowledge-wiki') {
            const pending = this.knowledgeWikiRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.knowledgeWikiRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            const outcome = value.result
            const text = (input: unknown, limit: number): string => typeof input === 'string' && input.length > 0 && input.length <= limit ? input : ''
            if (!outcome || typeof outcome.kbId !== 'string' || typeof outcome.revisionId !== 'string' ||
                typeof outcome.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.manifestHash) ||
                !Number.isSafeInteger(outcome.revisionNo) ||
                !['not_generated', 'completed', 'partial', 'failed'].includes(outcome.status)) {
              this.knowledgeWikiRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_WIKI_FAILED'))
              continue
            }
            const pageStatus = (input: unknown): input is WikiPageSummary['status'] =>
              ['completed', 'skipped', 'failed', 'not_generated'].includes(input as string)
            if (pending.action === 'read') {
              // Issue 118: one page read. A body only ever travels with a
              // completed page; a skip or failure projects as exactly that.
              if (typeof outcome.documentId !== 'string' || !outcome.documentId || !pageStatus(outcome.status)) {
                this.knowledgeWikiRequests.delete(value.id)
                pending.reject(new Error('KNOWLEDGE_WIKI_FAILED'))
                continue
              }
              const completed = outcome.status === 'completed'
              const body = completed ? text(outcome.body, 20000) : ''
              if (completed && !body) {
                this.knowledgeWikiRequests.delete(value.id)
                pending.reject(new Error('KNOWLEDGE_WIKI_FAILED'))
                continue
              }
              this.knowledgeWikiRequests.delete(value.id)
              pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
                manifestHash: outcome.manifestHash, documentId: outcome.documentId,
                filename: text(outcome.filename, 255), title: text(outcome.title, 200),
                contentHash: text(outcome.contentHash, 64), status: outcome.status,
                errorCode: text(outcome.errorCode, 64), body,
                // Issue 101: the cached page read keeps its 离线快照 annotation.
                offline: outcome.offline === true ? true : undefined,
                capturedAt: typeof outcome.capturedAt === 'string' ? outcome.capturedAt : undefined })
              continue
            }
            // Wiki page list: only the Server's own page/progress/source facts.
            if (!Number.isSafeInteger(outcome.generated) || !Number.isSafeInteger(outcome.failed) ||
                !Number.isSafeInteger(outcome.skipped) || !Array.isArray(outcome.pages)) {
              this.knowledgeWikiRequests.delete(value.id)
              pending.reject(new Error('KNOWLEDGE_WIKI_FAILED'))
              continue
            }
            this.knowledgeWikiRequests.delete(value.id)
            pending.resolve({ kbId: outcome.kbId, revisionId: outcome.revisionId, revisionNo: outcome.revisionNo,
              manifestHash: outcome.manifestHash, status: outcome.status,
              generated: outcome.generated, failed: outcome.failed, skipped: outcome.skipped,
              offline: outcome.offline === true ? true : undefined,
              capturedAt: typeof outcome.capturedAt === 'string' ? outcome.capturedAt : undefined,
              pages: outcome.pages.slice(0, 200).map((row: Record<string, unknown>) => ({
                documentId: text(row?.documentId, 64), filename: text(row?.filename, 255),
                title: text(row?.title, 200), contentHash: text(row?.contentHash, 64),
                status: pageStatus(row?.status) ? row.status : 'not_generated',
                errorCode: text(row?.errorCode, 64) }))
                .filter((row: WikiPageSummary) => row.documentId !== '')
            })
            continue
          }
          if (value.v === 1 && value.type === 'skills') {
            // Issue 120: the preview (device-side, uploads nothing), the
            // confirmed import (private draft), and the publication (version
            // copy) each resolve only their own exact shape.
            const text = (input: unknown, limit: number): string => typeof input === 'string' ? input.slice(0, limit) : ''
            if (value.error) {
              this.skillImportRequests.get(value.id)?.reject(new Error(value.error))
              this.skillImportRequests.delete(value.id)
              this.skillPublishRequests.get(value.id)?.reject(new Error(value.error))
              this.skillPublishRequests.delete(value.id)
              continue
            }
            const importer = this.skillImportRequests.get(value.id)
            if (importer) {
              const outcome = value.result
              const languages: SkillPackageFileView['language'][] = ['python', 'js', 'shell', 'executable', '']
              const files = (rows: unknown): SkillImportPreview['files'] => Array.isArray(rows) ? rows.slice(0, 200).map((row: Record<string, unknown>) => ({
                path: text(row?.path, 255),
                role: ['body', 'script', 'reference', 'attachment'].includes(row?.role as string) ? row.role as SkillImportPreview['files'][number]['role'] : 'attachment',
                bytes: Number.isSafeInteger(row?.bytes) && (row.bytes as number) >= 0 ? row.bytes as number : 0,
                sha256: text(row?.sha256, 64),
                language: languages.includes(row?.language as SkillPackageFileView['language']) ? row.language as SkillPackageFileView['language'] : ''
              })).filter((row: SkillPackageFileView) => row.path !== '' && /^[0-9a-f]{64}$/.test(row.sha256)) : []
              // Issue 82: the projected declaration must match the runtime's
              // normalized shapes exactly — an unknown permission, an extra
              // environment key, or a wrong entry type refuses the preview
              // instead of displaying a partial declaration.
              const entries = (rows: unknown): string[] | null => Array.isArray(rows) && rows.length <= 16 &&
                rows.every((row) => typeof row === 'string' && row.length >= 1 && row.length <= 128) ? rows : null
              const environment = (raw: unknown): SkillImportEnvironmentView | null => {
                if (raw === null) return null
                if (!raw || typeof raw !== 'object') return null
                const record = raw as Record<string, unknown>
                if (record.target !== 'server' && record.target !== 'user_device') return null
                const os = entries(record.os)
                const dependencies = entries(record.dependencies)
                const software = entries(record.software)
                const tools = entries(record.tools)
                const data = entries(record.data)
                return os && dependencies && software && tools && data
                  ? { target: record.target, os, dependencies, software, tools, data } : null
              }
              const permissions = (raw: unknown): SkillImportPermissionsView | null => {
                if (!raw || typeof raw !== 'object') return null
                const record = raw as Record<string, unknown>
                const keys = Object.keys(record)
                return keys.length === 2 && keys.includes('network') && keys.includes('subprocess') &&
                  typeof record.network === 'boolean' && typeof record.subprocess === 'boolean'
                  ? { network: record.network, subprocess: record.subprocess } : null
              }
              if (!outcome || typeof outcome.confirmed !== 'boolean' || typeof outcome.packageHash !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(outcome.packageHash) || typeof outcome.name !== 'string' ||
                  !Number.isSafeInteger(outcome.fileCount) || !Number.isSafeInteger(outcome.totalBytes)) {
                this.skillImportRequests.delete(value.id)
                importer.reject(new Error('SKILL_IMPORT_FAILED'))
                continue
              }
              if (outcome.confirmed === false) {
                const projectedEnvironment = environment(outcome.environment)
                const projectedPermissions = permissions(outcome.permissions)
                if (importer.phase !== 'preview' || !outcome.destination || outcome.destination.visibility !== 'private' ||
                    projectedEnvironment === null || projectedPermissions === null) {
                  this.skillImportRequests.delete(value.id)
                  importer.reject(new Error('SKILL_IMPORT_FAILED'))
                  continue
                }
                importer.resolve({ confirmed: false, origin: outcome.origin === 'markdown' || outcome.origin === 'zip' || outcome.origin === 'directory' ? outcome.origin : 'zip',
                  name: outcome.name, description: text(outcome.description, 1024), bodyExcerpt: text(outcome.body, 2000),
                  environment: projectedEnvironment, permissions: projectedPermissions, files: files(outcome.files),
                  fileCount: outcome.fileCount, totalBytes: outcome.totalBytes, packageHash: outcome.packageHash,
                  destination: { resourceType: 'skill', visibility: 'private' } })
                continue
              }
              const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
              if (importer.phase !== 'confirm' || typeof outcome.resourceId !== 'string' || !uuid.test(outcome.resourceId) ||
                  typeof outcome.slug !== 'string' || !outcome.slug || !Number.isSafeInteger(outcome.revision) ||
                  outcome.revision < 1 || typeof outcome.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.contentHash)) {
                this.skillImportRequests.delete(value.id)
                importer.reject(new Error('SKILL_IMPORT_FAILED'))
                continue
              }
              importer.resolve({ confirmed: true, resourceId: outcome.resourceId, slug: outcome.slug,
                revision: outcome.revision, contentHash: outcome.contentHash,
                fileCount: outcome.fileCount, totalBytes: outcome.totalBytes })
              continue
            }
            const publisher = this.skillPublishRequests.get(value.id)
            if (publisher) {
              const outcome = value.result
              const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
              if (!outcome || typeof outcome.resourceId !== 'string' || !uuid.test(outcome.resourceId) ||
                  !Number.isSafeInteger(outcome.version) || outcome.version < 1 ||
                  typeof outcome.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.contentHash)) {
                this.skillPublishRequests.delete(value.id)
                publisher.reject(new Error('SKILL_PUBLISH_FAILED'))
                continue
              }
              publisher.resolve({ resourceId: outcome.resourceId, version: outcome.version, contentHash: outcome.contentHash })
              continue
            }
            continue
          }
          if (value.v === 1 && value.type === 'skill-preferences') {
            // Issue 121: the Server's own preference projection, validated and
            // bounded before it reaches the renderer. No content, no matching.
            const pending = this.skillPreferenceRequests.get(value.id)
            if (!pending) continue
            this.skillPreferenceRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            const text = (input: unknown, limit: number): string => typeof input === 'string' ? input.slice(0, limit) : ''
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
            if (!result || !Array.isArray(result.skills)) { pending.reject(new Error('SKILL_PREFERENCE_FAILED')); continue }
            const skills = result.skills.slice(0, 200).map((row: Record<string, unknown>) => ({
              skillId: text(row?.skillId, 64),
              slug: text(row?.slug, 255),
              displayName: text(row?.displayName, 255),
              latestVersion: Number.isSafeInteger(row?.latestVersion) && (row.latestVersion as number) >= 0 ? row.latestVersion as number : 0,
              available: row?.available === true,
              enabled: row?.enabled === true,
              keywords: Array.isArray(row?.keywords) ? row.keywords.slice(0, 16).filter((keyword): keyword is string => typeof keyword === 'string') : [],
              alwaysInject: row?.alwaysInject === true,
              applicableAgentIds: Array.isArray(row?.applicableAgentIds)
                ? row.applicableAgentIds.slice(0, 32).filter((agentId): agentId is string => typeof agentId === 'string' && uuid.test(agentId))
                : [],
              priority: Number.isSafeInteger(row?.priority) ? row.priority as number : 0
            })).filter((row: SkillTriggerPreferenceView) => uuid.test(row.skillId))
            pending.resolve({ skills })
            continue
          }
          if (value.v === 1 && value.type === 'skill-scripts') {
            // Issue 122: the device's own binding-scoped grant list, bounded
            // before it reaches the renderer; hashes only, never script bytes.
            // Issue 41: a revoke response also carries `revoked` (false when
            // the identity was already gone) so success is not misread as a
            // failure just because it is not a bare list.
            const pending = this.skillScriptRequests.get(value.id)
            if (!pending) continue
            this.skillScriptRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            if (!result || !Array.isArray(result.authorizations)) { pending.reject(new Error('SKILL_SCRIPT_FAILED')); continue }
            if (pending.action === 'revoke' && typeof result.revoked !== 'boolean') { pending.reject(new Error('SKILL_SCRIPT_FAILED')); continue }
            const authorizations: SkillScriptAuthorizationView[] = []
            for (const row of result.authorizations.slice(0, 20)) {
              if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) ||
                  typeof row.resourceId !== 'string' || typeof row.scriptPath !== 'string' ||
                  !row.scriptPath.startsWith('scripts/') || typeof row.scriptSha256 !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(row.scriptSha256) || typeof row.requirementsHash !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(row.requirementsHash) || row.status !== 'granted' ||
                  typeof row.createdAt !== 'string') throw new Error('Invalid skill script authorization')
              authorizations.push({ id: row.id, resourceId: row.resourceId, slug: typeof row.slug === 'string' ? row.slug.slice(0, 128) : '',
                version: Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : 0,
                contentHash: typeof row.contentHash === 'string' && /^[0-9a-f]{64}$/.test(row.contentHash) ? row.contentHash : '',
                scriptPath: row.scriptPath.slice(0, 512), scriptSha256: row.scriptSha256,
                requirementsHash: row.requirementsHash, status: 'granted', createdAt: row.createdAt })
            }
            pending.resolve(pending.action === 'revoke' ? { authorizations, revoked: result.revoked } : { authorizations })
            continue
          }
          if (value.v === 1 && value.type === 'threads') {
            // Issue 72: the Server's own post-action thread list plus the
            // account's Thread permissions, bounded before it reaches the
            // renderer. Titles and statuses are display facts only; nothing
            // here can create, own or authorize a thread.
            const pending = this.threadRequests.get(value.id)
            if (!pending) continue
            this.threadRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            if (!result || !Array.isArray(result.threads) || !result.permissions ||
                typeof result.permissions.canRename !== 'boolean' || typeof result.permissions.canDelete !== 'boolean') {
              pending.reject(new Error('THREADS_FAILED')); continue
            }
            if (pending.action === 'rename' && result.renamed !== true) { pending.reject(new Error('THREADS_FAILED')); continue }
            if (pending.action === 'delete' && result.deleted !== true) { pending.reject(new Error('THREADS_FAILED')); continue }
            if (pending.action === 'move' && result.moved !== true) { pending.reject(new Error('THREADS_FAILED')); continue }
            const idPattern = /^[A-Za-z0-9_-]{1,128}$/
            const threads: ThreadRowView[] = []
            for (const row of result.threads.slice(0, 200)) {
              if (!row || typeof row.id !== 'string' || !idPattern.test(row.id) ||
                  typeof row.title !== 'string' || !row.title || typeof row.status !== 'string' ||
                  typeof row.updatedAt !== 'string') throw new Error('Invalid thread row')
              // Issue 91: the Server's own membership stamp; empty = loose
              // session. An unknown shape is a protocol failure, never a
              // guessed grouping.
              if (typeof row.projectId !== 'string' || (row.projectId && !idPattern.test(row.projectId))) throw new Error('Invalid thread row')
              // Issue 113: the branch edge this device observed when the
              // branch succeeded — the Runtime's own scope-bound record of
              // the Server's parent facts. Absent means unknown and passes
              // through as such; a present edge must be well-formed or the
              // reply is a protocol failure, never a guessed relation.
              let branchedFrom: ThreadRowView['branchedFrom']
              if (row.branchedFrom != null) {
                const edge = row.branchedFrom as ThreadRowView['branchedFrom']
                if (!edge || typeof edge !== 'object' || typeof edge.threadId !== 'string' ||
                    !idPattern.test(edge.threadId) || typeof edge.messageId !== 'string' ||
                    !idPattern.test(edge.messageId)) throw new Error('Invalid thread row')
                branchedFrom = { threadId: edge.threadId, messageId: edge.messageId }
              }
              threads.push({ id: row.id, title: row.title.slice(0, 256), status: row.status.slice(0, 32),
                updatedAt: row.updatedAt.slice(0, 64), projectId: row.projectId,
                ...(branchedFrom ? { branchedFrom } : {}) })
            }
            const permissions: ThreadPermissionsView = { canRename: result.permissions.canRename, canDelete: result.permissions.canDelete }
            pending.resolve(pending.action === 'rename' ? { threads, permissions, renamed: true }
              : pending.action === 'delete' ? { threads, permissions, deleted: true }
              : pending.action === 'move' ? { threads, permissions, moved: true }
              : { threads, permissions })
            continue
          }
          if (value.v === 1 && value.type === 'projects') {
            // Issue 91: the Server's own post-action project list plus the
            // account's project permissions, bounded before it reaches the
            // renderer. Names and statuses are display facts only; nothing
            // here can create, own or authorize a project, and no local
            // state is ever bound to one.
            const pending = this.projectRequests.get(value.id)
            if (!pending) continue
            this.projectRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            if (!result || !Array.isArray(result.projects) || !result.permissions ||
                typeof result.permissions.canWrite !== 'boolean' || typeof result.permissions.canDelete !== 'boolean') {
              pending.reject(new Error('PROJECTS_FAILED')); continue
            }
            const outcomeFlags: Partial<Record<ProjectCommand['action'], unknown>> = {
              create: result.created, rename: result.renamed, archive: result.archived,
              restore: result.restored, delete: result.deleted, 'bind-folder': result.bound,
              'unbind-folder': result.unbound
            }
            if (pending.action !== 'list' && outcomeFlags[pending.action] !== true) { pending.reject(new Error('PROJECTS_FAILED')); continue }
            const idPattern = /^[A-Za-z0-9_-]{1,128}$/
            const projects: ProjectView[] = []
            for (const row of result.projects.slice(0, 200)) {
              if (!row || typeof row.id !== 'string' || !idPattern.test(row.id) ||
                  typeof row.name !== 'string' || !row.name ||
                  (row.status !== 'active' && row.status !== 'archived') ||
                  typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('Invalid project row')
              projects.push({ id: row.id, name: row.name.slice(0, 128), status: row.status,
                createdAt: row.createdAt.slice(0, 64), updatedAt: row.updatedAt.slice(0, 64) })
            }
            // Issue 92: the device's own binding rows ride every reply; a
            // malformed row is a protocol failure like a malformed project.
            const bindings: ProjectBindingView[] = []
            if (result.bindings !== undefined) {
              if (!Array.isArray(result.bindings)) throw new Error('Invalid project binding row')
              for (const row of result.bindings.slice(0, 200)) {
                if (!row || typeof row.projectId !== 'string' || !idPattern.test(row.projectId) ||
                    typeof row.path !== 'string' || !row.path || row.path.length > 1024 ||
                    typeof row.deviceName !== 'string' || row.deviceName.length > 128 ||
                    typeof row.createdAt !== 'string') throw new Error('Invalid project binding row')
                bindings.push({ projectId: row.projectId, path: row.path, deviceName: row.deviceName.slice(0, 128),
                  createdAt: row.createdAt.slice(0, 64) })
              }
            }
            const permissions: ProjectPermissionsView = { canWrite: result.permissions.canWrite, canDelete: result.permissions.canDelete }
            pending.resolve(outcomeFlags[pending.action] === true
              ? { projects, permissions, bindings, [pending.action]: true } as ProjectOperationView
              : { projects, permissions, bindings })
            continue
          }
          if (value.v === 1 && value.type === 'datasets') {
            // Issue 102: the registry's own post-action list plus the honest
            // outcome flag. A duplicate import is an answer, never a silent
            // second row, and a failed import names the fixed reason its row
            // records — the renderer can never misread either as success.
            const pending = this.datasetRequests.get(value.id)
            if (!pending) continue
            const result = value.result
            if (value.error || !result || !Array.isArray(result.datasets) ||
                (pending.action === 'import' &&
                  !(result.imported === true || result.duplicate === true || result.failed === true)) ||
                (pending.action === 'delete' && result.deleted !== true)) {
              this.datasetRequests.delete(value.id)
              pending.reject(new Error(value.error || 'DATASETS_FAILED'))
              continue
            }
            // Map before settling: a malformed row is a protocol failure that
            // kills the child while the pending entry stays registered, so
            // the close handler rejects the importer instead of hanging it
            // until the timeout (review finding, #102).
            const datasets = result.datasets.slice(0, 20).map(toDatasetView)
            this.datasetRequests.delete(value.id)
            pending.resolve({
              datasets,
              imported: result.imported === true ? true : undefined,
              duplicate: result.duplicate === true ? true : undefined,
              failed: result.failed === true ? true : undefined,
              deleted: result.deleted === true ? true : undefined,
              datasetId: typeof result.datasetId === 'string' ? result.datasetId : undefined,
              duplicateOf: typeof result.duplicateOf === 'string' ? result.duplicateOf : undefined,
              errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined
            })
            continue
          }
          if (value.v === 1 && value.type === 'schedules') {
            // Issue 85: the platform's own post-action rows plus the device's
            // 补跑 marks, bounded before they reach the renderer. A shape
            // violation kills the child rather than showing invented state,
            // exactly like the threads family.
            const pending = this.schedulesRequests.get(value.id)
            if (!pending) continue
            this.schedulesRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            const bad = (): void => { pending.reject(new Error('SCHEDULES_FAILED')) }
            if (!result || typeof result !== 'object') { bad(); continue }
            const text = (input: unknown, limit: number): string => typeof input === 'string' ? input.slice(0, limit) : ''
            const idPattern = /^[A-Za-z0-9_-]{1,128}$/
            const mark = (input: unknown): ScheduleMarkView | null => {
              if (!input || typeof input !== 'object') return null
              const row = input as Record<string, unknown>
              if (typeof row.plannedAt !== 'string' || !row.plannedAt || typeof row.status !== 'string' || !row.status) return null
              return { plannedAt: row.plannedAt.slice(0, 64), status: row.status.slice(0, 32),
                reason: text(row.reason, 256), error: text(row.error, 256), markedAt: text(row.markedAt, 64) }
            }
            const taskView = (input: unknown): ScheduleTaskView => {
              if (!input || typeof input !== 'object') throw new Error('Invalid schedules row')
              const row = input as Record<string, unknown>
              if (typeof row.id !== 'string' || !idPattern.test(row.id) || typeof row.title !== 'string' ||
                  typeof row.status !== 'string' || typeof row.scheduleType !== 'string') throw new Error('Invalid schedules row')
              const spec = row.scheduleSpec && typeof row.scheduleSpec === 'object' && !Array.isArray(row.scheduleSpec)
                ? row.scheduleSpec as Record<string, unknown> : {}
              const marks = Array.isArray(row.missedMarks)
                ? row.missedMarks.slice(0, 20).map(mark).filter((entry): entry is ScheduleMarkView => entry !== null) : []
              return {
                id: row.id, title: row.title.slice(0, 200), prompt: text(row.prompt, 16000),
                status: row.status.slice(0, 32), scheduleType: row.scheduleType.slice(0, 16),
                scheduleSpec: {
                  ...(typeof spec.cron === 'string' ? { cron: spec.cron.slice(0, 256) } : {}),
                  ...(Number.isSafeInteger(spec.everySeconds) ? { everySeconds: spec.everySeconds as number } : {}),
                  ...(typeof spec.runAt === 'string' ? { runAt: spec.runAt.slice(0, 64) } : {})
                },
                timezone: text(row.timezone, 128), assistantId: text(row.assistantId, 128),
                contextMode: text(row.contextMode, 32), threadId: text(row.threadId, 128),
                nextRunAt: text(row.nextRunAt, 64), createdAt: text(row.createdAt, 64),
                updatedAt: text(row.updatedAt, 64), skipOnMissed: row.skipOnMissed === true, missedMarks: marks
              }
            }
            const runView = (input: unknown): ScheduleRunView => {
              if (!input || typeof input !== 'object') throw new Error('Invalid schedules row')
              const row = input as Record<string, unknown>
              if (typeof row.id !== 'string' || !row.id || typeof row.status !== 'string') throw new Error('Invalid schedules row')
              return {
                id: row.id.slice(0, 128), status: row.status.slice(0, 32) || 'unknown',
                plannedFor: text(row.plannedFor, 64), trigger: text(row.trigger, 16),
                threadId: text(row.threadId, 128),
                createdAt: text(row.createdAt, 64), error: text(row.error, 512),
                catchUp: mark(row.catchUp)
              }
            }
            try {
              if (pending.action === 'list') {
                if (!Array.isArray(result.tasks)) { bad(); continue }
                pending.resolve({ action: 'list', tasks: result.tasks.slice(0, 200).map(taskView) })
                continue
              }
              if (pending.action === 'runs') {
                if (!Array.isArray(result.runs)) { bad(); continue }
                pending.resolve({ action: 'runs', runs: result.runs.slice(0, 200).map(runView) })
                continue
              }
              if (pending.action === 'trigger') {
                if (result.triggered !== true || typeof result.taskId !== 'string' || !idPattern.test(result.taskId)) { bad(); continue }
                pending.resolve({ action: 'trigger', taskId: result.taskId, triggered: true })
                continue
              }
              if (pending.action === 'delete') {
                if (result.deleted !== true || typeof result.taskId !== 'string' || !idPattern.test(result.taskId)) { bad(); continue }
                pending.resolve({ action: 'delete', taskId: result.taskId, deleted: true })
                continue
              }
              if (pending.action === 'set-skip') {
                if (typeof result.skipOnMissed !== 'boolean' || typeof result.taskId !== 'string' || !idPattern.test(result.taskId)) { bad(); continue }
                pending.resolve({ action: 'set-skip', taskId: result.taskId, skipOnMissed: result.skipOnMissed })
                continue
              }
              if (pending.action === 'preview') {
                if (!Array.isArray(result.occurrences) || typeof result.cron !== 'string' || typeof result.timezone !== 'string') { bad(); continue }
                const occurrences = result.occurrences.slice(0, 10).map((entry: Record<string, unknown>) => {
                  if (!entry || typeof entry.runAt !== 'string' || !entry.runAt || typeof entry.localTime !== 'string' || !entry.localTime) throw new Error('Invalid schedules row')
                  return { runAt: entry.runAt.slice(0, 64), localTime: entry.localTime.slice(0, 64) }
                })
                pending.resolve({ action: 'preview', cron: result.cron.slice(0, 256), timezone: result.timezone.slice(0, 128), occurrences })
                continue
              }
              // get / create / update / pause / resume share the task row shape.
              const view = taskView(result.task)
              pending.resolve({ action: pending.action, task: view } as SchedulesOutcome)
            } catch {
              bad()
            }
            continue
          }
          if (value.v === 1 && value.type === 'templates') {
            // Issue 84: the Server's own post-action template list, bounded
            // before it reaches the renderer. Rows carry prefill facts only;
            // the click's send never happens here — `use` is a count record.
            // Issue 106: the official-list read resolves with the official
            // selection only — no account list, no mutation flag.
            const pending = this.templateRequests.get(value.id)
            if (!pending) continue
            this.templateRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            if (pending.action === 'official-list') {
              if (!result || !Array.isArray(result.official)) { pending.reject(new Error('TEMPLATE_FAILED')); continue }
              // The same drop-never-repair discipline as the Python
              // projection: a row the Server did not state cleanly is
              // skipped, never thrown past this loop — a malformed row must
              // not take the Runtime down. No id grammar beyond the bounds:
              // the read-only facade never puts an official id on a URL.
              const official: OfficialTemplateRowView[] = []
              for (const row of result.official.slice(0, 200)) {
                if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 128 ||
                    typeof row.name !== 'string' || !row.name ||
                    typeof row.category !== 'string' ||
                    typeof row.content !== 'string' || !row.content ||
                    typeof row.updatedAt !== 'string') continue
                official.push({ id: row.id, name: row.name.slice(0, 200), category: row.category.slice(0, 64),
                  content: row.content.slice(0, 16000), updatedAt: row.updatedAt.slice(0, 64) })
              }
              pending.resolve({ official })
              continue
            }
            if (!result || !Array.isArray(result.templates)) { pending.reject(new Error('TEMPLATE_FAILED')); continue }
            if (pending.action === 'create' && result.created !== true) { pending.reject(new Error('TEMPLATE_FAILED')); continue }
            if (pending.action === 'update' && result.updated !== true) { pending.reject(new Error('TEMPLATE_FAILED')); continue }
            if (pending.action === 'delete' && result.deleted !== true) { pending.reject(new Error('TEMPLATE_FAILED')); continue }
            if (pending.action === 'use' && result.used !== true) { pending.reject(new Error('TEMPLATE_FAILED')); continue }
            const idPattern = /^[A-Za-z0-9_-]{1,128}$/
            const templates: TemplateRowView[] = []
            for (const row of result.templates.slice(0, 200)) {
              if (!row || typeof row.id !== 'string' || !idPattern.test(row.id) ||
                  typeof row.name !== 'string' || !row.name ||
                  typeof row.category !== 'string' || typeof row.content !== 'string' ||
                  !Number.isSafeInteger(row.usageCount) || row.usageCount < 0 ||
                  typeof row.visibility !== 'string' || typeof row.updatedAt !== 'string') throw new Error('Invalid template row')
              templates.push({ id: row.id, name: row.name.slice(0, 200), category: row.category.slice(0, 64),
                content: row.content.slice(0, 16000),
                usageCount: Math.min(row.usageCount, 1000000000),
                visibility: row.visibility.slice(0, 32), updatedAt: row.updatedAt.slice(0, 64) })
            }
            const view: TemplateView = { templates }
            if (pending.action === 'create') view.created = true
            if (pending.action === 'update') view.updated = true
            if (pending.action === 'delete') view.deleted = true
            if (pending.action === 'use') view.used = true
            pending.resolve(view)
            continue
          }
          if (value.v === 1 && value.type === 'connectors') {
            // Issue 123: the connector installer's fixed categories and
            // identity-only projections. Paths, package bytes and the
            // controlled configuration never cross this boundary.
            const pending = this.connectorRequests.get(value.id)
            if (!pending) continue
            this.connectorRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            if (!result || typeof result !== 'object') { pending.reject(new Error('CONNECTOR_FAILED')); continue }
            const text = (input: unknown, limit: number): string => typeof input === 'string' ? input.slice(0, limit) : ''
            const hash = (input: unknown): string => typeof input === 'string' && /^[0-9a-f]{64}$/.test(input) ? input : ''
            const slug = (input: unknown): string => typeof input === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input) ? input : ''
            if (pending.action === 'list') {
              if (!Array.isArray(result.connectors)) { pending.reject(new Error('CONNECTOR_FAILED')); continue }
              const connectors: ConnectorView[] = []
              for (const row of result.connectors.slice(0, 20)) {
                if (!row || !slug(row.slug) || row.state !== 'installed' || typeof row.createdAt !== 'string') throw new Error('Invalid connector status')
                connectors.push({ slug: row.slug, displayName: text(row.displayName, 200), version: text(row.version, 32),
                  entry: text(row.entry, 256), manifestHash: hash(row.manifestHash), packageHash: hash(row.packageHash),
                  serverConnectorId: text(row.serverConnectorId, 64), state: 'installed', createdAt: row.createdAt })
              }
              pending.resolve({ action: 'list', connectors })
              continue
            }
            if (pending.action === 'remove') {
              if (result.removed !== true || !slug(result.slug)) { pending.reject(new Error('CONNECTOR_FAILED')); continue }
              pending.resolve({ action: 'remove', removed: true, slug: result.slug, displayName: text(result.displayName, 200) })
              continue
            }
            // Preview and install share the identity-projection shape.
            if (!slug(result.slug) || typeof result.installed !== 'boolean' ||
                !Number.isSafeInteger(result.fileCount) || !hash(result.manifestHash) || !hash(result.packageHash)) {
              pending.reject(new Error('CONNECTOR_FAILED')); continue
            }
            const base = { slug: result.slug, displayName: text(result.displayName, 200), version: text(result.version, 32),
              manifestHash: hash(result.manifestHash), packageHash: hash(result.packageHash),
              fileCount: result.fileCount, entry: text(result.entry, 256) }
            if (pending.action === 'preview') {
              pending.resolve({ action: 'preview', ...base, installed: result.installed, ...(result.unchanged === true ? { unchanged: true } : {}) })
              continue
            }
            if (result.installed !== true || result.state !== 'installed') { pending.reject(new Error('CONNECTOR_FAILED')); continue }
            pending.resolve({ action: 'install', ...base, installed: true, state: 'installed',
              serverConnectorId: text(result.serverConnectorId, 64) })
            continue
          }
          if (value.v === 1 && value.type === 'workspace') {
            if (value.id !== this.workspaceRequest?.id) continue
            if (value.error) this.workspaceRequest?.reject(new Error('WORKSPACE_SELECTION_FAILED'))
            else this.workspaceRequest?.resolve()
            continue
          }
          if (value.v === 1 && value.type === 'files') {
            // Issue 94: bounded browse/preview/locate replies. The `locate`
            // result (a physical path) is consumed only by the trusted main
            // process for the external open; the renderer never receives it.
            const pending = this.filesRequests.get(value.id)
            if (!pending) continue
            this.filesRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            const bad = (): void => { pending.reject(new Error('FILES_FAILED')) }
            if (!result || typeof result !== 'object') { bad(); continue }
            if (Array.isArray((result as FilesListView).entries)) {
              const rows: FilesListView['entries'] = (result as FilesListView).entries
              if (typeof (result as FilesListView).truncated !== 'boolean' || rows.length > 501 ||
                  rows.some((row) => !row || typeof row.name !== 'string' || !row.name ||
                    row.name.length > 256 || (row.kind !== 'dir' && row.kind !== 'file') ||
                    !Number.isSafeInteger(row.size) || row.size < 0)) { bad(); continue }
              pending.resolve({ entries: rows.map((row) => ({ name: row.name, kind: row.kind, size: row.size })),
                truncated: (result as FilesListView).truncated })
              continue
            }
            if ((result as FilesPreview).kind === 'text') {
              const text = result as { kind: 'text'; content: unknown; truncated: unknown }
              if (typeof text.content !== 'string' || text.content.length > 1048576 ||
                  typeof text.truncated !== 'boolean') { bad(); continue }
              pending.resolve({ kind: 'text', content: text.content, truncated: text.truncated })
              continue
            }
            if ((result as FilesPreview).kind === 'image') {
              const image = result as { kind: 'image'; mime: unknown; data: unknown }
              const mimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon']
              if (typeof image.mime !== 'string' || !mimes.includes(image.mime) ||
                  typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
                  image.data.length > 2800000) { bad(); continue }
              pending.resolve({ kind: 'image', mime: image.mime, data: image.data })
              continue
            }
            if (typeof (result as { physical?: unknown }).physical === 'string' &&
                (result as { physical: string }).physical.length > 0 &&
                (result as { physical: string }).physical.length <= 4096) {
              pending.resolve({ physical: (result as { physical: string }).physical })
              continue
            }
            bad()
            continue
          }
          if (value.v === 1 && value.type === 'models') {
            // Issue 73: the Server's own authorized list and preference
            // facts, bounded before they reach the renderer. The projection
            // drops anything the Server did not state and can never carry a
            // provider, endpoint or key field — the family has none.
            const pending = this.modelRequests.get(value.id)
            if (!pending) continue
            this.modelRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            const text = (input: unknown, limit: number): string => typeof input === 'string' ? input.slice(0, limit) : ''
            if (!result || !Array.isArray(result.models) || typeof result.canRead !== 'boolean') {
              pending.reject(new Error('MODEL_SETTINGS_FAILED')); continue
            }
            const models: ModelRowView[] = result.models.slice(0, 50).map((row: Record<string, unknown>) => ({
              name: text(row?.name, 200), displayName: text(row?.displayName, 200),
              description: text(row?.description, 500), supportsThinking: row?.supportsThinking === true
            })).filter((row: ModelRowView) => row.name !== '')
            pending.resolve({ models, canRead: result.canRead,
              reason: text(result.reason, 64),
              accountDefault: text(result.accountDefault, 200),
              fallback: text(result.fallback, 200) })
            continue
          }
          if (value.v === 1 && value.type === 'chat') {
            const result = value.result
            if (!result || typeof result.scope !== 'string' || typeof result.error !== 'string' ||
                !['idle', 'streaming', 'disconnected', 'uncertain'].includes(result.stream) ||
                // Issue 76: the sub-agent ledger is part of every snapshot the
                // Runtime returns, exactly like the transcript arrays.
                !['resources', 'threads', 'messages', 'events', 'subagents'].every((key) => Array.isArray(result[key]))) throw new Error('Invalid chat response')
            // Issue 73: the model display facts ride every snapshot; a shape
            // violation kills the child rather than showing invented state.
            // The option rows get the same bounded projection as the models
            // reply — display facts only, no invented fields.
            if (result.model && (typeof result.model !== 'object' ||
                !['session-override', 'account-default', 'platform-default'].includes(result.model.source) ||
                typeof result.model.name !== 'string' || result.model.name.length > 200 ||
                typeof result.model.reason !== 'string' || result.model.reason.length > 64 ||
                typeof result.model.notice !== 'string' || result.model.notice.length > 500 ||
                typeof result.model.switchedFrom !== 'string' || result.model.switchedFrom.length > 200 ||
                typeof result.model.available !== 'boolean')) throw new Error('Invalid chat response')
            if (result.modelOptions !== undefined) {
              if (!Array.isArray(result.modelOptions)) throw new Error('Invalid chat response')
              result.modelOptions = result.modelOptions.slice(0, 50).map((row: Record<string, unknown>) => ({
                name: typeof row?.name === 'string' ? row.name.slice(0, 200) : '',
                displayName: typeof row?.displayName === 'string' ? row.displayName.slice(0, 200) : '',
                description: typeof row?.description === 'string' ? row.description.slice(0, 500) : '',
                supportsThinking: row?.supportsThinking === true
              })).filter((row: ModelRowView) => row.name !== '')
            }
            // Issue 72: the sidebar's Thread management carries the same
            // identity the chat session itself last reported.
            this.chatScope = result.scope
            this.chatRequests.get(value.id)?.resolve(result)
            continue
          }
          if (value.v === 1 && value.type === 'browser-stream') {
            const pending = this.browserStreamRequest
            if (!pending || value.id !== pending.id) continue
            if (value.error) { pending.reject(new Error(value.error)); continue }
            if (pending.action === 'open') {
              const streamId = value.result?.streamId
              if (typeof streamId !== 'string' || streamId.length < 1 || streamId.length > 64) throw new Error('Invalid browser stream reply')
              pending.resolve({ streamId })
              continue
            }
            pending.resolve({ acknowledged: true })
            continue
          }
          if (value.v === 1 && value.type === 'browser-input') {
            const pending = this.browserInputRequests.get(value.id)
            if (!pending) continue
            if (value.error) { this.browserInputRequests.delete(value.id); pending.reject(new Error(value.error)); continue }
            pending.resolve()
            continue
          }
          if (value.v === 1 && value.type === 'browser-stream-event') {
            // Issue 109: every push is projected through the bounded parser;
            // anything malformed means the wire protocol itself failed and
            // kills the child, exactly like every other family.
            const message = parseRemoteBrowserStreamWire(value)
            if (!message) throw new Error('Invalid browser stream event')
            this.remoteBrowserHandler?.(message)
            continue
          }
          if (value.v === 1 && value.type === 'browser-control') {
            // Issue 108: one consented action per frame. The bounded parser
            // decides the shape; a malformed frame is a wire failure and
            // kills the child like every other family.
            const message = parseAgentBrowserCommandWire(value)
            if (!message) throw new Error('Invalid browser control frame')
            this.agentBrowserHandler?.(message.id, message.command)
            continue
          }
          if (value.v === 1 && value.type === 'notify') {
            // Issue 77: one bounded background-session fact per line. The
            // Runtime only reports runs the user switched away from and
            // approval asks on sessions the user cannot currently see.
            const event = parseNotifyEvent(value.event)
            if (!event) throw new Error('Invalid notify event')
            this.notifyHandler?.(event)
            continue
          }
          const connections = ['not-configured', 'connecting', 'connected', 'paused', 'offline', 'error']
          if (value.v !== 1 || !connections.includes(value.connection) || !Array.isArray(value.tasks)) throw new Error('Invalid status')
          const tasks: RuntimeTask[] = value.tasks.slice(0, 20).map((task: RuntimeTask) => {
            if (['taskId', 'runId', 'capability', 'state'].some((key) => typeof task[key as keyof RuntimeTask] !== 'string' || task[key as keyof RuntimeTask].length > 256)) throw new Error('Invalid task status')
            return { taskId: task.taskId, runId: task.runId, capability: task.capability, state: task.state }
          })
          let login: LoginStatus | undefined
          if (value.login) {
            if (!['unauthenticated', 'awaiting-confirmation', 'authenticated', 'expired', 'error'].includes(value.login.state) ||
                ['account', 'device', 'error'].some((key) => typeof value.login[key] !== 'string' || value.login[key].length > 256)) throw new Error('Invalid login status')
            // Issue 95: the optional bound device id, held to the Runtime's own
            // wire id grammar (_is_id: 1-128 chars of [A-Za-z0-9_-], the same
            // discipline the projects surface enforces on projectId). A
            // present-but-malformed value is a protocol failure, not a field
            // to silently drop.
            const deviceId = typeof value.login.deviceId === 'string' &&
              /^[A-Za-z0-9_-]{1,128}$/.test(value.login.deviceId) ? value.login.deviceId : ''
            if (value.login.deviceId !== undefined && !deviceId) throw new Error('Invalid login status')
            login = { state: value.login.state, account: value.login.account, device: value.login.device, error: value.login.error }
            if (deviceId) login.deviceId = deviceId
            if (typeof value.login.verification === 'string' && /^[0-9a-f]{12}$/.test(value.login.verification)) login.verification = value.login.verification
            if (login.state === 'error') this.loginRequest?.reject(new Error(login.error || 'LOGIN_FAILED'))
          }
          if (value.browserUrl) {
            const url = new URL(value.browserUrl)
            if (!this.loginRequest || url.origin !== this.loginRequest.origin || url.pathname !== '/desktop-login' ||
                url.username || url.password || url.hash || [...url.searchParams.keys()].join() !== 'login_id' ||
                !/^[A-Za-z0-9-]{1,64}$/.test(url.searchParams.get('login_id') || '')) throw new Error('Invalid browser URL')
            this.loginRequest.resolve(url.href)
          }
          if (typeof value.selectionScope === 'string' && /^[0-9a-f]{64}$/.test(value.selectionScope)) this.selectionScope = value.selectionScope
          this.loginOrigin = ''
          if (login?.state === 'authenticated' && value.serverOrigin) {
            const origin = new URL(value.serverOrigin)
            if (origin.origin !== value.serverOrigin || origin.username || origin.password ||
                !['http:', 'https:'].includes(origin.protocol) ||
                (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('Invalid paired origin')
            this.loginOrigin = origin.origin
          }
          this.receiptScope = typeof value.receiptScope === 'string' && /^[0-9a-f]{64}$/.test(value.receiptScope) ? value.receiptScope : ''
          const knowledgeImports: KnowledgeImportView[] = []
          if (Array.isArray(value.knowledgeImports)) {
            for (const row of value.knowledgeImports.slice(0, 20)) {
              if (!row || typeof row.id !== 'string' || typeof row.kbId !== 'string' || typeof row.status !== 'string' ||
                  !['registered', 'failed'].includes(row.status) ||
                  (row.status === 'registered' ? typeof row.revisionId !== 'string' || !/^[0-9a-f]{64}$/.test(row.manifestHash || '') : false) ||
                  !Number.isSafeInteger(row.documentCount) || typeof row.createdAt !== 'string' ||
                  (row.status === 'failed' ? typeof row.errorCode !== 'string' || !row.errorCode : false)) throw new Error('Invalid knowledge import status')
              knowledgeImports.push({ id: row.id, kbId: row.kbId, revisionId: typeof row.revisionId === 'string' ? row.revisionId : '',
                revisionNo: Number.isSafeInteger(row.revisionNo) ? row.revisionNo : 0,
                manifestHash: typeof row.manifestHash === 'string' ? row.manifestHash : '',
                documentCount: row.documentCount, status: row.status === 'registered' ? 'registered' : 'failed',
                errorCode: typeof row.errorCode === 'string' ? row.errorCode : '', createdAt: row.createdAt,
                projectId: typeof row.projectId === 'string' ? row.projectId : '',
                // Issue 101: the version-semantics display facts — the
                // user-confirmed cleanup marker, the successor pointer, and
                // the derived historical flag; all optional, never invented.
                originalsMissing: row.originalsMissing === true ? true : undefined,
                supersededBy: typeof row.supersededBy === 'string' ? row.supersededBy : undefined,
                historical: row.historical === true ? true : undefined,
                source: row.source && typeof row.source === 'object' && typeof (row.source as { folder?: unknown }).folder === 'string'
                  ? { kind: typeof (row.source as { kind?: unknown }).kind === 'string' ? String((row.source as { kind?: unknown }).kind) : '',
                      folder: String((row.source as { folder?: unknown }).folder),
                      pathCount: Number.isSafeInteger((row.source as { pathCount?: unknown }).pathCount) ? Number((row.source as { pathCount?: unknown }).pathCount) : 0 }
                  : null,
                documents: Array.isArray(row.documents) ? row.documents.slice(0, 200).map((document: { filename?: unknown; sha256?: unknown; bytes?: unknown; mime?: unknown }) => ({
                  filename: typeof document?.filename === 'string' ? document.filename : '',
                  sha256: typeof document?.sha256 === 'string' ? document.sha256 : '',
                  bytes: Number.isSafeInteger(document?.bytes) ? document.bytes : 0,
                  mime: typeof document?.mime === 'string' ? document.mime : '' })) : [],
                // Issue 97: the revision's derived BM25 index facts; a
                // malformed view reads as absent, never as a readiness claim.
                index: this.parseKnowledgeIndexView(row.index) })
            }
          }
          lastStatus = Date.now()
          const knowledgePublications: KnowledgePublicationView[] = []
          if (Array.isArray(value.knowledgePublications)) {
            for (const row of value.knowledgePublications.slice(0, 20)) {
              if (!row || typeof row.id !== 'string' || typeof row.kbId !== 'string' ||
                  typeof row.revisionId !== 'string' || typeof row.status !== 'string' ||
                  !['published', 'failed'].includes(row.status) ||
                  typeof row.copyResourceId !== 'string' || typeof row.copySlug !== 'string' ||
                  !Number.isSafeInteger(row.documentCount) || typeof row.createdAt !== 'string' ||
                  (row.status === 'failed' ? typeof row.errorCode !== 'string' || !row.errorCode : false)) throw new Error('Invalid knowledge publication status')
              knowledgePublications.push({ id: row.id, kbId: row.kbId, revisionId: row.revisionId,
                copyResourceId: row.copyResourceId, copySlug: row.copySlug,
                copyRevisionId: typeof row.copyRevisionId === 'string' ? row.copyRevisionId : '',
                status: row.status === 'published' ? 'published' : 'failed',
                errorCode: typeof row.errorCode === 'string' ? row.errorCode : '',
                documentCount: row.documentCount, createdAt: row.createdAt })
            }
          }
          const skillImports: SkillImportView[] = []
          if (Array.isArray(value.skillImports)) {
            for (const row of value.skillImports.slice(0, 20)) {
              // Issue 120: rows are device-local display facts; an imported
              // row carries its draft handle, a published row its version
              // copy, and a failed row only its fixed category.
              if (!row || typeof row.id !== 'string' || typeof row.resourceId !== 'string' ||
                  !['imported', 'published', 'failed'].includes(row.status) ||
                  !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.version) ||
                  typeof row.createdAt !== 'string' ||
                  (row.status !== 'failed' ? typeof row.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.contentHash) : false) ||
                  (row.status === 'failed' ? typeof row.errorCode !== 'string' || !row.errorCode : false)) throw new Error('Invalid skill import status')
              skillImports.push({ id: row.id, resourceId: row.resourceId, slug: typeof row.slug === 'string' ? row.slug : '',
                revision: row.revision, contentHash: typeof row.contentHash === 'string' ? row.contentHash : '',
                version: row.version, origin: typeof row.origin === 'string' ? row.origin : '',
                fileCount: Number.isSafeInteger(row.fileCount) ? row.fileCount : 0,
                totalBytes: Number.isSafeInteger(row.totalBytes) ? row.totalBytes : 0,
                status: row.status, errorCode: typeof row.errorCode === 'string' ? row.errorCode : '', createdAt: row.createdAt })
            }
          }
          const scriptAuthorizations: SkillScriptAuthorizationView[] = []
          if (Array.isArray(value.skillScriptAuthorizations)) {
            for (const row of value.skillScriptAuthorizations.slice(0, 20)) {
              // Issue 122: rows are device-local display facts for the exact
              // content/scope bindings this account granted; hashes only.
              if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) ||
                  typeof row.resourceId !== 'string' || typeof row.scriptPath !== 'string' ||
                  !row.scriptPath.startsWith('scripts/') || typeof row.scriptSha256 !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(row.scriptSha256) || typeof row.requirementsHash !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(row.requirementsHash) || row.status !== 'granted' ||
                  typeof row.createdAt !== 'string') throw new Error('Invalid skill script status')
              scriptAuthorizations.push({ id: row.id, resourceId: row.resourceId,
                slug: typeof row.slug === 'string' ? row.slug.slice(0, 128) : '',
                version: Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : 0,
                contentHash: typeof row.contentHash === 'string' && /^[0-9a-f]{64}$/.test(row.contentHash) ? row.contentHash : '',
                scriptPath: row.scriptPath.slice(0, 512), scriptSha256: row.scriptSha256,
                requirementsHash: row.requirementsHash, status: 'granted', createdAt: row.createdAt })
            }
          }
          const connectorRows: ConnectorView[] = []
          if (Array.isArray(value.connectors)) {
            const connectorSlug = (input: unknown): string => typeof input === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input) ? input : ''
            const connectorText = (input: unknown, limit: number): string => typeof input === 'string' ? input.slice(0, limit) : ''
            const connectorHash = (input: unknown): string => typeof input === 'string' && /^[0-9a-f]{64}$/.test(input) ? input : ''
            for (const row of value.connectors.slice(0, 20)) {
              // Issue 123: installed connector identity facts for this
              // profile; no device paths, no package bytes, no binding.
              if (!row || !connectorSlug(row.slug) || row.state !== 'installed' ||
                  typeof row.createdAt !== 'string') throw new Error('Invalid connector status')
              connectorRows.push({ slug: row.slug, displayName: connectorText(row.displayName, 200),
                version: connectorText(row.version, 32), entry: connectorText(row.entry, 256),
                manifestHash: connectorHash(row.manifestHash), packageHash: connectorHash(row.packageHash),
                serverConnectorId: connectorText(row.serverConnectorId, 64), state: 'installed', createdAt: row.createdAt })
            }
          }
          // Issue 92: this device's own project folder bindings ride the same
          // snapshot; main consumes them for the terminal start-dir chain and
          // a malformed row is a protocol failure like any other.
          const projectBindings: ProjectBindingView[] = []
          if (Array.isArray(value.projectBindings)) {
            for (const row of value.projectBindings.slice(0, 20)) {
              if (!row || typeof row.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.projectId) ||
                  typeof row.path !== 'string' || !row.path || row.path.length > 1024 ||
                  typeof row.deviceName !== 'string' || row.deviceName.length > 128 ||
                  typeof row.createdAt !== 'string') throw new Error('Invalid project binding status')
              projectBindings.push({ projectId: row.projectId, path: row.path,
                deviceName: row.deviceName.slice(0, 128), createdAt: row.createdAt.slice(0, 64) })
            }
          }
          const datasetRows: DatasetView[] = []
          if (Array.isArray(value.datasets)) {
            for (const row of value.datasets.slice(0, 20)) {
              // Issue 102: device-local dataset rows are display facts for
              // this identity's own imports; schema and fingerprints only,
              // never row data. A malformed row is a protocol failure.
              datasetRows.push(toDatasetView(row))
            }
          }
          if (typeof value.installDrain !== 'boolean' || !Number.isSafeInteger(value.activeTasks) ||
              !Number.isSafeInteger(value.unknownWriteEffects) || value.unknownWriteEffects < 0) throw new Error('Invalid status')
          // Issue 77: the bounded background-run summary; identity facts the
          // status surface may show, never a concurrency cap.
          const backgroundRuns: { threadId: string; runId: string }[] = []
          if (value.backgroundRuns !== undefined) {
            if (!Array.isArray(value.backgroundRuns)) throw new Error('Invalid status')
            for (const row of value.backgroundRuns.slice(0, 20)) {
              if (!row || typeof row.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.threadId) ||
                  typeof row.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.runId) ||
                  Object.keys(row).length !== 2) throw new Error('Invalid status')
              backgroundRuns.push({ threadId: row.threadId, runId: row.runId })
            }
          }
          if (!this.stopping) this.snapshot = { process: 'running', connection: value.connection, tasks, pid: child.pid, login, workspace: value.workspace,
            compatibility: value.compatibility,
            installDrain: value.installDrain, activeTasks: value.activeTasks, unknownWriteEffects: value.unknownWriteEffects,
            backgroundRuns,
            directoryGrants: Array.isArray(value.directoryGrants) ? value.directoryGrants : [],
            knowledgeImports, knowledgeImportStorageError: value.knowledgeImportStorageError === 'IMPORT_STORAGE_UNAVAILABLE' ? value.knowledgeImportStorageError : '',
            knowledgeFolderImport: this.parseKnowledgeFolderJob(value.knowledgeFolderImport),
            knowledgeIndexRebuild: this.parseKnowledgeIndexJob(value.knowledgeIndexRebuild),
            knowledgeIndexStorageError: value.knowledgeIndexStorageError === 'KNOWLEDGE_INDEX_STORAGE_UNAVAILABLE' ? value.knowledgeIndexStorageError : '',
            datasets: datasetRows,
            datasetsStorageError: value.datasetsStorageError === 'DATASETS_STORAGE_UNAVAILABLE' ? value.datasetsStorageError : '',
            knowledgePublications, knowledgePublishStorageError: value.knowledgePublishStorageError === 'PUBLISH_STORAGE_UNAVAILABLE' ? value.knowledgePublishStorageError : '',
            skillImports, skillImportStorageError: value.skillImportStorageError === 'SKILL_IMPORT_STORAGE_UNAVAILABLE' ? value.skillImportStorageError : '',
            skillScriptAuthorizations: scriptAuthorizations,
            skillScriptStorageError: value.skillScriptStorageError === 'SKILL_SCRIPT_STORAGE_UNAVAILABLE' ? value.skillScriptStorageError : '',
            connectors: connectorRows,
            connectorStorageError: value.connectorStorageError === 'CONNECTOR_STORAGE_UNAVAILABLE' ? value.connectorStorageError : '',
            projectBindings,
            projectBindingStorageError: value.projectBindingStorageError === 'PROJECT_BINDING_STORAGE_UNAVAILABLE' ? value.projectBindingStorageError : '',
            receiptStorageError: value.receiptStorageError === 'RECEIPT_STORAGE_UNAVAILABLE' ? value.receiptStorageError : '', receiptScope: this.receiptScope }
        } catch { child.kill() }
      }
    })
    // Drain diagnostics without exposing possible credential-bearing exceptions.
    // Runtime diagnostics must survive a failed session: tee stderr to the
    // profile (bounded) instead of discarding it.
    const stderrLog = join(this.profile, 'runtime-stderr.log')
    try { writeFileSync(stderrLog, '') } catch {}
    child.stderr.on('data', (chunk: Buffer) => {
      try { appendFileSync(stderrLog, chunk) } catch {}
      if (statSync(stderrLog).size > 1024 * 1024) { try { writeFileSync(stderrLog, '') } catch {} }
    })
    child.stdin.on('error', () => {})
    child.on('error', () => {
      this.snapshot = { process: 'crashed', connection: 'offline', tasks: [] }
    })
    child.on('close', () => {
      this.loginOrigin = ''
      this.chatScope = ''
      this.healthRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      this.managementRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      this.workspaceRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      this.loginRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.chatRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.receiptRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.knowledgeRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.knowledgePublishRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.knowledgeGraphRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.knowledgeWikiRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.skillScriptRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.modelRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.threadRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.datasetRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.schedulesRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      // Issue 109: a dead child ends the remote browser's pending lifecycle
      // request and every in-flight input forward immediately.
      this.browserStreamRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.browserInputRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      clearInterval(watch)
      this.child = null
      this.snapshot = { process: this.stopping ? 'stopped' : 'crashed', connection: 'offline', tasks: [] }
    })
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child) return
    this.snapshot = { process: 'stopping', connection: 'offline', tasks: [], pid: child.pid }
    this.stopping = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill(), 12000)
      child.once('close', () => { clearTimeout(timeout); resolve() })
      child.stdin.end('{"type":"shutdown"}\n')
    })
    try { await this.stopping } finally { this.stopping = null }
  }
}
