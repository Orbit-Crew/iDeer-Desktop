import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Space, Tag, Typography } from 'antd'
import type { OfficialTemplateCommand, OfficialTemplateRowView, OfficialTemplatesView, TemplateCommand, TemplateView } from '../../../shared/desktop'
import { UNCATEGORIZED_LABEL, VariableChips } from './TemplateSection'

export interface WelcomeSectionProps {
  /** Injectable for tests; defaults to the real pinned IPC bridge. */
  onOfficialList?: (command: OfficialTemplateCommand) => Promise<OfficialTemplatesView>
  /** 另存为我的 rides the account-template create — same bridge family,
   * same private-by-default Server behavior. */
  onCopy?: (command: Extract<TemplateCommand, { action: 'create' }>) => Promise<TemplateView>
}

// Issue 40 lesson applied: the default bridges are module-level so their
// identity never changes across renders.
const defaultOfficialList = (command: OfficialTemplateCommand): Promise<OfficialTemplatesView> =>
  window.ideer.officialTemplates(command)

const defaultCopy = (command: Extract<TemplateCommand, { action: 'create' }>): Promise<TemplateView> =>
  window.ideer.templates(command)

/**
 * Issue 106 欢迎页：平台官方模板精选的只读门面，出现在会话第一条消息
 * 之前（与原版欢迎页→消息页的交接一致）。行内容永远来自当次挂载的实时
 * 平台读取——没有本地快照，官方集更新自动跟随；「另存为我的」走账号模板
 * 的普通 create：wire 上没有官方行引用，副本按平台默认私有落地，与原件
 * 从此无关。平台未提供该服务、无权限或断线时如实降级展示，绝不伪装。
 */
export function WelcomeSection({ onOfficialList, onCopy }: WelcomeSectionProps): JSX.Element {
  const officialList = onOfficialList ?? defaultOfficialList
  const copyApi = onCopy ?? defaultCopy
  const [rows, setRows] = useState<OfficialTemplateRowView[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [copied, setCopied] = useState('')
  const [working, setWorking] = useState(false)

  const reload = useCallback(async () => {
    try {
      const view = await officialList({ action: 'official-list' })
      setRows(view.official)
      setLoadError('')
    } catch (error) {
      setRows([])
      setLoadError(describe(error))
    }
  }, [officialList])

  useEffect(() => { void reload() }, [reload])

  const copy = async (row: OfficialTemplateRowView): Promise<void> => {
    // A prefill would send nothing, but a copy writes a row — the single
    // working gate keeps one copy in flight at a time, like the plaza.
    setWorking(true)
    try {
      const view = await copyApi({ action: 'create', name: row.name, category: row.category, content: row.content })
      setSaveError('')
      setCopied(view.created === true ? row.name : '')
    } catch (error) {
      setCopied('')
      setSaveError(describe(error))
    } finally {
      setWorking(false)
    }
  }

  return <Card size="small" title="欢迎 · 官方模板精选" className="max-w-3xl"
    extra={<Button size="small" aria-label="刷新官方模板" disabled={working} onClick={() => void reload()}>刷新</Button>}>
    <Space direction="vertical" size="small" className="w-full">
      <Alert type="info" showIcon role="note"
        message="官方模板是平台发布的只读精选；「另存为我的」会用你的账号创建一条独立私有副本，此后与官方原件无关，可在模板广场编辑。平台更新官方集后这里自动跟随。" />
      {loadError && <Alert type="warning" showIcon role="alert" message={`官方模板不可用：${loadError}`} />}
      {saveError && <Alert type="error" showIcon role="alert" message={saveError} />}
      {copied && <Alert type="success" showIcon role="status" message={`已复制为我的模板「${copied}」，可在模板广场编辑。`} />}
      {(rows ?? []).length === 0 && !loadError && <Empty description="平台暂无官方模板精选" />}
      {(rows ?? []).map((row) => <Card size="small" type="inner" key={row.id} title={row.name}
        extra={<Button size="small" type="primary" ghost aria-label={`另存为我的 ${row.name}`}
          disabled={working} onClick={() => void copy(row)}>另存为我的</Button>}>
        <Space direction="vertical" size={4} className="w-full">
          <Space size={8} wrap>
            <Tag>{row.category || UNCATEGORIZED_LABEL}</Tag>
            <Typography.Text type="secondary" className="text-xs">平台官方 · 只读精选</Typography.Text>
          </Space>
          <Typography.Paragraph className="mb-0" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {row.content}
          </Typography.Paragraph>
          <VariableChips content={row.content} label={`${row.name} 官方模板变量占位`} />
        </Space>
      </Card>)}
    </Space>
  </Card>
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const names: Record<string, string> = {
    TEMPLATE_UNAUTHENTICATED: '尚未登录平台账号，登录后可见官方模板精选',
    TEMPLATE_COMMAND_INVALID: '命令未通过安全校验',
    TEMPLATE_BUSY: '上一条模板操作仍在进行，请稍后重试',
    TEMPLATE_TIMEOUT: '平台响应超时，请稍后重试',
    TEMPLATE_FAILED: '官方模板读取失败',
    TEMPLATE_CANCELED: '已取消',
    RUNTIME_UNAVAILABLE: 'Runtime 不可用，启动并登录后可见官方模板精选',
    CHAT_NOT_FOUND: '平台暂未提供官方模板服务',
    CHAT_FORBIDDEN: '没有官方模板的读取权限',
    CHAT_IDENTITY_CHANGED: '登录身份已变化，请重新登录后再试',
    CHAT_UNAUTHENTICATED: '尚未登录平台账号，登录后可见官方模板精选',
    CHAT_SERVER_UNAVAILABLE: '平台暂时不可达，恢复连接后可见官方模板精选'
  }
  return names[message] ?? `官方模板不可用（${message.slice(0, 80)}）`
}

export default WelcomeSection
