// @vitest-environment jsdom
// Issue 111: the Agent-controlled terminal pane. These tests pin the display
// contract: exactly the Runtime-recorded commands with their honest end
// states, an explicit unavailable state when the Runtime is down, an
// explicit empty state when nothing ran, no input surface anywhere, and the
// merge rule that keeps live snapshot tails fresher than the history read.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AgentTerminalViewComponent } from '../src/renderer/src/dock/panels/agentTerminalPane'
import { AgentTerminalController, emptyAgentTerminalView } from '../src/renderer/src/stores/agentTerminal'
import type { AgentTerminalEntryView, DesktopStatus } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const entry = (over: Partial<AgentTerminalEntryView>): AgentTerminalEntryView => ({
  threadId: 'thread-1', runId: 'run-1', taskId: 'task-1', toolCallId: 'call-1',
  command: 'echo hello', workingRoot: '/workspace/11111111-1111-1111-1111-111111111111',
  status: 'completed', exitCode: 0, stdoutTail: 'hello', stderrTail: '',
  stdoutHash: 'a'.repeat(64), stderrHash: '', effectsUncertain: false,
  authorizationBasis: 'consent:allow_once', startedAt: '2026-11-08T10:00:00+00:00',
  finishedAt: '2026-11-08T10:00:01+00:00',
  ...over
})

const status = (over: Partial<DesktopStatus['runtime']>): DesktopStatus =>
  ({ server: 'offline', runtime: { process: 'running', connection: 'offline', tasks: [], ...over } } as DesktopStatus)

describe('agent terminal read-only projection (#111)', () => {
  it('renders every recorded command with its honest end state and effects marker', () => {
    render(<AgentTerminalViewComponent view={{
      status: status({}),
      commands: [
        entry({ taskId: 't-1', command: 'pytest -q', status: 'completed' }),
        entry({ taskId: 't-2', command: 'make build', status: 'cancelled', exitCode: null, effectsUncertain: true }),
        entry({ taskId: 't-3', command: 'npm ci', status: 'failed', exitCode: 3 }),
        entry({ taskId: 't-4', command: 'rm bad', status: 'refused', authorizationBasis: 'policy' })
      ],
      failed: false
    }} stopping={false} onStop={() => {}} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    // 最新命令在上方：历史不重排事实，只倒序展示
    expect(rows[0].getAttribute('aria-label')).toContain('rm bad')
    expect(rows[3].getAttribute('aria-label')).toContain('pytest -q')
    expect(screen.getByLabelText('状态 已完成')).toBeTruthy()
    expect(screen.getByLabelText('状态 已停止')).toBeTruthy()
    expect(screen.getByLabelText('状态 已失败')).toBeTruthy()
    expect(screen.getByLabelText('状态 已拒绝')).toBeTruthy()
    expect(screen.getByLabelText('退出码')).toBeTruthy()
    expect(screen.getByText('退出码 3')).toBeTruthy()
    expect(screen.getAllByLabelText('效果待核实')).toHaveLength(1)
    expect(screen.getAllByText('hello').length).toBe(4)
    // 授权途径如实呈现：逐条询问通过/策略拒绝
    expect(screen.getAllByText(/逐条询问通过/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/策略拒绝/)).toBeTruthy()
  })

  it('shows the stop affordance only for running commands and never an input box', () => {
    render(<AgentTerminalViewComponent view={{
      status: status({ agentTerminal: { running: [entry({ taskId: 't-live', status: 'running', finishedAt: null })] } }),
      commands: [entry({ taskId: 't-done', status: 'completed' }),
        entry({ taskId: 't-live', status: 'running', finishedAt: null })],
      failed: false
    }} stopping={false} onStop={() => {}} />)
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('正在运行 1 条命令')).toBeTruthy()
  })

  it('renders the explicit unavailable, error and empty states instead of fabricating activity', () => {
    const { rerender } = render(<AgentTerminalViewComponent
      view={{ status: status({ process: 'stopped' }), commands: [], failed: false }}
      stopping={false} onStop={() => {}} />)
    expect(screen.getByText('本机 Runtime 未运行')).toBeTruthy()
    rerender(<AgentTerminalViewComponent
      view={{ status: status({ agentTerminalStorageError: 'TERMINAL_STORAGE_UNAVAILABLE' }), commands: [], failed: false }}
      stopping={false} onStop={() => {}} />)
    expect(screen.getByText('终端历史存储不可读')).toBeTruthy()
    rerender(<AgentTerminalViewComponent
      view={{ status: status({}), commands: [], failed: true }}
      stopping={false} onStop={() => {}} />)
    expect(screen.getByText('读取失败')).toBeTruthy()
    rerender(<AgentTerminalViewComponent
      view={{ status: status({}), commands: [], failed: false }}
      stopping={false} onStop={() => {}} />)
    expect(screen.getByText('本账户在本机还没有受控终端命令记录')).toBeTruthy()
  })

  it('renders untrusted output as escaped text, never as a terminal emulator surface', () => {
    render(<AgentTerminalViewComponent view={{
      status: status({}),
      commands: [entry({ stdoutTail: '<script>alert(1)</script>\nANSI\x1b[31mred', stderrTail: '' })],
      failed: false
    }} stopping={false} onStop={() => {}} />)
    const stdout = screen.getByLabelText('标准输出')
    // 原样呈现（转义后的文本节点），不解释任何转义序列
    expect(stdout.textContent).toContain('<script>alert(1)</script>')
    expect(stdout.textContent).toContain('ANSI\x1b[31mred')
    expect(stdout.tagName).toBe('PRE')
  })
})

describe('agent terminal controller merge rule (#111)', () => {
  it('overlays snapshot running tails onto the history read by task id', async () => {
    const getStatus = vi.fn(async () => status({
      agentTerminal: { running: [entry({ taskId: 't-live', status: 'running', stdoutTail: 'live tail', finishedAt: null })] }
    }))
    const terminalHistory = vi.fn(async () => ({
      commands: [entry({ taskId: 't-done' }), entry({ taskId: 't-live', status: 'running', stdoutTail: 'stale tail', finishedAt: null })],
      storageError: ''
    }))
    const terminalStop = vi.fn(async () => ({ requested: true }))
    const controller = new AgentTerminalController(
      { getStatus, terminalHistory, terminalStop } as never, () => {})
    await controller.refresh()
    const view = controller.snapshot()
    expect(view.commands).toHaveLength(2)
    const live = view.commands.find((row) => row.taskId === 't-live')
    expect(live?.stdoutTail).toBe('live tail')
    expect(live?.finishedAt).toBeNull()
    expect(emptyAgentTerminalView().commands).toEqual([])
  })

  it('keeps the honest unavailable state when the runtime is stopped and stops a run by id', async () => {
    const getStatus = vi.fn(async () => status({ process: 'stopped' }))
    const terminalHistory = vi.fn(async () => ({ commands: [], storageError: '' }))
    const terminalStop = vi.fn(async () => ({ requested: true }))
    const published: ReturnType<typeof emptyAgentTerminalView>[] = []
    const controller = new AgentTerminalController(
      { getStatus, terminalHistory, terminalStop } as never,
      (view) => published.push(view))
    await controller.refresh()
    expect(controller.snapshot().commands).toEqual([])
    expect(controller.snapshot().status?.runtime.process).toBe('stopped')
    // 停止是请求：回执只说已请求，随后刷新记录真实状态
    expect(terminalHistory).not.toHaveBeenCalled()
    await controller.stop('run-1')
    expect(terminalStop).toHaveBeenCalledWith('run-1')
    expect(published.length).toBeGreaterThanOrEqual(2)
  })
})
