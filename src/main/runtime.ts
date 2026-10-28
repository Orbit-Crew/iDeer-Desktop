import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatCommand, ChatSnapshot, ConnectorCommand, ConnectorInstallCommand, ConnectorInternalOutcome, ConnectorOutcome, ConnectorPreviewCommand, ConnectorView, KnowledgeGraphAskResult, KnowledgeGraphCommand, KnowledgeGraphQueryResult, KnowledgeGraphScopeRow, KnowledgeGraphSourceLocation, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeImportView, KnowledgePublicationView, KnowledgePublishOutcome, KnowledgePublishPreview, LoginStatus, RuntimeStatus, RuntimeTask, ReceiptHistory, SkillImportOutcome, SkillImportPreview, SkillImportView, SkillPackageFileView, SkillPreferenceCommand, SkillPreferencesView, SkillPublishOutcome, SkillScriptAuthorizationView, SkillScriptCommand, SkillScriptView, SkillTriggerPreferenceView, WikiCommand, WikiNavigation, WikiPage, WikiPageSummary, WikiView } from '../shared/desktop'

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
  private knowledgeGraphRequests = new Map<string, { resolve: (view: KnowledgeGraphView | KnowledgeGraphSourceLocation | KnowledgeGraphQueryResult | KnowledgeGraphAskResult) => void; reject: (error: Error) => void; action: KnowledgeGraphCommand['action'] }>()
  private knowledgeWikiRequests = new Map<string, { resolve: (view: WikiView | WikiPage | WikiNavigation) => void; reject: (error: Error) => void; action: WikiCommand['action'] }>()
  private skillImportRequests = new Map<string, { resolve: (outcome: SkillImportPreview | SkillImportOutcome) => void; reject: (error: Error) => void; phase: 'preview' | 'confirm' }>()
  private skillPublishRequests = new Map<string, { resolve: (outcome: SkillPublishOutcome) => void; reject: (error: Error) => void }>()
  private skillPreferenceRequests = new Map<string, { resolve: (view: SkillPreferencesView) => void; reject: (error: Error) => void }>()
  private skillScriptRequests = new Map<string, { resolve: (view: SkillScriptView) => void; reject: (error: Error) => void }>()
  private connectorRequests = new Map<string, { resolve: (outcome: ConnectorInternalOutcome) => void; reject: (error: Error) => void; action: (ConnectorCommand | ConnectorPreviewCommand)['action'] }>()
  private managementRequest: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null
  private healthRequest: { id: string; resolve: (value: { python: string; pid: number; echo: string }) => void; reject: (error: Error) => void } | null = null
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

  /** Issue 116/117: one controlled-graph step (view / generate / source locate / scoped search / scoped ask). */
  async knowledgeGraph(command: KnowledgeGraphCommand): Promise<KnowledgeGraphView | KnowledgeGraphSourceLocation | KnowledgeGraphQueryResult | KnowledgeGraphAskResult> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('KNOWLEDGE_GRAPH_COMMAND_INVALID')
    if (!['view', 'generate', 'locate', 'search', 'ask'].includes(command.action)) throw new Error('KNOWLEDGE_GRAPH_ACTION_INVALID')
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
        resolve: (view) => { clearTimeout(timer); this.skillScriptRequests.delete(id); resolve(view) },
        reject: (error) => { clearTimeout(timer); this.skillScriptRequests.delete(id); reject(error) }
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
      state: ['action'], refresh: ['action'], compatibility: ['action'], create: ['action', 'scope', 'agentId', 'skillId'],
      open: ['action', 'scope', 'threadId'], reconnect: ['action', 'scope', 'threadId'],
      stop: ['action', 'scope', 'threadId', 'runId'],
      send: ['action', 'scope', 'threadId', 'turnId', 'text'],
      answer: ['action', 'scope', 'threadId', 'turnId', 'requestId', 'text', 'optionId'],
      consent: ['action', 'scope', 'threadId', 'runId', 'taskId', 'requestHash', 'decision'],
      upload: ['action', 'scope', 'threadId', 'runId', 'taskId', 'decision'],
      download: ['action', 'scope', 'threadId', 'artifactId']
    }
    const allowed = keys[command.action]
    if (command.action === 'stop' && (Object.keys(command).length !== 4 || !command.scope || !command.threadId || !command.runId)) throw new Error('CHAT_COMMAND_INVALID')
    if (command.action === 'consent' && (Object.keys(command).length !== 7 || !['allow', 'allow-directory', 'deny'].includes(command.decision) || !/^[0-9a-f]{64}$/.test(command.requestHash))) throw new Error('CHAT_COMMAND_INVALID')
    // The only upload decision the renderer may send is an explicit allow;
    // everything else stays a malformed command.
    if (command.action === 'upload' && (Object.keys(command).length !== 6 || command.decision !== 'allow')) throw new Error('CHAT_COMMAND_INVALID')
    if (command.action === 'download' && (Object.keys(command).length !== 4 || !command.scope ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(command.threadId) || !/^[A-Za-z0-9_-]{1,128}$/.test(command.artifactId))) throw new Error('CHAT_COMMAND_INVALID')
    if (!allowed || Object.entries(command).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string' || value.length > (key === 'text' ? 16000 : 256))) {
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
    const child = spawn(executable, ['-I', '-u', '-X', 'utf8', '-m', 'core.desktop', '--config', join(this.profile, 'settings.json'), '--desktop-version', this.desktopVersion,
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
                errorCode: text(outcome.errorCode, 64), body })
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
              const files = (rows: unknown): SkillImportPreview['files'] => Array.isArray(rows) ? rows.slice(0, 200).map((row: Record<string, unknown>) => ({
                path: text(row?.path, 255),
                role: ['body', 'script', 'reference', 'attachment'].includes(row?.role as string) ? row.role as SkillImportPreview['files'][number]['role'] : 'attachment',
                bytes: Number.isSafeInteger(row?.bytes) && (row.bytes as number) >= 0 ? row.bytes as number : 0,
                sha256: text(row?.sha256, 64)
              })).filter((row: SkillPackageFileView) => row.path !== '' && /^[0-9a-f]{64}$/.test(row.sha256)) : []
              if (!outcome || typeof outcome.confirmed !== 'boolean' || typeof outcome.packageHash !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(outcome.packageHash) || typeof outcome.name !== 'string' ||
                  !Number.isSafeInteger(outcome.fileCount) || !Number.isSafeInteger(outcome.totalBytes)) {
                this.skillImportRequests.delete(value.id)
                importer.reject(new Error('SKILL_IMPORT_FAILED'))
                continue
              }
              if (outcome.confirmed === false) {
                if (importer.phase !== 'preview' || !outcome.destination || outcome.destination.visibility !== 'private') {
                  this.skillImportRequests.delete(value.id)
                  importer.reject(new Error('SKILL_IMPORT_FAILED'))
                  continue
                }
                importer.resolve({ confirmed: false, origin: outcome.origin === 'markdown' || outcome.origin === 'zip' || outcome.origin === 'directory' ? outcome.origin : 'zip',
                  name: outcome.name, description: text(outcome.description, 1024), bodyExcerpt: text(outcome.body, 2000), files: files(outcome.files),
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
            const pending = this.skillScriptRequests.get(value.id)
            if (!pending) continue
            this.skillScriptRequests.delete(value.id)
            if (value.error) { pending.reject(new Error(value.error)); continue }
            const result = value.result
            if (!result || !Array.isArray(result.authorizations)) { pending.reject(new Error('SKILL_SCRIPT_FAILED')); continue }
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
            pending.resolve({ authorizations })
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
          if (value.v === 1 && value.type === 'chat') {
            const result = value.result
            if (!result || typeof result.scope !== 'string' || typeof result.error !== 'string' ||
                !['idle', 'streaming', 'disconnected', 'uncertain'].includes(result.stream) ||
                !['resources', 'threads', 'messages', 'events'].every((key) => Array.isArray(result[key]))) throw new Error('Invalid chat response')
            this.chatRequests.get(value.id)?.resolve(result)
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
            login = { state: value.login.state, account: value.login.account, device: value.login.device, error: value.login.error }
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
                documents: Array.isArray(row.documents) ? row.documents.slice(0, 200).map((document: { filename?: unknown; sha256?: unknown; bytes?: unknown; mime?: unknown }) => ({
                  filename: typeof document?.filename === 'string' ? document.filename : '',
                  sha256: typeof document?.sha256 === 'string' ? document.sha256 : '',
                  bytes: Number.isSafeInteger(document?.bytes) ? document.bytes : 0,
                  mime: typeof document?.mime === 'string' ? document.mime : '' })) : [] })
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
          if (typeof value.installDrain !== 'boolean' || !Number.isSafeInteger(value.activeTasks) ||
              !Number.isSafeInteger(value.unknownWriteEffects) || value.unknownWriteEffects < 0) throw new Error('Invalid status')
          if (!this.stopping) this.snapshot = { process: 'running', connection: value.connection, tasks, pid: child.pid, login, workspace: value.workspace,
            compatibility: value.compatibility,
            installDrain: value.installDrain, activeTasks: value.activeTasks, unknownWriteEffects: value.unknownWriteEffects,
            directoryGrants: Array.isArray(value.directoryGrants) ? value.directoryGrants : [],
            knowledgeImports, knowledgeImportStorageError: value.knowledgeImportStorageError === 'IMPORT_STORAGE_UNAVAILABLE' ? value.knowledgeImportStorageError : '',
            knowledgePublications, knowledgePublishStorageError: value.knowledgePublishStorageError === 'PUBLISH_STORAGE_UNAVAILABLE' ? value.knowledgePublishStorageError : '',
            skillImports, skillImportStorageError: value.skillImportStorageError === 'SKILL_IMPORT_STORAGE_UNAVAILABLE' ? value.skillImportStorageError : '',
            skillScriptAuthorizations: scriptAuthorizations,
            skillScriptStorageError: value.skillScriptStorageError === 'SKILL_SCRIPT_STORAGE_UNAVAILABLE' ? value.skillScriptStorageError : '',
            connectors: connectorRows,
            connectorStorageError: value.connectorStorageError === 'CONNECTOR_STORAGE_UNAVAILABLE' ? value.connectorStorageError : '',
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
