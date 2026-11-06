import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

const fullDraft = {
  title: '周报', prompt: '汇总本周进展', scheduleType: 'cron' as const,
  scheduleSpec: { cron: '0 9 * * MON' }, timezone: 'Asia/Shanghai',
  assistantId: 'my_agent', contextMode: 'fresh_thread_per_run' as const, threadId: ''
}

describe('schedules bridge contract (#85)', () => {
  it('accepts only the exact per-action shapes before any Runtime starts', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-85/unused')
    const ok = { ...fullDraft }
    const cases: unknown[] = [
      null,
      { action: 'archive' },
      { action: 'list', taskId: 'extra' },
      { action: 'get' },
      { action: 'get', taskId: 'bad id!' },
      { action: 'pause', taskId: 'x'.repeat(129) },
      { action: 'create', task: 'nope' },
      { action: 'create', task: { ...ok, extra: 1 } },
      { action: 'create', task: { ...ok, title: '   ' } },
      { action: 'create', task: { ...ok, prompt: '' } },
      { action: 'create', task: { ...ok, scheduleType: 'yearly' } },
      { action: 'create', task: { ...ok, scheduleType: 'cron', scheduleSpec: { everySeconds: 60 } } },
      { action: 'create', task: { ...ok, scheduleType: 'interval', scheduleSpec: { everySeconds: 30 } } },
      { action: 'create', task: { ...ok, scheduleType: 'once', scheduleSpec: { runAt: 'no-timezone' } } },
      { action: 'create', task: { ...ok, timezone: 'Not/AZone!' } },
      { action: 'create', task: { ...ok, contextMode: 'reuse_thread', threadId: '' } },
      { action: 'create', task: { ...ok, contextMode: 'reuse_thread', threadId: 'bad id!' } },
      { action: 'create', task: { ...ok, assistantId: 'bad name!' } },
      { action: 'update', taskId: 'task-a' },
      { action: 'update', taskId: 'task-a', task: {} },
      { action: 'update', taskId: 'task-a', task: { scheduleType: 'once' } },
      { action: 'update', taskId: 'task-a', task: { scheduleSpec: { cron: '0 9 * * *' } } },
      { action: 'runs', taskId: 'task-a' },
      { action: 'runs', taskId: 'task-a', limit: 0, offset: 0 },
      { action: 'runs', taskId: 'task-a', limit: 201, offset: 0 },
      { action: 'runs', taskId: 'task-a', limit: 50, offset: -1 },
      { action: 'runs', taskId: 'task-a', limit: 1.5, offset: 0 },
      { action: 'set-skip', taskId: 'task-a', skipOnMissed: 'yes' },
      { action: 'preview', cron: '', timezone: 'UTC', count: 3 },
      { action: 'preview', cron: '0 9 * * *', timezone: 'UTC x', count: 3 },
      { action: 'preview', cron: '0 9 * * *', timezone: 'UTC', count: 0 },
      { action: 'preview', cron: '0 9 * * *', timezone: 'UTC', count: 11 },
      { action: 'preview', cron: '0 9 * * *', timezone: 'UTC' }
    ]
    for (const command of cases) {
      await expect(runtime.schedules(JSON.parse(JSON.stringify(command)) as never)).rejects.toThrow('SCHEDULES_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('rejects through the actual bundled Runtime with the fixed unauthenticated category', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-schedules-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await expect(runtime.schedules({ action: 'list' })).rejects.toThrow('SCHEDULES_UNAUTHENTICATED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})
