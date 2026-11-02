// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatCommand, ChatSnapshot } from '../src/shared/desktop'
import { MAX_MESSAGE_ATTACHMENTS } from '../src/shared/desktop'

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
  resources: [{ id: 'agent-main', type: 'agent', name: 'Main', visibility: 'private', version: 1, available: true, reason: '' }],
  threads: [], messages: [], events: [], subagents: [],
  thread: { id: 'thread-93', status: 'idle', agentId: 'agent-main', skillId: '' },
  stream: 'idle', error: '', lastEventId: '',
  ...over
})

const fileWith = (name: string, path: string): File => {
  const file = new File(['content'], name)
  Object.defineProperty(file, 'path', { value: path })
  return file
}

const pickDestination = (chipName: string, value: string): void => {
  // The per-chip destination is a native select: an explicit, bounded choice
  // the composer can drive without any dropdown dance.
  fireEvent.change(screen.getByRole('combobox', { name: `附件去向 ${chipName}` }), { target: { value } })
}

describe('composer attachment destinations (#93)', () => {
  it('adds chips through the picker with the default parsed-text destination', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} onCommand={async (command) => { commands.push(command) }} />)
    const input = screen.getByLabelText('选择附件文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [fileWith('notes.txt', 'C:/work/notes.txt')] } })
    const chips = screen.getByRole('list', { name: '待发送附件' })
    expect(within(chips).getByText('notes.txt')).toBeTruthy()
    // The default destination is always the device-side parse: nothing
    // uploads without an explicit pick.
    expect(within(chips).getByText('发送解析文本（默认）')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('聊天消息'), { target: { value: '请总结附件' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-93',
      turnId: expect.any(String), text: '请总结附件', collab: true,
      attachments: [{ id: expect.any(String), path: 'C:/work/notes.txt', name: 'notes.txt', destination: 'parsed-text' }] })
    // The chips clear with the message.
    expect(screen.queryByRole('list', { name: '待发送附件' })).toBeNull()
  })

  it('emits the local-view command the moment 仅本机查看 is picked and drops the chip', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} onCommand={async (command) => { commands.push(command) }} />)
    fireEvent.change(screen.getByLabelText('选择附件文件') as HTMLInputElement,
      { target: { files: [fileWith('report.pdf', 'C:/work/report.pdf')] } })
    pickDestination('report.pdf', 'local-view')
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({ action: 'attachment-view', scope: 'identity', threadId: 'thread-93',
      id: expect.any(String), path: 'C:/work/report.pdf', name: 'report.pdf' })
    // The consumed chip never rides a later send.
    expect(screen.queryByRole('list', { name: '待发送附件' })).toBeNull()
    fireEvent.change(screen.getByLabelText('聊天消息'), { target: { value: '看一下' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-93',
      turnId: expect.any(String), text: '看一下', collab: true })
  })

  it('carries the explicit upload destination on the send', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} onCommand={async (command) => { commands.push(command) }} />)
    fireEvent.change(screen.getByLabelText('选择附件文件') as HTMLInputElement,
      { target: { files: [fileWith('report.pdf', 'C:/work/report.pdf')] } })
    pickDestination('report.pdf', 'upload')
    fireEvent.change(screen.getByLabelText('聊天消息'), { target: { value: '发给平台' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({ action: 'send', scope: 'identity', threadId: 'thread-93',
      turnId: expect.any(String), text: '发给平台', collab: true,
      attachments: [{ id: expect.any(String), path: 'C:/work/report.pdf', name: 'report.pdf', destination: 'upload' }] })
  })

  it('accepts dropped files and removes chips through the close affordance', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} onCommand={async (command) => { commands.push(command) }} />)
    const composer = screen.getByRole('group', { name: '消息编辑区' })
    fireEvent.drop(composer, { dataTransfer: { files: [fileWith('dropped.csv', 'C:/work/dropped.csv')] } })
    const chips = screen.getByRole('list', { name: '待发送附件' })
    expect(within(chips).getByText('dropped.csv')).toBeTruthy()
    fireEvent.click(within(chips).getByRole('button', { name: '移除附件 dropped.csv' }))
    expect(screen.queryByRole('list', { name: '待发送附件' })).toBeNull()
    // Nothing is sent by dropping alone — a destination is picked first.
    expect(commands).toHaveLength(0)
  })

  it('allows an attachment-only send and refuses to send nothing', async () => {
    const commands: ChatCommand[] = []
    render(<ChatView state={stateWith()} busy={false} onCommand={async (command) => { commands.push(command) }} />)
    // No text and no attachments: the send stays a no-op.
    fireEvent.click(screen.getByLabelText('发送消息'))
    expect(commands).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('选择附件文件') as HTMLInputElement,
      { target: { files: [fileWith('a.txt', 'C:/work/a.txt')] } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toMatchObject({ action: 'send', text: '', attachments: [{ name: 'a.txt' }] })
  })

  it('caps the composer at the shared attachment bound', () => {
    render(<ChatView state={stateWith()} busy={false} onCommand={vi.fn(async () => {})} />)
    const files = Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 3 }, (_, i) => fileWith(`f${i}.txt`, `C:/work/f${i}.txt`))
    fireEvent.change(screen.getByLabelText('选择附件文件') as HTMLInputElement, { target: { files } })
    expect(screen.getByRole('list', { name: '待发送附件' }).children).toHaveLength(MAX_MESSAGE_ATTACHMENTS)
  })
})

