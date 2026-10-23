import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatCommand, ChatSnapshot, LoginStatus, RuntimeStatus, RuntimeTask, ReceiptHistory } from '../shared/desktop'

/** Owns one fixed, bundled executable. No renderer-supplied paths or commands. */
export class RuntimeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private snapshot: RuntimeStatus = { process: 'stopped', connection: 'offline', tasks: [] }
  private selectionScope = ''
  workspaceScope(): string { return this.selectionScope }
  private workspaceRequest: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null
  private stopping: Promise<void> | null = null
  private loginRequest: { origin: string; resolve: (url: string) => void; reject: (error: Error) => void } | null = null
  private chatRequests = new Map<string, { resolve: (state: ChatSnapshot) => void; reject: (error: Error) => void }>()
  private receiptRequests = new Map<string, { resolve: (state: ReceiptHistory) => void; reject: (error: Error) => void }>()
  private receiptScope = ''
  receiptOwnershipScope(): string { return this.receiptScope }
  constructor(private readonly directory: string, private readonly profile: string) {}

  status(): RuntimeStatus {
    return structuredClone(this.snapshot)
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

  async chat(command: ChatCommand): Promise<ChatSnapshot> {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('CHAT_COMMAND_INVALID')
    const keys: Record<string, string[]> = {
      state: ['action'], refresh: ['action'], create: ['action', 'scope', 'agentId', 'skillId'],
      open: ['action', 'scope', 'threadId'], reconnect: ['action', 'scope', 'threadId'],
      send: ['action', 'scope', 'threadId', 'turnId', 'text'],
      answer: ['action', 'scope', 'threadId', 'turnId', 'requestId', 'text', 'optionId'],
      consent: ['action', 'scope', 'threadId', 'runId', 'taskId', 'requestHash', 'decision']
    }
    const allowed = keys[command.action]
    if (command.action === 'consent' && (Object.keys(command).length !== 7 || !['allow', 'deny'].includes(command.decision) || !/^[0-9a-f]{64}$/.test(command.requestHash))) throw new Error('CHAT_COMMAND_INVALID')
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
    const child = spawn(executable, ['-I', '-u', '-X', 'utf8', '-m', 'core.desktop', '--config', join(this.profile, 'settings.json')], {
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
          if (value.v === 1 && value.type === 'receipts') {
            if (value.error) this.receiptRequests.get(value.id)?.reject(new Error(value.error === 'RECEIPT_BINDING_CHANGED' ? value.error : 'RECEIPT_STORAGE_UNAVAILABLE'))
            else if (value.result && Array.isArray(value.result.rows) && value.result.rows.length <= 20 &&
                ['total', 'pending', 'confirmed', 'uncertain', 'cleaned'].every((key) => Number.isSafeInteger(value.result[key]) && value.result[key] >= 0) &&
                typeof value.result.storageError === 'string') this.receiptRequests.get(value.id)?.resolve(value.result)
            else throw new Error('Invalid receipt response')
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
          this.receiptScope = typeof value.receiptScope === 'string' && /^[0-9a-f]{64}$/.test(value.receiptScope) ? value.receiptScope : ''
          lastStatus = Date.now()
          if (!this.stopping) this.snapshot = { process: 'running', connection: value.connection, tasks, pid: child.pid, login, workspace: value.workspace,
            receiptStorageError: value.receiptStorageError === 'RECEIPT_STORAGE_UNAVAILABLE' ? value.receiptStorageError : '', receiptScope: this.receiptScope }
        } catch { child.kill() }
      }
    })
    // Drain diagnostics without exposing possible credential-bearing exceptions.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', () => {
      this.snapshot = { process: 'crashed', connection: 'offline', tasks: [] }
    })
    child.on('close', () => {
      this.workspaceRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      this.loginRequest?.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.chatRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
      for (const pending of this.receiptRequests.values()) pending.reject(new Error('RUNTIME_UNAVAILABLE'))
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
