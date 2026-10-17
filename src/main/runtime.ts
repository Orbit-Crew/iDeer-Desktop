import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeStatus, RuntimeTask } from '../shared/desktop'

/** Owns one fixed, bundled executable. No renderer-supplied paths or commands. */
export class RuntimeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private snapshot: RuntimeStatus = { process: 'stopped', connection: 'offline', tasks: [] }
  private stopping: Promise<void> | null = null
  constructor(private readonly directory: string, private readonly profile: string) {}

  status(): RuntimeStatus {
    return structuredClone(this.snapshot)
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
    const child = spawn(executable, ['-I', '-u', '-m', 'core.desktop', '--config', join(this.profile, 'settings.json')], {
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
      if (buffer.length > 65536) { child.kill(); return }
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        try {
          const value = JSON.parse(line)
          const connections = ['not-configured', 'connecting', 'connected', 'paused', 'offline', 'error']
          if (value.v !== 1 || !connections.includes(value.connection) || !Array.isArray(value.tasks)) throw new Error('Invalid status')
          const tasks: RuntimeTask[] = value.tasks.slice(0, 20).map((task: RuntimeTask) => {
            if (['taskId', 'runId', 'capability', 'state'].some((key) => typeof task[key as keyof RuntimeTask] !== 'string' || task[key as keyof RuntimeTask].length > 256)) throw new Error('Invalid task status')
            return { taskId: task.taskId, runId: task.runId, capability: task.capability, state: task.state }
          })
          lastStatus = Date.now()
          if (!this.stopping) this.snapshot = { process: 'running', connection: value.connection, tasks, pid: child.pid }
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
