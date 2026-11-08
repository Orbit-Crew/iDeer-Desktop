// Issue 118: the migration wizard's controller. The scan is the Runtime's
// read-only listing of the old linz install; a migrate names the one
// workspace the user explicitly confirmed and rides the trusted main
// process's confirm + folder dialogs. Every reply carries the authoritative
// post-action state (the scan listing or the attempt ledger), so no client
// side merge exists; stale replies are fenced by generation, and a canceled
// confirmation dialog is a user decision, not a failure.
import type { DesktopBridge, MigrationLedgerView, MigrationScanView } from '../../../shared/desktop'

type MigrationApi = Pick<DesktopBridge, 'migration' | 'getStatus'>

export interface MigrationWizardView {
  busy: boolean
  failed: boolean
  error: string
  scan: MigrationScanView | null
  ledger: MigrationLedgerView[]
}

export const emptyMigrationWizardView = (): MigrationWizardView => ({
  busy: false, failed: false, error: '', scan: null, ledger: []
})

/** Fixed wire categories the wizard can explain in Chinese; anything else
 * reads as a generic failure with the category shown. The platform's own
 * rejections arrive as the shared CHAT_* codes. */
const errorExplanations: Record<string, string> = {
  MIGRATION_UNAUTHENTICATED: '请先登录平台后再使用迁移向导',
  MIGRATION_IDENTITY_CHANGED: '登录身份已变化，请重新打开迁移向导',
  MIGRATION_WORKSPACE_UNKNOWN: '旧版目录中已找不到该工作区，请重新扫描',
  MIGRATION_ALREADY_MIGRATED: '该工作区已经迁移过，不能重复创建平台项目',
  MIGRATION_STORAGE_UNAVAILABLE: '本机迁移记录存储不可用，请重启应用后重试',
  MIGRATION_BUSY: '上一个迁移操作还在进行，请稍候',
  MIGRATION_TIMEOUT: '迁移操作超时，结果以平台项目列表为准，请刷新核对',
  CHAT_FORBIDDEN: '当前账号没有创建平台项目的权限（需要 projects:write）',
  CHAT_CONFLICT: '该操作被平台拒绝，请稍后重试',
  CHAT_NOT_FOUND: '平台已找不到该项目，请重试',
  CHAT_UNAUTHENTICATED: '请先登录平台后再使用迁移向导',
  CHAT_IDENTITY_CHANGED: '登录身份已变化，请重新打开迁移向导',
  CHAT_COMMAND_INVALID: '请求被拒绝：迁移参数无效（常见原因是绑定的文件夹已不存在）',
  CHAT_SERVER_UNAVAILABLE: '平台暂时不可用，请检查网络或稍后重试',
  CHAT_SERVER_ERROR: '平台处理该操作时出错，请稍后重试',
  CHAT_BINDING_STORE_UNAVAILABLE: '本机绑定记录存储不可用，请重启应用后重试',
  RUNTIME_UNAVAILABLE: '本机 Runtime 未运行，请先连接设备'
}

export const explainMigrationError = (message: string): string =>
  errorExplanations[message] || `迁移未能完成：${message}`

export class MigrationController {
  private generation = 0
  private view = emptyMigrationWizardView()
  constructor(private readonly api: MigrationApi, private readonly publish: (view: MigrationWizardView) => void) {}
  snapshot(): MigrationWizardView { return this.view }
  private update(change: Partial<MigrationWizardView>): void { this.view = { ...this.view, ...change }; this.publish(this.view) }
  invalidate(): void { this.generation++ }
  /** Seed display state without a wire round-trip (surface remount, test
   * harness); later runs keep the seeded scan and merge their own outcome. */
  seed(change: Partial<MigrationWizardView>): void { this.update(change) }

  /** One wizard round-trip; the reply always carries the authoritative
   * state — the scan's listing or the post-action ledger — so nothing is
   * merged locally. A wire-busy rejection retries a bounded three times
   * after the single slot frees. */
  private async run(command: Parameters<DesktopBridge['migration']>[0], retried = 0): Promise<void> {
    this.invalidate()
    const generation = this.generation
    this.update({ busy: true, failed: false, error: '' })
    try {
      const next = await this.api.migration(command)
      if (generation !== this.generation) return
      if (Array.isArray((next as MigrationScanView).workspaces)) {
        this.update({ scan: next as MigrationScanView, ledger: this.view.ledger, busy: false, failed: false, error: '' })
      } else {
        this.update({ ledger: (next as { ledger: MigrationLedgerView[] }).ledger, busy: false, failed: false, error: '' })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      if (message === 'MIGRATION_CANCELED') { this.update({ busy: false, failed: false, error: '' }); return }
      if (message === 'MIGRATION_BUSY' && retried < 3) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        if (generation !== this.generation) return
        return this.run(command, retried + 1)
      }
      this.update({ busy: false, failed: true, error: message })
    }
  }

  /** Opening the wizard: seed this identity's attempt rows from the same
   * 0.5 s status snapshot the rest of the surface reads, so an already
   * migrated workspace shows as 迁移后 even after a remount or restart,
   * then run the explicit read-only scan. The wizard never reads the
   * legacy install outside these commands. */
  async open(): Promise<void> {
    this.invalidate()
    const generation = this.generation
    let seeded: MigrationLedgerView[] = []
    try {
      const status = await this.api.getStatus()
      if (generation !== this.generation) return
      seeded = status.runtime.migrationLedger ?? []
    } catch {
      seeded = []
    }
    if (generation !== this.generation) return
    this.update({ ledger: seeded })
    await this.run({ action: 'scan' })
  }

  /** The explicit scan; the wizard never reads the legacy install outside
   * this command. */
  rescan(): Promise<void> { return this.run({ action: 'scan' }) }

  /** One confirmed workspace's migration. `workspaceName` is the legacy
   * name the confirm dialog states; `name` is the platform project name the
   * user edited. `folder` is only the scan's suggestion — the final folder
   * is chosen and confirmed in the trusted main process's native dialog
   * (不绑定 = ''). */
  migrate(workspaceId: string, workspaceName: string, name: string, bind: boolean, folder?: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 128) return Promise.resolve()
    const legacy = workspaceName.slice(0, 128)
    return this.run({
      action: 'migrate', workspaceId, workspaceName: legacy, name: trimmed, bind,
      ...(folder ? { folder } : {})
    })
  }
}