describe('attachment outcome display (#93)', () => {
  it('renders the per-attachment outcomes from the reply snapshot', () => {
    const view = render(<ChatView state={stateWith({ attachmentStatuses: [
      { id: 'a1', name: 'notes.txt', destination: 'parsed-text', status: 'parsed', sha256: 'a'.repeat(64), truncated: false },
      { id: 'a2', name: 'report.pdf', destination: 'upload', status: 'uploaded', sha256: 'b'.repeat(64), artifactId: 'art-7' },
      { id: 'a3', name: 'old.doc', destination: 'parsed-text', status: 'skipped', errorCode: 'PARSE_FORMAT_UNSUPPORTED' },
      { id: 'a4', name: 'gone.txt', destination: 'parsed-text', status: 'failed', errorCode: 'ATTACHMENT_READ_FAILED' }
    ] }) } busy={false} onCommand={vi.fn(async () => {})} />)
    expect(view.getByText('附件去向结果')).toBeTruthy()
    expect(view.getByText('附件 notes.txt：解析文本已入对话')).toBeTruthy()
    expect(view.getByText('附件 report.pdf：原件已上传为平台附件 art-7（跨设备可见）')).toBeTruthy()
    expect(view.getByText('附件 old.doc：设备未解析该格式（PARSE_FORMAT_UNSUPPORTED）')).toBeTruthy()
    expect(view.getByText('附件 gone.txt：处理失败（ATTACHMENT_READ_FAILED）')).toBeTruthy()
  })

  it('shows the local view as a read-only dialog with the device parse facts', async () => {
    const view = render(<ChatView state={stateWith({ attachmentView: {
      id: 'v1', name: 'notes.txt', status: 'parsed', text: '只读的解析内容', truncated: false,
      summary: { status: 'parsed', parser: 'text-utf8', parserVersion: '1', pages: 0, tables: 0, truncated: false, errorCode: '' }
    } }) } busy={false} onCommand={vi.fn(async () => {})} />)
    const dialog = view.getByRole('dialog')
    expect(within(dialog).getByText('仅本机查看：notes.txt')).toBeTruthy()
    expect(within(dialog).getByText('只读的解析内容')).toBeTruthy()
    expect(within(dialog).getByText(/text-utf8@1/)).toBeTruthy()
    // Closing is local and does not fire any command.
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭预览' }))
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('shows a failed local view honestly instead of pretending a preview', () => {
    const view = render(<ChatView state={stateWith({ attachmentView: {
      id: 'v2', name: 'gone.txt', status: 'failed', text: '', truncated: false, errorCode: 'ATTACHMENT_READ_FAILED'
    } }) } busy={false} onCommand={vi.fn(async () => {})} />)
    const dialog = view.getByRole('dialog')
    expect(within(dialog).getByText('仅本机查看：gone.txt')).toBeTruthy()
    expect(within(dialog).getByText('本机无法读取或解析该文件：ATTACHMENT_READ_FAILED')).toBeTruthy()
  })
})
