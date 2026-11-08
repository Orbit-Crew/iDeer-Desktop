// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MigrationWizardBody, MigrationWizardModal } from '../src/renderer/src/components/Layout/MigrationWizardModal'
import { MigrationController, emptyMigrationWizardView, type MigrationWizardView } from '../src/renderer/src/stores/migration'
import type { DesktopBridge, MigrationScanView } from '../src/shared/desktop'
import type { PanelTypeId } from '../src/renderer/src/dock/types'

afterEach(cleanup)

const scanRow = (overrides: Partial<MigrationScanView['workspaces'][number]> = {}) => ({
  id: 'ws-a', name: '结构仿真', folder: 'C:/data/结构仿真', current: true, orphan: false,
  createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-05T00:00:00.000Z',
  files: { data: { present: true, size: 33 }, kb: { present: false, size: 0 }, tables: { present: true, size: 11 } },
  ...overrides
})

const scanView = (): MigrationScanView => ({
  root: 'C:/Users/x/AppData/Roaming/linz',
  workspaces: [scanRow(), scanRow({ id: 'ws-b', name: '空闲工作区', folder: '', current: false })],
  configError: ''
})

const viewWith = (scan: MigrationScanView | null, ledger: MigrationWizardView['ledger'] = []): MigrationWizardView =>
  ({ ...emptyMigrationWizardView(), scan, ledger })

const makeController = (api: Pick<DesktopBridge, 'migration'>): MigrationController =>
  new MigrationController(api, () => {})

const renderBody = (view: MigrationWizardView, controller: MigrationController,
                   onOpenPane?: (id: PanelTypeId) => void) =>
  render(<MigrationWizardBody view={view} controller={controller} onOpenPane={onOpenPane} />)

