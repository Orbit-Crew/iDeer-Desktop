// Issue 72: the session sidebar controller. Every view belongs to one current
// user operation; stale replies are fenced by generation, and every reply is
// the Server's own post-action list — no local roster is kept or merged.
import type { DesktopBridge, ThreadRowView, ThreadView } from '../../../shared/desktop'

export interface SessionSidebarView {
  threads: ThreadRowView[]
  permissions: { canRename: boolean; canDelete: boolean }
  query: string
  busy: boolean
  failed: boolean
  error: string
}

export const emptySessionSidebarView = (): SessionSidebarView => ({
  threads: [], permissions: { canRename: false, canDelete: false }, query: '', busy: false, failed: false, error: ''
})

/** Fixed wire categories the sidebar can explain in Chinese; anything else
 * reads as a generic platform failure with the category shown. The Server's
 * own permission and conflict rejections arrive as the shared CHAT_* codes. */
const errorExplanations: Record<string, string> = {
  CHAT_FORBIDDEN: '当前账号没有执行该操作的权限',
  CHAT_CONFLICT: '该会话有任务在执行，平台拒绝了这次修改，请稍后重试',
  CHAT_NOT_FOUND: '平台已找不到该会话，列表已刷新',
  CHAT_UNAUTHENTICATED: '请先登录平台后再管理会话',
  CHAT_IDENTITY_CHANGED: '登录身份已变化，请重新打开会话列表',
  CHAT_COMMAND_INVALID: '请求被拒绝：会话操作参数无效',
  CHAT_SERVER_UNAVAILABLE: '平台暂时不可用，请检查网络或稍后重试',
  CHAT_SERVER_ERROR: '平台处理该操作时出错，请稍后重试',
  THREADS_BUSY: '上一个会话操作还在进行，请稍候',
  THREADS_TIMEOUT: '会话操作超时，结果以平台状态为准，请刷新核对',
  RUNTIME_UNAVAILABLE: '本机 Runtime 未运行，请先连接设备'
}

export const explainThreadError = (message: string): string =>
  errorExplanations[message] || `平台会话管理不可用：${message}`

export class SessionSidebarController {
  private generation = 0
  private view = emptySessionSidebarView()
  constructor(private readonly api: Pick<DesktopBridge, 'threads'>, private readonly publish: (view: SessionSidebarView) => void) {}
  snapshot(): SessionSidebarView { return this.view }
  private update(change: Partial<SessionSidebarView>): void { this.view = { ...this.view, ...change }; this.publish(this.view) }
  invalidate(): void { this.generation++ }

  /** One management round-trip; the reply always carries the Server's own
   * list and permissions, so no client-side merge or optimistic write exists.
   * A canceled confirmation dialog is a user decision, not a failure. */
  private async run(command: Parameters<DesktopBridge['threads']>[0], patch?: (view: SessionSidebarView) => Partial<SessionSidebarView>): Promise<void> {
    this.invalidate()
    const generation = this.generation
    this.update({ busy: true, failed: false, error: '', ...(patch ? patch(this.view) : {}) })
    try {
      const next: ThreadView = await this.api.threads(command)
      if (generation !== this.generation) return
      this.update({ threads: next.threads, permissions: next.permissions, busy: false, failed: false, error: '' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      if (message === 'THREADS_CANCELED') { this.update({ busy: false, failed: false, error: '' }); return }
      this.update({ busy: false, failed: true, error: message })
    }
  }

  load(): Promise<void> { return this.run({ action: 'list' }) }
  search(query: string): Promise<void> { return this.run({ action: 'search', query }, () => ({ query })) }

  async rename(threadId: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed || trimmed.length > 200 || !this.view.permissions.canRename) return
    await this.run({ action: 'rename', threadId, title: trimmed })
  }

  async remove(threadId: string): Promise<void> {
    if (!this.view.permissions.canDelete) return
    await this.run({ action: 'delete', threadId })
  }
}
