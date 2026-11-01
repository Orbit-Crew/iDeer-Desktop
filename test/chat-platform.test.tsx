import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot } from '../src/shared/desktop'

const baseState = (overrides: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [],
  thread: { id: 'thread-80', status: 'idle', agentId: 'agent-80', skillId: '' },
  run: null, stream: 'idle', error: '', lastEventId: '',
  // The fixture carries the same snapshot shape the main process projects.
  subagents: [], ...overrides
})

describe('platform reachability display (#80)', () => {
  it('shows the explicit pause with its reason and blocks the composer while unreachable', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      platform: { reachable: false, detail: 'CHAT_SERVER_UNAVAILABLE' }
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('平台不可达：已暂停发起新任务')
    expect(html).toContain('CHAT_SERVER_UNAVAILABLE')
    expect(html).toContain('在途 Run 结果待核实，不会自动重派或重发')
    expect(html).toContain('恢复连接后会自动重连并补传执行记录')
    expect(html).toContain('平台不可达，已暂停发送')
    expect(html).toMatch(/aria-label="聊天消息"[^>]*disabled/)
  })

  it('marks an in-flight run result unknown and announces the automatic recovery while disconnected', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      stream: 'disconnected', run: { id: 'run-1', status: 'running', selection: {} },
      platform: { reachable: true, detail: '' }
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('在途 Run 结果待核实')
    expect(html).toContain('自动重连并补传执行记录')
    expect(html).not.toContain('平台不可达：已暂停发起新任务')
  })

  it('marks an unresolved submission result unknown while the platform answers again', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      stream: 'uncertain', platform: { reachable: true, detail: '' }
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('结果待核实')
    expect(html).not.toContain('已暂停发起新任务')
  })

  it('shows no reachability banner on an ordinary reachable session', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState()} busy={false} onCommand={async () => {}} />)
    expect(html).not.toContain('平台不可达')
    expect(html).not.toContain('结果待核实')
    expect(html).not.toMatch(/aria-label="聊天消息"[^>]*disabled/)
  })
})