describe('migration wizard surface (#118)', () => {
  it('states the never-migrate list and the one-time-aid contract before anything else', () => {
    renderBody(viewWith(scanView()), makeController({ migration: vi.fn() }))
    expect(screen.getByLabelText('永不迁移清单').textContent).toContain('旧聊天记录、模型密钥、批准记忆与执行状态一律不迁移')
    expect(screen.getByText(/一次性辅助流程/).textContent).toContain('不做整体搬运')
    expect(screen.getByText(/迁移 ≠ 导入完成/)).toBeTruthy()
  })

  it('refuses to migrate a workspace until its ownership is confirmed here', () => {
    const api = { migration: vi.fn() }
    renderBody(viewWith(scanView()), makeController(api))
    const migrate = screen.getByLabelText('迁移工作区 结构仿真') as HTMLButtonElement
    // 未确认项不迁移: the button is disabled and clicking it does nothing.
    expect(migrate.disabled).toBe(true)
    fireEvent.click(migrate)
    expect(api.migration).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('确认归属 结构仿真'))
    expect((screen.getByLabelText('迁移工作区 结构仿真') as HTMLButtonElement).disabled).toBe(false)
  })

  it('migrates the one confirmed workspace with its name, bind choice and the scan folder suggestion', async () => {
    const api: Pick<DesktopBridge, 'migration'> = {
      migration: vi.fn().mockResolvedValue({
        migrated: true, workspaceId: 'ws-a', projectId: 'proj-new-1', errorCode: '',
        ledger: [{ workspaceId: 'ws-a', workspaceName: '结构仿真', projectId: 'proj-new-1',
          projectName: '结构仿真', folder: 'C:/chosen', status: 'migrated', errorCode: '',
          createdAt: '2026-11-08T00:00:00', updatedAt: '2026-11-08T00:00:00' }]
      })
    }
    const view = viewWith(scanView())
    const controller = makeController(api)
    renderBody(view, controller)
    fireEvent.click(screen.getByLabelText('确认归属 结构仿真'))
    fireEvent.click(screen.getByLabelText('迁移工作区 结构仿真'))
    await waitFor(() => expect(api.migration).toHaveBeenCalledWith({
      action: 'migrate', workspaceId: 'ws-a', name: '结构仿真', bind: true, folder: 'C:/data/结构仿真'
    }))
    // The reply's ledger marks the row migrated in the same round.
    await waitFor(() => expect(screen.getByLabelText('迁移完成 结构仿真').textContent).toContain('已迁移：平台项目「结构仿真」'))
  })

  it('migrates without a bind when the workspace has no folder and the switch is off', async () => {
    const api = { migration: vi.fn().mockResolvedValue({ migrated: true, workspaceId: 'ws-b', projectId: 'p', errorCode: '', ledger: [] }) }
    renderBody(viewWith(scanView()), makeController(api))
    fireEvent.click(screen.getByLabelText('确认归属 空闲工作区'))
    fireEvent.click(screen.getByLabelText('迁移工作区 空闲工作区'))
    await waitFor(() => expect(api.migration).toHaveBeenCalledWith({
      action: 'migrate', workspaceId: 'ws-b', name: '空闲工作区', bind: false
    }))
  })

  it('shows a failed attempt honestly with its fixed category and a per-row retry', () => {
    const api = { migration: vi.fn() }
    renderBody(viewWith(scanView(), [{
      workspaceId: 'ws-a', workspaceName: '结构仿真', projectId: '', projectName: '结构仿真',
      folder: '', status: 'failed', errorCode: 'CHAT_FORBIDDEN',
      createdAt: '2026-11-08T00:00:00', updatedAt: '2026-11-08T00:00:00'
    }]), makeController(api))
    expect(screen.getByText(/当前账号没有创建平台项目的权限/)).toBeTruthy()
    expect(screen.getByText(/未创建任何平台项目；处理后可重试/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('重试迁移 结构仿真'))
    expect(api.migration).toHaveBeenCalledWith({
      action: 'migrate', workspaceId: 'ws-a', name: '结构仿真', bind: true, folder: 'C:/data/结构仿真'
    })
  })

  it('lists orphan folders namelessly and flags an unreadable roster instead of hiding rows', () => {
    renderBody(viewWith({
      root: 'C:/Users/x/AppData/Roaming/linz',
      workspaces: [scanRow({ orphan: true, name: '', folder: '', current: false, createdAt: '', lastOpenedAt: '' })],
      configError: 'MIGRATION_CONFIG_UNREADABLE'
    }), makeController({ migration: vi.fn() }))
    expect(screen.getByText('未命名工作区')).toBeTruthy()
    expect(screen.getByText('名册缺失')).toBeTruthy()
    expect(screen.getByText(/旧版名册读取失败/)).toBeTruthy()
  })

  it('says honestly when no legacy workspace exists', () => {
    renderBody(viewWith({ root: 'C:/nowhere/linz', workspaces: [], configError: '' }),
      makeController({ migration: vi.fn() }))
    expect(screen.getByText(/未发现旧版 linz 工作区/)).toBeTruthy()
  })

  it('points at the real re-import entries and refuses to fake the missing Agent-config one', () => {
    const opened: PanelTypeId[] = []
    renderBody(viewWith(scanView()), makeController({ migration: vi.fn() }),
      (id) => opened.push(id))
    fireEvent.click(screen.getByLabelText('打开知识库（文档库导入）'))
    fireEvent.click(screen.getByLabelText('打开本机 Runtime（表格导入）'))
    fireEvent.click(screen.getByLabelText('打开模板广场（提示词模板）'))
    expect(opened).toEqual(['kb', 'runtime', 'templates'])
    // The deep links are reachable from inside the wizard's scrollable body;
    // the missing Agent-config entry is stated, never faked with a button.
    expect(screen.getByText(/入口尚未提供：桌面暂无 Agent 配置的文件级导入入口/)).toBeTruthy()
  })

  it('scans once when the modal opens and never outside it', async () => {
    const api = { migration: vi.fn().mockResolvedValue(scanView()) }
    const controller = makeController(api)
    const { rerender } = render(<MigrationWizardModal open={false} onClose={() => {}} view={viewWith(null)} controller={controller} />)
    expect(api.migration).not.toHaveBeenCalled()
    rerender(<MigrationWizardModal open={true} onClose={() => {}} view={viewWith(null)} controller={controller} />)
    await waitFor(() => expect(api.migration).toHaveBeenCalledWith({ action: 'scan' }))
  })
})
