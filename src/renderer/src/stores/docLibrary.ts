// Issue 96: the doc library's controller. The import records and the one
// background folder job are the Runtime status snapshot's own display facts —
// the page never keeps a second roster. Every user action (folder import,
// cancel, batch delete, retry) is one generation-fenced round-trip; the reply
// refreshes the same snapshot instead of merging local state, and a canceled
// confirmation dialog is a user decision, not a failure.
// Issue 97: the revision index facts ride the same snapshot rows, and the
// index rebuild (start/cancel) follows the same one-action-at-a-time rules.
// Issue 98: the user's own library search rides the same discipline; its
// bounded citation view is the reply's own display fact, keyed by the record
// it searched, with the honest evidenceComplete fact shown as 依据不完整.
import type { DesktopBridge, KnowledgeImportView, KnowledgeSearchView, RuntimeStatus } from '../../../shared/desktop'

export interface DocLibraryView {
  runtime: RuntimeStatus | null
  failed: boolean
  /** One user action at a time; the pane disables its action buttons on it. */
  busy: boolean
  error: string
  /** Issue 98: the newest library search's citation view and the record it
   * searched; null until one search has answered. */
  search: { recordId: string; view: KnowledgeSearchView } | null
  searchError: string
}

export const emptyDocLibraryView = (): DocLibraryView =>
  ({ runtime: null, failed: false, busy: false, error: '', search: null, searchError: '' })

/** Fixed wire categories the doc library can explain in Chinese; anything else
 * reads as a generic failure with the category shown. */
const errorExplanations: Record<string, string> = {
  KNOWLEDGE_IMPORT_UNAUTHENTICATED: '请先登录平台后再管理文档库',
  KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE: '需要先选择并确认工作目录，且文件夹必须位于其中',
  KNOWLEDGE_IMPORT_KB_INVALID: '平台知识库 UUID 无效，请在资源页复制后粘贴',
  KNOWLEDGE_IMPORT_CANCELED: '',
  KNOWLEDGE_IMPORT_BUSY: '上一个操作还在进行，请稍候',
  KNOWLEDGE_IMPORT_TIMEOUT: '操作超时，结果以导入记录为准，请刷新核对',
  KNOWLEDGE_IMPORT_IDENTITY_CHANGED: '登录身份已变化，请重新打开文档库',
  KNOWLEDGE_IMPORT_NO_SOURCE: '该记录没有保存来源文件，无法重试',
  KNOWLEDGE_IMPORT_RECORD_NOT_FOUND: '该记录已不存在，列表已刷新',
  KNOWLEDGE_IMPORT_RETRY_NOT_FAILED: '只有失败的记录可以重试',
  KNOWLEDGE_IMPORT_FAILED: '导入未完成，请查看失败原因后重试',
  // Issue 97: the index rebuild's fixed categories.
  KNOWLEDGE_INDEX_UNAUTHENTICATED: '请先登录平台后再重建索引',
  KNOWLEDGE_INDEX_WORKSPACE_UNAVAILABLE: '需要先选择并确认工作目录，才能重建索引',
  KNOWLEDGE_INDEX_KB_INVALID: '平台知识库标识无效，无法重建索引',
  KNOWLEDGE_INDEX_REVISION_INVALID: '版本标识无效，无法重建索引',
  KNOWLEDGE_INDEX_MANIFEST_INVALID: '版本清单标识无效，无法重建索引',
  KNOWLEDGE_INDEX_REVISION_UNKNOWN: '该版本已不在本机记录中，列表已刷新',
  KNOWLEDGE_INDEX_BUSY: '上一个操作还在进行，请稍候',
  KNOWLEDGE_INDEX_TIMEOUT: '操作超时，结果以索引状态为准，请刷新核对',
  KNOWLEDGE_INDEX_IDENTITY_CHANGED: '登录身份已变化，请重新打开文档库',
  KNOWLEDGE_INDEX_FAILED: '索引重建未完成，请稍后重试',
  // Issue 98: the library search's fixed categories.
  KNOWLEDGE_SEARCH_UNAUTHENTICATED: '请先登录平台后再检索文档库',
  KNOWLEDGE_SEARCH_WORKSPACE_UNAVAILABLE: '需要先选择并确认工作目录，才能检索文档库',
  KNOWLEDGE_SEARCH_FILE_UNAVAILABLE: '工作目录当前不可读，无法检索文档库',
  KNOWLEDGE_SEARCH_KB_INVALID: '平台知识库标识无效，无法检索',
  KNOWLEDGE_SEARCH_REVISION_INVALID: '版本标识无效，无法检索',
  KNOWLEDGE_SEARCH_QUERY_INVALID: '检索词无效：请输入 1–512 个字符且不包含换行',
  KNOWLEDGE_SEARCH_REVISION_UNREGISTERED: '该版本已不在本机记录中，列表已刷新',
  KNOWLEDGE_SEARCH_IDENTITY_UNAVAILABLE: '登录身份信息不完整，无法检索',
  KNOWLEDGE_SEARCH_BUSY: '上一个操作还在进行，请稍候',
  KNOWLEDGE_SEARCH_TIMEOUT: '操作超时，请稍后重试',
  KNOWLEDGE_SEARCH_FAILED: '检索未完成，请稍后重试',
  RUNTIME_UNAVAILABLE: '本机 Runtime 未运行，请先连接设备'
}

