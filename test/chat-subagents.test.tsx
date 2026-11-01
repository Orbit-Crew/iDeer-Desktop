// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
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

const stateWith = (subagents: ChatSubagent[]): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [], subagents,
  thread: { id: 'thread-76', status: 'idle', agentId: 'agent-main', skillId: '' },
  run: { id: 'run-76', status: 'running', selection: {} },
  stream: 'streaming', error: '', lastEventId: ''
})

describe('parallel sub-agent progress (#76)', () => {
  it('renders exactly the platform-reported facts for each sub-agent', () => {
    render(<ChatView state={stateWith([
      subagent({ taskId: 'call-1', description: '检索公开资料', agent: 'researcher', status: 'running',
        step: 2, totalSteps: 5, model: 'glm-4.7', usage: { inputTokens: 300, outputTokens: 90, totalTokens: 390 } }),
      subagent({ taskId: 'call-2', description: '汇总数据', status: 'completed', result: '完成报告' }),
      subagent({ taskId: 'call-3', status: 'failed', error: '子代理崩溃' })
    ])} busy={false} onCommand={async (_command: ChatCommand) => {}} />)
    expect(screen.getByText('并行子代理进度')).toBeTruthy()
    expect(screen.getByText('检索公开资料')).toBeTruthy()
    expect(screen.getByText('汇总数据')).toBeTruthy()
    expect(screen.getByLabelText('子代理状态 执行中')).toBeTruthy()
    expect(screen.getByLabelText('子代理状态 已完成')).toBeTruthy()
    expect(screen.getByLabelText('子代理状态 失败')).toBeTruthy()
    expect(screen.getByText('类型：researcher')).toBeTruthy()
    expect(screen.getByText('模型：glm-4.7')).toBeTruthy()
    expect(screen.getByText('步骤：2/5')).toBeTruthy()
    expect(screen.getByText('Token：300 入 / 90 出 / 390 合计')).toBeTruthy()
    expect(screen.getByText('完成报告')).toBeTruthy()
    expect(screen.getByText('子代理崩溃')).toBeTruthy()
  })

  it('marks truncated results and falls back when the platform sent no description', () => {
    render(<ChatView state={stateWith([
      subagent({ taskId: 'call-1', status: 'completed', result: '报告正文', resultTruncated: true })
    ])} busy={false} onCommand={async () => {}} />)
    expect(screen.getByText('（平台未提供描述）')).toBeTruthy()
    expect(screen.getByText(/报告正文…（已截断，完整结果见会话消息）/)).toBeTruthy()
  })

  it('keeps the platform arrival order, running tasks first', () => {
    render(<ChatView state={stateWith([
      subagent({ taskId: 'call-2', description: '先完成', status: 'completed' }),
      subagent({ taskId: 'call-1', description: '仍在执行', status: 'running' })
    ])} busy={false} onCommand={async () => {}} />)
    const cards = screen.getAllByText(/先完成|仍在执行/)
    expect(cards[0].textContent).toBe('仍在执行')
    expect(cards[1].textContent).toBe('先完成')
  })

  it('renders no progress surface when the platform dispatched no sub-agent', () => {
    render(<ChatView state={stateWith([])} busy={false} onCommand={async () => {}} />)
    expect(screen.queryByText('并行子代理进度')).toBeNull()
  })

  it('offers no team management controls and no local dispatch surface', () => {
    render(<ChatView state={stateWith([subagent({ taskId: 'call-1', description: '检索公开资料' })])}
      busy={false} onCommand={async () => {}} />)
    // 团队组成由主 Agent 配置决定: the progress surface is display-only —
    // no add/remove/configure controls, no local orchestration entry.
    expect(screen.queryByText(/团队管理/)).toBeNull()
    expect(screen.queryByRole('button', { name: /添加|移除|配置团队|本地派发/ })).toBeNull()
  })
})
