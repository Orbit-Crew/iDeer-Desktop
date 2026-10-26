import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { downloadThreadArtifact } from '../src/main/artifact-download'
import { RuntimeProcess } from '../src/main/runtime'

const CONTENT = Buffer.from('T105-UNIQUE-RESULT')
const SHA = '0e72092273360afa4c59cd372e0a9aee7cb612cf474ccb20048b305e4fbf1274'

describe.skipIf(process.platform !== 'win32')('owner download through the bundled Runtime HTTP and stdio', () => {
  it('saves verified bytes only after native selection and removes content from renderer responses', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer artifact download '))
    let runtime = new RuntimeProcess(resolve('.runtime'), profile)
    const python = resolve('.runtime/python.exe')
    const setup = resolve('test/fixtures/artifact-profile.py')
    const artifact = { artifact_id: 'artifact-1', thread_id: 'thread-1', run_id: 'run-1', task_id: 'task-1', name: 'result.txt', bytes: 18, sha256: SHA }
    const server = createServer((request, response) => {
      let data: unknown = {}
      if (request.url === '/api/v1/auth/me') data = { id: 'artifact-user', email: 'artifact@example.invalid', system_role: 'user', permissions: ['runs:create'] }
      else if (request.url === '/api/devices/artifact-D2') data = { id: 'artifact-D2', owner_id: 'artifact-user', status: 'offline' }
      else if (request.url === '/api/threads/thread-1') data = { thread_id: 'thread-1', status: 'idle', metadata: { agent_name: '' } }
      else if (request.url === '/api/threads/thread-1/runs') data = []
      else if (request.url?.startsWith('/api/threads/thread-1/messages/page')) data = { data: [], has_more: false }
      else if (request.url === '/api/threads/thread-1/state') data = { values: { messages: [] } }
      else if (request.url?.startsWith('/api/threads/thread-1/local-tasks?')) data = { tasks: [], has_more: false, next_offset: null }
      else if (request.url?.startsWith('/api/threads/thread-1/artifacts?')) data = { artifacts: [artifact], has_more: false, next_offset: null }
      else if (request.url === '/api/threads/thread-1/artifacts/artifact-1/download') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': SHA })
        response.end(CONTENT)
        return
      } else { response.writeHead(404); response.end('{}'); return }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(data))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test address')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      execFileSync(python, ['-I', setup, 'prepare', profile], { input: JSON.stringify({ origin }), windowsHide: true })
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().login?.state).toBe('authenticated'), { timeout: 15000 })
      expect(runtime.serverOrigin()).toBe(origin)
      await runtime.stop()
      expect(runtime.serverOrigin()).toBe('')
      runtime = new RuntimeProcess(resolve('.runtime'), profile)
      await runtime.start()
      await vi.waitFor(() => expect(runtime.status().login?.state).toBe('authenticated'), { timeout: 15000 })
      expect(runtime.serverOrigin()).toBe(origin)
      const state = await runtime.chat({ action: 'state' })
      const opened = await runtime.chat({ action: 'open', scope: state.scope, threadId: 'thread-1' })
      expect(opened.error).toBe('')
      expect(opened.artifacts).toEqual([artifact])
      const destination = join(profile, 'saved.txt')
      const command = { action: 'download', scope: state.scope, threadId: 'thread-1', artifactId: 'artifact-1' } as const
      const result = await downloadThreadArtifact(runtime, command, async (name) => {
        expect(name).toBe('result.txt')
        expect(existsSync(destination)).toBe(false)
        return destination
      })
      expect(result.error).toBe('')
      expect(result.downloadStatus).toBe('saved')
      expect(readFileSync(destination)).toEqual(CONTENT)
      expect(result).not.toHaveProperty('download')
      expect(JSON.stringify(result)).not.toContain(destination)
      const cancelled = await downloadThreadArtifact(runtime, command, async () => undefined)
      expect(cancelled.downloadStatus).toBe('cancelled')
      expect(cancelled).not.toHaveProperty('download')
      const staleDestination = join(profile, 'must-not-save.txt')
      await expect(downloadThreadArtifact(runtime, command, async () => {
        await runtime.manage('switch-account')
        return staleDestination
      })).rejects.toThrow('DOWNLOAD_IDENTITY_CHANGED')
      expect(existsSync(staleDestination)).toBe(false)
    } finally {
      await runtime.stop()
      execFileSync(python, ['-I', setup, 'cleanup', profile], { windowsHide: true })
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
      rmSync(profile, { recursive: true, force: true })
    }
  }, 45000)
})