/** One category reads through the fixed explanations; a '；'-joined aggregate
 * (batch retry, below) explains every part so no failure is erased. */
export const explainDocLibraryError = (message: string): string => {
  if (message.includes('；')) {
    return message.split('；').map((part) => explainDocLibraryError(part)).filter(Boolean).join('；')
  }
  return errorExplanations[message] ?? `文档库操作未完成：${message}`
}

export class DocLibraryController {
  private generation = 0
  private view = emptyDocLibraryView()
  constructor(private readonly api: Pick<DesktopBridge, 'getStatus' | 'knowledgeFolderImport' | 'knowledgeFolderCancel' | 'deleteKnowledgeImports' | 'retryKnowledgeImport' | 'rebuildKnowledgeIndex' | 'cancelKnowledgeIndexRebuild' | 'knowledgeSearch'>,
              private readonly publish: (view: DocLibraryView) => void) {}
  snapshot(): DocLibraryView { return this.view }
  private update(change: Partial<DocLibraryView>): void { this.view = { ...this.view, ...change }; this.publish(this.view) }
  invalidate(): void { this.generation++ }

  /** One status read; every read belongs to the newest operation. */
  async refresh(): Promise<void> {
    const generation = this.generation
    try {
      const status = await this.api.getStatus()
      if (generation !== this.generation) return
      this.update({ runtime: status.runtime, failed: false })
    } catch {
      if (generation === this.generation) this.update({ failed: true })
    }
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.invalidate()
    const generation = this.generation
    this.update({ busy: true, error: '' })
    try {
      await action()
      if (generation !== this.generation) return
      const status = await this.api.getStatus()
      if (generation !== this.generation) return
      this.update({ runtime: status.runtime, busy: false, failed: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      // A canceled confirmation dialog is a user decision, not a failure.
      this.update({ busy: false, error: message === 'KNOWLEDGE_IMPORT_CANCELED' ? '' : message })
    }
  }

  startFolderImport(kbId: string): Promise<void> {
    return this.run(() => this.api.knowledgeFolderImport(kbId))
  }

  cancelFolderImport(): Promise<void> {
    return this.run(() => this.api.knowledgeFolderCancel())
  }

  /** Issue 97: rebuild one registered revision's device BM25 index in the
   * background; the honest outcome rides the snapshot's index facts. */
  rebuildIndex(record: KnowledgeImportView): Promise<void> {
    return this.run(() => this.api.rebuildKnowledgeIndex(record.kbId, record.revisionId, record.manifestHash))
  }

  cancelIndexRebuild(): Promise<void> {
    return this.run(() => this.api.cancelKnowledgeIndexRebuild())
  }

  /** Issue 98: the user's own search over one registered revision. The
   * bounded citation view is the reply's display fact (keyed by the record);
   * a failure explains itself through the fixed categories and never keeps
   * a stale answer on display. */
  async searchRecord(record: KnowledgeImportView, query: string): Promise<void> {
    this.invalidate()
    const generation = this.generation
    this.update({ busy: true, error: '', search: null, searchError: '' })
    try {
      const view = await this.api.knowledgeSearch(record.kbId, record.revisionId, query)
      if (generation !== this.generation) return
      this.update({ busy: false, failed: false, search: { recordId: record.id, view } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      this.update({ busy: false, searchError: message })
    }
  }

  deleteRecords(ids: string[]): Promise<void> {
    return this.run(() => this.api.deleteKnowledgeImports(ids))
  }

  /** Sequential batch retry: one command per record (each is one ordinary
   * import round-trip). Every failure is kept — distinct categories joined
   * with '；' — so a multi-selection reports all of its failures instead of
   * only the last one. The snapshot refreshes after each record so the page
   * shows the retries that landed. */
  async retryRecords(recordIds: string[]): Promise<void> {
    const failures: string[] = []
    for (const recordId of recordIds) {
      this.update({ busy: true, error: '' })
      try {
        await this.api.retryKnowledgeImport(recordId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message !== 'KNOWLEDGE_IMPORT_CANCELED' && !failures.includes(message)) failures.push(message)
      }
      try {
        const status = await this.api.getStatus()
        this.update({ runtime: status.runtime, failed: false })
      } catch {
        this.update({ failed: true })
      }
    }
    this.update({ busy: false, error: failures.join('；') })
  }
}
