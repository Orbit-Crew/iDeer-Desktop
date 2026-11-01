// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatCommand, ChatSnapshot } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const stateWith = (overrides: Partial<ChatSnapshot>): ChatSnapshot => ({
  scope: 'scope-1',
  resources: [],
  threads: [{ id: 'thread-1', title: '结构计算助手', status: 'idle' }],
  thread: { id: 'thread-1', status: 'idle', agentId: 'agent-1', skillId: '' },
  messages: [
    { id: 'human-id-1', role: 'human', text: '请核对', name: '' },
    { id: 'ai-id-1', role: 'ai', text: '结论：成立。', name: '' },
    { id: 'tool-id-1', role: 'tool', text: '站点返回 200', name: 'web_search' }
  ],
  events: [], stream: 'idle', error: '', lastEventId: '',
  ...overrides
})

describe('chat export surface (#79)', () => {
  it('offers the whole-session export and emits the export command', async () => {
    const onCommand = vi.fn(async () => {})
    const view = render(<ChatView state={stateWith({})} busy={false} onCommand={onCommand} />)
    fireEvent.click(view.getByRole('button', { name: '导出整会话 Markdown' }))
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      action: 'export', mode: 'session', scope: 'scope-1', threadId: 'thread-1'
    }))
  })

  it('exports a single reply from its card and never from other roles', async () => {
    const onCommand = vi.fn(async () => {})
    const view = render(<ChatView state={stateWith({})} busy={false} onCommand={onCommand} />)
    const buttons = view.getAllByRole('button', { name: '导出本条回复' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      action: 'export', mode: 'message', scope: 'scope-1', threadId: 'thread-1', messageId: 'ai-id-1'
    }))
  })

  it('disables the session export without messages', () => {
    const view = render(<ChatView state={stateWith({ messages: [] })} busy={false}
      onCommand={vi.fn(async () => {})} />)
    expect((view.getByRole('button', { name: '导出整会话 Markdown' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports the export outcome from the snapshot only', () => {
    const saved = render(<ChatView state={stateWith({ exportStatus: 'saved' })} busy={false}
      onCommand={vi.fn(async () => {})} />)
    expect(saved.getByText('会话导出已保存到本机。')).toBeTruthy()
    saved.unmount()
    const cancelled = render(<ChatView state={stateWith({ exportStatus: 'cancelled' })} busy={false}
      onCommand={vi.fn(async () => {})} />)
    expect(cancelled.getByText('已取消导出。')).toBeTruthy()
    cancelled.unmount()
    const failed = render(<ChatView state={stateWith({ exportStatus: 'failed', exportError: 'CHAT_EXPORT_SAVE_FAILED' })}
      busy={false} onCommand={vi.fn(async () => {})} />)
    expect(failed.getByText('导出未完成：写入本机文件失败，请重试或更换保存位置。')).toBeTruthy()
    // A local save failure never presents as the generic outage message.
    expect(failed.queryByText('Runtime 或 Server 不可用，请检查连接后恢复状态；旧提交不会自动重发')).toBeNull()
    failed.unmount()
    const silent = render(<ChatView state={stateWith()} busy={false} onCommand={vi.fn(async () => {})} />)
    expect(silent.queryByText('会话导出已保存到本机。')).toBeNull()
  })
})
