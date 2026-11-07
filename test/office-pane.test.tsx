// @vitest-environment jsdom
// Issue 112: the office pane is the read-only visualization of the platform's
// Run/subagent events. These tests pin the display contract: exactly the
// platform-reported facts at each station, nothing fabricated when no events
// arrived, an explicit unavailable state when the platform is unreachable,
// and no control surface anywhere — the #95 office exclusion narrows to
// exactly this surface.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import OfficePane, { OfficeView } from '../src/renderer/src/dock/panels/officePane'
import type { ChatSnapshot, ChatSubagent } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const subagent = (over: Partial<ChatSubagent>): ChatSubagent => ({
  taskId: 'call-1', description: '', agent: '', status: 'running', step: null, totalSteps: null,
  model: '', usage: null, result: '', resultTruncated: false, error: '', errorTruncated: false,
  ...over
})

describe('office read-only visualization (#112)', () => {
  it('renders one station per platform-reported sub-agent, exactly the pushed facts', () => {
    render(<OfficeView failed={false} subagents={[
      subagent({ taskId: 'call-1', description: '检索公开资料', agent: 'researcher', status: 'running',
        step: 2, totalSteps: 5, model: 'glm-4.7' }),
      subagent({ taskId: 'call-2', description: '汇总数据', status: 'completed', result: '完成报告' }),
      subagent({ taskId: 'call-3', status: 'failed', error: '子代理崩溃' })
    ]} />)
    const stations = screen.getAllByRole('listitem')
    expect(stations).toHaveLength(3)
    // 平台到达顺序保持：办公室不重排，完工的工位停在原处
    expect(stations[0].getAttribute('aria-label')).toContain('检索公开资料')
    expect(stations[1].getAttribute('aria-label')).toContain('汇总数据')
    expect(screen.getByText('类型：researcher')).toBeTruthy()
    expect(screen.getByText('模型：glm-4.7')).toBeTruthy()
    expect(screen.getByText('步骤：2/5')).toBeTruthy()
    expect(screen.getByLabelText('子代理状态 执行中')).toBeTruthy()
    expect(screen.getByLabelText('子代理状态 已完成')).toBeTruthy()
    expect(screen.getByLabelText('子代理状态 失败')).toBeTruthy()
    expect(screen.getByText('完成报告')).toBeTruthy()
    expect(screen.getByText('子代理崩溃')).toBeTruthy()
  })

  it('falls back when the platform sent no description and marks truncated ends', () => {
    render(<OfficeView failed={false} subagents={[
      subagent({ taskId: 'call-1', description: '', status: 'completed', result: '报告正文', resultTruncated: true }),
      subagent({ taskId: 'call-2', status: 'cancelled', error: '手动停止', errorTruncated: true })
    ]} />)
    // 两个工位都没带描述，各自的兜底文案都在
    expect(screen.getAllByText('（平台未提供描述）')).toHaveLength(2)
    expect(screen.getByText(/报告正文…（已截断，完整结果见会话消息）/)).toBeTruthy()
    expect(screen.getByText(/手动停止…（已截断）/)).toBeTruthy()
  })

  it('renders exactly the five platform states and never invents a sixth', () => {
    render(<OfficeView failed={false} subagents={[
      subagent({ taskId: 'a', status: 'running' }),
      subagent({ taskId: 'b', status: 'completed' }),
      subagent({ taskId: 'c', status: 'failed' }),
      subagent({ taskId: 'd', status: 'cancelled' }),
      subagent({ taskId: 'e', status: 'timed_out' })
    ]} />)
    for (const label of ['执行中', '已完成', '失败', '已取消', '已超时']) {
      expect(screen.getByLabelText(`子代理状态 ${label}`)).toBeTruthy()
    }
    expect(screen.getAllByLabelText(/子代理状态 /)).toHaveLength(5)
  })

  it('fabricates nothing when the platform dispatched no sub-agent', () => {
    render(<OfficeView failed={false} subagents={[]} />)
    expect(screen.getByText('暂无子代理动态')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('shows an explicit unavailable state and no figures when the platform is unreachable', () => {
    render(<OfficeView failed={true} subagents={[]} />)
    expect(screen.getByText('平台未连接，办公室动态不可用')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.queryByText('暂无子代理动态')).toBeNull()
  })

  it('offers no control surface on any figure or station', () => {
    render(<OfficeView failed={false} subagents={[subagent({ description: '检索公开资料', status: 'running' })]} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    const station = screen.getByRole('listitem')
    expect(within(station).queryByRole('button')).toBeNull()
    expect(within(station).queryByRole('textbox')).toBeNull()
  })
})

describe('office pane polling (#112)', () => {
  const snapshotWith = (subagents: ChatSubagent[]): ChatSnapshot => ({
    scope: 'identity', resources: [], threads: [], messages: [], events: [], subagents,
    thread: { id: 'thread-112', status: 'idle', agentId: 'agent-main', skillId: '' },
    run: { id: 'run-112', status: 'running', selection: {} },
    stream: 'streaming', error: '', lastEventId: ''
  })
  const installBridge = (chat: (command: unknown) => Promise<ChatSnapshot>): void => {
    ;(window as unknown as { ideer: unknown }).ideer = { chat }
  }
  const uninstallBridge = (): void => {
    delete (window as unknown as { ideer?: unknown }).ideer
  }

  it('rides only the read-only chat state read and never dispatches', async () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    installBridge(async (command: unknown) => {
      calls.push(command)
      return snapshotWith([subagent({ description: '检索公开资料' })])
    })
    try {
      render(<OfficePane />)
      await vi.advanceTimersByTimeAsync(2500)
      expect(calls.length).toBeGreaterThanOrEqual(3)
      for (const call of calls) expect(call).toEqual({ action: 'state' })
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
    } finally {
      vi.useRealTimers()
      uninstallBridge()
    }
  })

  it('falls to the explicit unavailable state when the read fails, and recovers', async () => {
    vi.useFakeTimers()
    let shouldFail = true
    installBridge(async () => {
      if (shouldFail) throw new Error('RUNTIME_UNAVAILABLE')
      return snapshotWith([])
    })
    try {
      render(<OfficePane />)
      // 三轮失败的读取都落在显式不可用态（多轮推进同时冲刷异步链）
      await vi.advanceTimersByTimeAsync(2500)
      expect(screen.getByText('平台未连接，办公室动态不可用')).toBeTruthy()
      expect(screen.queryByRole('listitem')).toBeNull()
      shouldFail = false
      await vi.advanceTimersByTimeAsync(2500)
      expect(screen.getByText('暂无子代理动态')).toBeTruthy()
    } finally {
      vi.useRealTimers()
      uninstallBridge()
    }
  })
})
