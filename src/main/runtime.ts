import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatCommand, ChatSnapshot, KnowledgeGraphAskResult, KnowledgeGraphCommand, KnowledgeGraphQueryResult, KnowledgeGraphScopeRow, KnowledgeGraphSourceLocation, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeImportView, KnowledgePublicationView, KnowledgePublishOutcome, KnowledgePublishPreview, LoginStatus, RuntimeStatus, RuntimeTask, ReceiptHistory } from '../shared/desktop'

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
          if (typeof value.installDrain !== 'boolean' || !Number.isSafeInteger(value.activeTasks) ||
              !Number.isSafeInteger(value.unknownWriteEffects) || value.unknownWriteEffects < 0) throw new Error('Invalid status')
          if (!this.stopping) this.snapshot = { process: 'running', connection: value.connection, tasks, pid: child.pid, login, workspace: value.workspace,
            compatibility: value.compatibility,
            installDrain: value.installDrain, activeTasks: value.activeTasks, unknownWriteEffects: value.unknownWriteEffects,
            directoryGrants: Array.isArray(value.directoryGrants) ? value.directoryGrants : [],
            knowledgeImports, knowledgeImportStorageError: value.knowledgeImportStorageError === 'IMPORT_STORAGE_UNAVAILABLE' ? value.knowledgeImportStorageError : '',
            knowledgePublications, knowledgePublishStorageError: value.knowledgePublishStorageError === 'PUBLISH_STORAGE_UNAVAILABLE' ? value.knowledgePublishStorageError : '',
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
