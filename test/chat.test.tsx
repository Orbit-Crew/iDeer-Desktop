import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot } from '../src/shared/desktop'

describe('platform chat UI', () => {
  it('shows canonical versions, history, server run state and an answerable clarification', () => {
    const state: ChatSnapshot = {
      scope: 'identity-A', resources: [{ id: 'agent-99', type: 'agent', name: 'Expert 99', visibility: 'private', version: 3, available: true, reason: '' }],
      threads: [{ id: 'thread-99', title: 'Recovered thread', status: 'interrupted' }],
      thread: { id: 'thread-99', agentId: 'agent-99', skillId: '', status: 'interrupted' },
      messages: [{ id: 'a1', role: 'ai', name: '', text: 'Server response' },
        { id: 't1', role: 'tool', name: 'ask_clarification', text: '', request: {
          version: 1, kind: 'human_input_request', source: 'ask_clarification', request_id: 'question-99',
          question: 'Select target', input_mode: 'single_choice', options: [{ id: 'one', label: 'Target one', value: 'one' }]
        } }],
      run: { id: 'run-99', status: 'interrupted', selection: {} }, events: [], stream: 'disconnected',
      error: 'CHAT_STREAM_DISCONNECTED', lastEventId: 'event-99'
    }
    const html = renderToStaticMarkup(<ChatView state={state} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('Expert 99')
    expect(html).toContain('private · v3')
    expect(html).toContain('Recovered thread')
    expect(html).toContain('Server response')
    expect(html).toContain('run-99')
    expect(html).toContain('Select target')
    expect(html).toContain('Target one')
    expect(html).toContain('重新连接并恢复状态')
    expect(html).toContain('不会自动重发')
  })
})
