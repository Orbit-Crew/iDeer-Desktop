// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

const stateWith = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'identity',
  resources: [
    { id: 'agent-main', type: 'agent', name: 'Main', visibility: 'private', version: 1, available: true, reason: '' },
    { id: 'agent-expert', type: 'agent', name: 'Expert', visibility: 'public', version: 2, available: true, reason: '' },
    { id: 'agent-ghost', type: 'agent', name: 'Ghost', visibility: 'public', version: 1, available: false, reason: '不可用' },
    { id: 'skill-tec', type: 'skill', name: 'Tecplot', visibility: 'public', version: 3, available: true, reason: '' },
    { id: 'skill-cad', type: 'skill', name: 'CAD', visibility: 'public', version: 1, available: true, reason: '' }
  ],
  threads: [], messages: [], events: [],
  thread: { id: 'thread-75', status: 'idle', agentId: 'agent-main', skillId: '' },
  stream: 'idle', error: '', lastEventId: '',
  ...over
})

const setup = () => {
  const commands: ChatCommand[] = []
  render(<ChatView state={stateWith()} busy={false} onCommand={async (command) => { commands.push(command) }} />)
  return { commands, textarea: screen.getByLabelText('聊天消息') as HTMLTextAreaElement }
}

const pickOption = (listboxLabel: string, name: string): void => {
  const listbox = screen.getByRole('listbox', { name: listboxLabel })
  fireEvent.mouseDown(within(listbox).getByRole('option', { name: new RegExp(name) }))
}

describe('composer input commands (#75)', () => {
  it('at-mentions a delegate for one message and keeps the session on the same thread', async () => {
    const { commands, textarea } = setup()
    fireEvent.change(textarea, { target: { value: '@' } })
    // Unavailable resources are never offered for delegation.
    const agentOptions = within(screen.getByRole('listbox', { name: '@ Agent 候选' })).queryAllByRole('option')
    expect(agentOptions.map((option) => option.textContent).join()).not.toContain('Ghost')
    expect(agentOptions).toHaveLength(2)
    pickOption('@ Agent 候选', 'Expert')
    expect(textarea.value).toBe('@Expert ')
    expect(screen.getByLabelText('已委派 Expert')).toBeTruthy()
    fireEvent.change(textarea, { target: { value: '@Expert 帮我看看结果' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    // Delegation rides the send in the SAME session; no create is issued and
    // the main Agent's thread is untouched.
    expect(commands[0]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-75',
      turnId: expect.any(String), text: '@Expert 帮我看看结果', delegateAgentId: 'agent-expert' })
    // The per-message delegation clears with the message.
    expect(screen.queryByLabelText('已委派 Expert')).toBeNull()
  })

  it('mounts multiple skills through the slash picker in pick order', async () => {
    const { commands, textarea } = setup()
    fireEvent.change(textarea, { target: { value: '跑一次 /' } })
    pickOption('/ Skill 候选', 'Tecplot')
    // The slash token is consumed into the chip; the message text stays clean.
    expect(textarea.value).toBe('跑一次 ')
    expect(screen.getByLabelText('已挂载 Tecplot').textContent).toContain('必用：Tecplot')
    fireEvent.change(textarea, { target: { value: '跑一次 /' } })
    pickOption('/ Skill 候选', 'CAD')
    expect(screen.getByLabelText('已挂载 CAD').textContent).toContain('挂载：CAD')
    fireEvent.change(textarea, { target: { value: '跑一次' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    // First chip first: the explicit seam maps onto it; the rest stay mounted.
    expect(commands[0]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-75',
      turnId: expect.any(String), text: '跑一次', skillIds: ['skill-tec', 'skill-cad'] })
    // Mounted skills persist across the session's messages.
    expect(screen.getByLabelText('已挂载 Tecplot')).toBeTruthy()
  })

  it('sends on Enter, newlines on Shift+Enter, and never through a composing IME', async () => {
    const { commands, textarea } = setup()
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(commands).toHaveLength(0)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(commands).toHaveLength(0)
    expect(textarea.value).toBe('hello')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-75',
      turnId: expect.any(String), text: 'hello' })
    expect(textarea.value).toBe('')
  })

  it('keeps the plain send exactly the original shape when no command is used', async () => {
    const { commands, textarea } = setup()
    fireEvent.change(textarea, { target: { value: '@Expert\n' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    // A typed mention without the picker stays plain text — the command
    // asserts only what the user picked through the composer UI.
    expect(commands[0]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-75',
      turnId: expect.any(String), text: '@Expert\n' })
  })
})
