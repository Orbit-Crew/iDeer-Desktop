// Issue 91: the platform project directory controller. The project list is
// the Server's own post-action reply — the desktop never keeps a second
// roster, so the same account reads the same projects on any machine. Every
// view belongs to one current user operation; stale replies are fenced by
// generation, and deleting or archiving a project never touches local files
// or directory grants.
import type { DesktopBridge, ProjectBindingView, ProjectOperationView } from '../../../shared/desktop'

export interface ProjectDirectoryView {
  projects: ProjectOperationView['projects']
  permissions: { canWrite: boolean; canDelete: boolean }
  /** Issue 92: this device's own folder bindings, one row per bound project;
   * another device's rows never appear here (绑定不迁移). */
  bindings: ProjectBindingView[]
  busy: boolean
  failed: boolean
  error: string
}

export const emptyProjectDirectoryView = (): ProjectDirectoryView => ({
  projects: [], permissions: { canWrite: false, canDelete: false }, bindings: [], busy: false, failed: false, error: ''
})

/** Fixed wire categories the project surface can explain in Chinese; anything
 * else reads as a generic platform failure with the category shown. The
 * Server's own permission and conflict rejections arrive as the shared
 * CHAT_* codes. */
const errorExplanations: Record<string, string> = {
  CHAT_FORBIDDEN: '当前账号没有执行该操作的权限',
  CHAT_CONFLICT: '该操作被平台拒绝，请稍后重试',
  CHAT_NOT_FOUND: '平台已找不到该项目，列表已刷新',
  CHAT_UNAUTHENTICATED: '请先登录平台后再管理项目',
  CHAT_IDENTITY_CHANGED: '登录身份已变化，请重新打开项目列表',
  CHAT_COMMAND_INVALID: '请求被拒绝：项目操作参数无效',
  CHAT_SERVER_UNAVAILABLE: '平台暂时不可用，请检查网络或稍后重试',
  CHAT_SERVER_ERROR: '平台处理该操作时出错，请稍后重试',
  CHAT_BINDING_STORE_UNAVAILABLE: '本机绑定记录存储不可用，请重启应用后重试',
  PROJECTS_BUSY: '上一个项目操作还在进行，请稍候',
  PROJECTS_TIMEOUT: '项目操作超时，结果以平台状态为准，请刷新核对',
  RUNTIME_UNAVAILABLE: '本机 Runtime 未运行，请先连接设备'
}

export const explainProjectError = (message: string): string =>
  errorExplanations[message] || `平台项目管理不可用：${message}`

export class ProjectDirectoryController {
  private generation = 0
  private view = emptyProjectDirectoryView()
  constructor(private readonly api: Pick<DesktopBridge, 'projects'>, private readonly publish: (view: ProjectDirectoryView) => void) {}
  snapshot(): ProjectDirectoryView { return this.view }
  private update(change: Partial<ProjectDirectoryView>): void { this.view = { ...this.view, ...change }; this.publish(this.view) }
  invalidate(): void { this.generation++ }

  /** One management round-trip; the reply always carries the Server's own
   * list and permissions, so no client-side merge or optimistic write exists.
   * A canceled confirmation dialog is a user decision, not a failure, and a
   * wire-busy rejection retries a bounded three times after the single slot
   * frees instead of surfacing a spurious error. */
  private async run(command: Parameters<DesktopBridge['projects']>[0], retried = 0): Promise<void> {
    this.invalidate()
    const generation = this.generation
    this.update({ busy: true, failed: false, error: '' })
    try {
      const next: ProjectOperationView = await this.api.projects(command)
      if (generation !== this.generation) return
      this.update({ projects: next.projects, permissions: next.permissions, bindings: next.bindings ?? [],
        busy: false, failed: false, error: '' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      if (message === 'PROJECTS_CANCELED') { this.update({ busy: false, failed: false, error: '' }); return }
      if (message === 'PROJECTS_BUSY' && retried < 3) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        if (generation !== this.generation) return
        return this.run(command, retried + 1)
      }
      this.update({ busy: false, failed: true, error: message })
    }
  }

  load(): Promise<void> { return this.run({ action: 'list' }) }

  async create(name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 128 || !this.view.permissions.canWrite) return
    await this.run({ action: 'create', name: trimmed })
  }

  async rename(projectId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 128 || !this.view.permissions.canWrite) return
    await this.run({ action: 'rename', projectId, name: trimmed })
  }

  async archive(projectId: string): Promise<void> {
    if (!this.view.permissions.canWrite) return
    await this.run({ action: 'archive', projectId })
  }

  async restore(projectId: string): Promise<void> {
    if (!this.view.permissions.canWrite) return
    await this.run({ action: 'restore', projectId })
  }

  async remove(projectId: string): Promise<void> {
    if (!this.view.permissions.canDelete) return
    await this.run({ action: 'delete', projectId })
  }

  /** Issue 92: the device-local folder binding. The renderer names the
   * project only — the folder is chosen and confirmed in the trusted main
   * process — and a canceled dialog is a user decision, not a failure.
   * Binding is an optional per-device accessory, so it is not gated on the
   * account's platform write permission; the Runtime's session fence and the
   * project-existence check stay authoritative. */
  async bindFolder(projectId: string): Promise<void> {
    await this.run({ action: 'bind-folder', projectId })
  }

  async unbindFolder(projectId: string): Promise<void> {
    await this.run({ action: 'unbind-folder', projectId })
  }
}
