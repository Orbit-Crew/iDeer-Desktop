// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot, LocalConsentView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const snapshotWith = (consents: LocalConsentView[]): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [],
  thread: { id: 'thread-A', status: 'running', agentId: 'agent', skillId: '' },
  run: { id: 'run-1', status: 'running', selection: {} }, stream: 'streaming', error: '', lastEventId: '',
  localConsents: consents
})

const scriptConsent: LocalConsentView = {
  taskId: 'task-122', runId: 'run-1', threadId: 'thread-A', requestHash: 'b'.repeat(64), kind: 'skill-script',
  skill: 'report-skill', scriptPath: 'scripts/analyze.py', version: '3',
  scriptSha256: 'c'.repeat(64), requirementsSha256: 'd'.repeat(64)
}

const materialConsent: LocalConsentView = {
  taskId: 'task-116', runId: 'run-1', threadId: 'thread-A', requestHash: 'e'.repeat(64), kind: 'knowledge-material',
  revisionId: 'rev-1', manifestHash: 'f'.repeat(64),
  documents: [{ filename: 'guide.md', contentHash: 'a'.repeat(64) }]
}

describe('Desktop chat settles every device authority (#39)', () => {
  it('renders the script ask with scope facts and rides rememberScript on one allow', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    render(<ChatView state={snapshotWith([scriptConsent])} busy={false} onCommand={onCommand} />)
    expect(screen.getByText('本机技能脚本审批')).toBeTruthy()
    expect(screen.getByText(/report-skill/)).toBeTruthy()
    expect(screen.getByText(/scripts\/analyze\.py/)).toBeTruthy()
    expect(screen.getByText(/脚本 SHA-256：/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('记住脚本授权 scripts/analyze.py'))
    fireEvent.click(screen.getByText('允许执行'))
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'consent', taskId: 'task-122', requestHash: 'b'.repeat(64), decision: 'allow', rememberScript: true
    })))
  })

  it('does not send rememberScript when the owner did not ask to remember', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    render(<ChatView state={snapshotWith([scriptConsent])} busy={false} onCommand={onCommand} />)
    fireEvent.click(screen.getByText('允许执行'))
    await vi.waitFor(() => {
      const command = onCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>
      expect(command.decision).toBe('allow')
      expect(command.rememberScript).toBeUndefined()
    })
  })

  it('renders the material ask with its frozen documents and plain allow/deny only', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    render(<ChatView state={snapshotWith([materialConsent])} busy={false} onCommand={onCommand} />)
    expect(screen.getByText('本机知识取材审批')).toBeTruthy()
    expect(screen.getByText(/guide\.md · 文档指纹/)).toBeTruthy()
    expect(screen.queryByText('记住脚本授权 guide.md')).toBeNull()
    fireEvent.click(screen.getByText('允许读取'))
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'consent', taskId: 'task-116', decision: 'allow'
    })))
    const command = onCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(command.rememberScript).toBeUndefined()
  })

  it('keeps the file-write card on its original one-time and directory decisions', () => {
    const state = snapshotWith([{
      taskId: 'task-102', runId: 'run-1', threadId: 'thread-A', requestHash: 'a'.repeat(64), kind: 'file-write',
      path: '/workspace/test/target.txt', content: 'AFTER\n', directory: '/workspace/test'
    }])
    const html = render(<ChatView state={state} busy={false} onCommand={async () => {}} />)
    expect(screen.getByText('本机文件写入审批')).toBeTruthy()
    expect(screen.getByText('仅允许这一次')).toBeTruthy()
    expect(screen.getByText('始终允许此目录的文本写入')).toBeTruthy()
    expect(html.container.textContent).toContain('AFTER')
  })
})
