import type { ChatCommand, ChatMessage, ChatSnapshot, HumanInputRequest } from '../shared/desktop'
import type { RuntimeProcess } from './runtime'
import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Mirrors the platform's own response bound: any larger export would be a
// different conversation than the interface bounded, not a faithful one.
const MAX_EXPORT_BYTES = 2 * 1024 * 1024
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/g

/** Issue 79: role labels mirror the chat cards exactly — the export must read
 * like the interface the user already saw. */
export function messageLabel(message: ChatMessage): string {
  return message.role === 'human' ? '你' : message.role === 'ai' ? 'Agent' : `工具 ${message.name}`
}

// The clarification card shows title, question, context, option and form-field
// labels plus the answered marker — those visible facts ride the export; the
// request id, source and value payloads never do.
function clarificationLines(request: HumanInputRequest, answered: boolean): string[] {
  const lines = [`**${request.title || '需要你的输入'}**：${request.question}`]
  if (request.context) lines.push(request.context)
  if (request.options?.length) lines.push(`选项：${request.options.map((option) => option.label).join('、')}`)
  if (request.fields?.length) lines.push(`表单项：${request.fields.map((field) => field.label).join('、')}`)
  lines.push(answered ? '（已回答）' : '（待回答）')
  return lines
}

function messageSection(state: ChatSnapshot, message: ChatMessage): string {
  const parts = [message.text]
  if (message.request) {
    const answered = state.messages.some((other) => other.response?.request_id === message.request!.request_id)
    parts.push(...clarificationLines(message.request, answered))
  }
  return `## ${messageLabel(message)}\n\n${parts.filter((part) => part.length).join('\n\n')}`
}

const pad = (value: number): string => String(value).padStart(2, '0')

function sessionTitle(state: ChatSnapshot): string {
  const title = state.threads.find((thread) => thread.id === state.thread?.id)?.title?.trim()
  return title || '平台会话'
}

// Issue 79: the interface renders message text verbatim (preformatted plain
// text), so the export does exactly that and states the difference instead of
// pretending a markdown formatter exists. The note also names what the export
// deliberately leaves out: attachments, receipts and server events.
function exportNote(exportedAt: Date): string {
  const stamp = `${exportedAt.getFullYear()}-${pad(exportedAt.getMonth() + 1)}-${pad(exportedAt.getDate())} ` +
    `${pad(exportedAt.getHours())}:${pad(exportedAt.getMinutes())}（本机时间）`
  return `> 导出说明：以下内容为平台聊天界面可见消息的原样文本，与界面一致；代码块、公式与图片按消息原文呈现，` +
    `界面同样以原样文本显示，不做额外渲染。\n> 导出不含附件内容、本地任务回执与服务端事件。导出时间：${stamp}`
}

/** Builds the whole-session Markdown from the Runtime's own state reply. The
 * transcript is the interface-visible message log and nothing else: receipts,
 * server events and internal identifiers never enter the document. */
export function buildSessionMarkdown(state: ChatSnapshot, exportedAt: Date): string {
  const sections = state.messages.map((message) => messageSection(state, message))
  return `# ${sessionTitle(state)}\n\n${exportNote(exportedAt)}\n\n` + sections.join('\n\n---\n\n')
}

/** Builds the single-reply Markdown: same note, one message section. */
export function buildMessageMarkdown(state: ChatSnapshot, message: ChatMessage, exportedAt: Date): string {
  return `# ${sessionTitle(state)}\n\n${exportNote(exportedAt)}\n\n${messageSection(state, message)}`
}

function pad4(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function suggestedName(state: ChatSnapshot, mode: 'session' | 'message', now: Date): string {
  const base = (sessionTitle(state)).replace(INVALID_NAME, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim() || '平台会话'
  return `${base.slice(0, 80)}-${mode === 'session' ? '导出' : '单条回复'}-${pad4(now)}.md`
}

/** Owns the native save step for the conversation export. The document is
 * derived here from the Runtime's own state reply — the renderer names the
 * action and target only and can never supply write content. */
export async function exportChatTranscript(runtime: Pick<RuntimeProcess, 'chat'>,
  command: Extract<ChatCommand, { action: 'export' }>,
  chooseDestination: (name: string) => Promise<string | undefined>,
  now: () => Date = () => new Date()): Promise<ChatSnapshot> {
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      (command.mode !== 'session' && command.mode !== 'message') ||
      typeof command.scope !== 'string' || !command.scope ||
      typeof command.threadId !== 'string' || !command.threadId ||
      Object.keys(command).length !== (command.mode === 'session' ? 4 : 5) ||
      (command.mode === 'message' && (typeof command.messageId !== 'string' || !command.messageId ||
        command.messageId.length > 256))) throw new Error('CHAT_COMMAND_INVALID')
  const state = await runtime.chat({ action: 'state' })
  if (state.error) return state
  if (state.scope !== command.scope || state.thread?.id !== command.threadId) throw new Error('CHAT_EXPORT_SCOPE_CHANGED')
  let content: string
  if (command.mode === 'message') {
    const message = state.messages.find((candidate) => candidate.id === command.messageId)
    if (!message || message.role !== 'ai') throw new Error('CHAT_EXPORT_TARGET_MISSING')
    content = buildMessageMarkdown(state, message, now())
  } else {
    content = buildSessionMarkdown(state, now())
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_EXPORT_BYTES) throw new Error('CHAT_EXPORT_TOO_LARGE')
  const destination = await chooseDestination(suggestedName(state, command.mode, now()))
  if (!destination) return { ...state, exportStatus: 'cancelled' }
  // The user may switch accounts while the native dialog is pending. The
  // current Runtime scope includes the device binding and business identity.
  const current = await runtime.chat({ action: 'state' })
  if (current.error || current.scope !== command.scope || current.thread?.id !== command.threadId) {
    throw new Error('CHAT_EXPORT_IDENTITY_CHANGED')
  }
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.export`)
  let staged = false
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    staged = true
    renameSync(temporary, destination)
    staged = false
  } catch {
    throw new Error('CHAT_EXPORT_SAVE_FAILED')
  } finally {
    if (staged) { try { unlinkSync(temporary) } catch { /* Preserve the original failure. */ } }
  }
  return { ...current, exportStatus: 'saved' }
}
