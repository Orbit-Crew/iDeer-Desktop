import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot } from '../src/shared/desktop'

describe('platform chat UI', () => {
  it('shows the exact pending local write in its original streaming Run with one-time decisions', () => {
    const state: ChatSnapshot = { scope: 'identity', resources: [], threads: [], messages: [], events: [],
      thread: { id: 'thread-102', status: 'running', agentId: 'agent', skillId: '' },
      run: { id: 'run-102', status: 'running', selection: {} }, stream: 'streaming', error: '', lastEventId: '',
      localConsents: [{ taskId: 'task-102', runId: 'run-102', threadId: 'thread-102', requestHash: 'a'.repeat(64), path: '/workspace/test/target.txt', content: 'AFTER\n<exact>' }]
    }
    const html = renderToStaticMarkup(<ChatView state={state} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('本机文件写入审批')
    expect(html).toContain('AFTER\n&lt;exact&gt;')
    expect(html).toContain('a'.repeat(64))
    expect(html).toMatch(/<button[^>]*>.*?仅允许这一次/s)
    expect(html).toContain('拒绝写入')
    expect(html).not.toContain('始终允许')
    state.localConsents![0].directory = 'C:\\work\\W1'
    const directoryHtml = renderToStaticMarkup(<ChatView state={state} busy={false} onCommand={async () => {}} />)
    expect(directoryHtml).toContain('始终允许此目录的文本写入')
    expect(directoryHtml).toContain('C:\\work\\W1')
    expect(directoryHtml).toContain('受保护路径和脚本仍受限制')
  })
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
