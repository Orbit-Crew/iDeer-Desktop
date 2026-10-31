import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot } from '../src/shared/desktop'

const baseState = (overrides: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [],
  thread: { id: 'thread-73', status: 'idle', agentId: 'agent-73', skillId: '' },
  run: null, stream: 'idle', error: '', lastEventId: '', ...overrides
})

describe('chat model facts (#73)', () => {
  it('shows the resolved session model and offers the temporary switch', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      model: { name: 'model-beta', source: 'session-override', available: true, reason: '', notice: '', switchedFrom: '' },
      modelOptions: [{ name: 'model-alpha', displayName: 'Alpha', description: '', supportsThinking: false },
        { name: 'model-beta', displayName: 'Beta', description: '', supportsThinking: false }]
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('本会话模型：model-beta · 本会话临时选择')
    // The override renders as the selector's selection; the account default
    // state below keeps the platform-default placeholder visible.
    expect(html).toContain('Beta')
  })

  it('keeps the platform-default placeholder for a session without an override', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      model: { name: 'model-alpha', source: 'account-default', available: true, reason: '', notice: '', switchedFrom: '' },
      modelOptions: [{ name: 'model-alpha', displayName: 'Alpha', description: '', supportsThinking: false }]
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('本会话模型：model-alpha · 账号默认')
    expect(html).toContain('平台默认模型')
    expect(html).not.toContain('发送已暂停')
  })

  it('pauses sending with an explicit notice while the chosen model is unavailable', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      model: { name: 'model-alpha', source: 'session-override', available: false, reason: 'CHAT_MODEL_UNAVAILABLE', notice: '', switchedFrom: '' }
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('模型 model-alpha 已不可用，发送已暂停')
    expect(html).toContain('不会静默切换')
  })

  it('displays the fallback switch story for the whole session', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState({
      model: { name: 'model-beta', source: 'session-override', available: true, reason: '',
        notice: '主模型 model-alpha 调用失败，已按备用设置切换到 model-beta 重试。', switchedFrom: 'model-alpha' }
    })} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('已按备用设置切换到 model-beta 重试')
  })

  it('keeps sending available when no model facts are loaded yet', () => {
    const html = renderToStaticMarkup(<ChatView state={baseState()} busy={false} onCommand={async () => {}} />)
    expect(html).not.toContain('发送已暂停')
  })
})
