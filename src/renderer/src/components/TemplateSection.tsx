import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Select, Space, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, SendOutlined } from '@ant-design/icons'
import type { TemplateCommand, TemplateRowView, TemplateView } from '../../../shared/desktop'
import { extractTemplateVariables } from '../../../shared/desktop'
import { useSessionStore } from '../stores/sessionStore'

export interface TemplatesSectionProps {
  /** Injectable for tests; defaults to the real pinned IPC bridge. */
  onCommand?: (command: TemplateCommand) => Promise<TemplateView>
}

// Issue 40: the default bridge is module-level so its identity never changes;
// a per-render arrow would rebuild the reload callback and re-send the
// single-slot list request on every parent status tick.
const defaultCommandApi = (command: TemplateCommand): Promise<TemplateView> =>
  window.ideer.templates(command)

interface CreateDraft { name: string; category: string; content: string }

interface EditDraft { id: string; name: string; category: string; content: string }

const EMPTY_CREATE: CreateDraft = { name: '', category: '', content: '' }

const uncategorized = '未分类'

/** Issue 84: the `{{变量}}` chip row — the live placeholder facts a prefill
 * asks the user to fill, deduplicated in first-appearance order. */
function VariableChips({ content, label }: { content: string; label: string }): JSX.Element | null {
  const names = extractTemplateVariables(content)
  if (names.length === 0) return null
  return <Space size={4} wrap aria-label={label}>
    <Typography.Text type="secondary" className="text-xs">变量占位：</Typography.Text>
    {names.map((name) => <Tag key={name} color="blue">{`{{${name}}}`}</Tag>)}
  </Space>
}

const VISIBILITY_LABELS: Record<string, string> = {
  private: '私有',
  public: '公开'
}

/**
 * Issue 84 模板广场：账号级提示词模板的建/编辑/删除、自定义分类、
 * `{{变量}}` 占位提取与使用次数，全部走平台自身端点。点击「使用」只把
 * 文字预填到输入框（占位在输入区高亮提示补填）并记录一次使用（+1），
 * 绝不自动发送；新建模板由平台默认私有，仅创建者可见可用，桌面端无从
 * 携带可见性字段，也就无法放宽可见范围。
 */
export function TemplatesSection({ onCommand }: TemplatesSectionProps): JSX.Element {
  const commandApi = onCommand ?? defaultCommandApi
  const [rows, setRows] = useState<TemplateRowView[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [working, setWorking] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [create, setCreate] = useState<CreateDraft>(EMPTY_CREATE)
  const [edit, setEdit] = useState<EditDraft | null>(null)
  const [category, setCategory] = useState('')

  const reload = useCallback(async () => {
    try {
      const view = await commandApi({ action: 'list' })
      setRows(view.templates)
      setLoadError('')
    } catch (error) {
      setRows([])
      setLoadError(describe(error))
    }
  }, [commandApi])

  useEffect(() => { void reload() }, [reload])

  const run = useCallback(async (command: TemplateCommand): Promise<TemplateView | null> => {
    setWorking(true)
    try {
      const view = await commandApi(command)
      setRows(view.templates)
      setSaveError('')
      return view
    } catch (error) {
      setSaveError(describe(error))
      return null
    } finally {
      setWorking(false)
    }
  }, [commandApi])

  const categories = useMemo(() =>
    Array.from(new Set((rows ?? []).map((row) => row.category).filter((item) => item !== ''))).sort(),
  [rows])
  const visible = useMemo(() => (rows ?? []).filter((row) => !category || row.category === category),
    [rows, category])

  const send = async (): Promise<void> => {
    if (!create.name.trim() || !create.content.trim()) return
    if (await run({ action: 'create', name: create.name, category: create.category, content: create.content })) {
      setCreate(EMPTY_CREATE)
    }
  }

  const save = async (): Promise<void> => {
    if (!edit) return
    const command: TemplateCommand = { action: 'update', templateId: edit.id }
    if (edit.name.trim()) command.name = edit.name
    // The category always rides: clearing the field moves the template back
    // to 未分类 instead of leaving the old value stuck.
    command.category = edit.category
    if (edit.content.trim()) command.content = edit.content
    if (await run(command)) setEdit(null)
  }

  const use = async (row: TemplateRowView): Promise<void> => {
    // The prefill signal goes out first: the click never waits on the use
    // record, and the composer's draft is a local edit — never a send.
    useSessionStore.getState().requestPrefill(row.content)
    await run({ action: 'use', templateId: row.id })
  }

  const remove = async (row: TemplateRowView): Promise<void> => {
    await run({ action: 'delete', templateId: row.id })
  }

  return <Card size="small" title="模板广场" className="max-w-3xl mt-2"
    extra={<Button size="small" aria-label="刷新模板列表" disabled={working} onClick={() => void reload()}>刷新</Button>}>
    <Space direction="vertical" size="small" className="w-full">
      <Alert type="info" showIcon message="点击「使用」只把模板预填到输入框，占位会高亮提示补填，不会自动发送；新建模板默认私有，仅本人可见可用。"
        role="note" />
      {loadError && <Alert type="error" showIcon role="alert" message={`模板列表不可用：${loadError}`} />}
      {saveError && <Alert type="error" showIcon role="alert" message={saveError} />}
      <Card size="small" type="inner" title="新建模板">
        <Space direction="vertical" size="small" className="w-full">
          <Space wrap>
            <Input aria-label="模板名称" placeholder="名称" value={create.name} maxLength={200}
              style={{ width: 220 }} disabled={working}
              onChange={(event) => setCreate({ ...create, name: event.target.value })} />
            <Input aria-label="模板分类" placeholder="自定义分类（可留空）" value={create.category} maxLength={64}
              style={{ width: 220 }} disabled={working}
              onChange={(event) => setCreate({ ...create, category: event.target.value })} />
          </Space>
          <Input.TextArea aria-label="模板内容" value={create.content} maxLength={16000}
            autoSize={{ minRows: 3, maxRows: 10 }} disabled={working}
            placeholder="提示词内容，可用 {{变量}} 占位，使用时提示补填"
            onChange={(event) => setCreate({ ...create, content: event.target.value })} />
          <VariableChips content={create.content} label="新建模板变量占位" />
          <Button type="primary" aria-label="创建模板" loading={working}
            disabled={!create.name.trim() || !create.content.trim()} onClick={() => void send()}>创建</Button>
        </Space>
      </Card>
      <Space wrap aria-label="分类筛选">
        <Typography.Text type="secondary" className="text-xs">分类：</Typography.Text>
        <Select aria-label="按分类筛选" value={category} style={{ width: 160 }} onChange={setCategory}
          disabled={working} notFoundContent="无自定义分类">
          <Select.Option value="">全部（含未分类）</Select.Option>
          {categories.map((item) => <Select.Option key={item} value={item}>{item}</Select.Option>)}
        </Select>
      </Space>
      {(rows ?? []).length === 0 && !loadError && <Empty description="还没有模板，先在上方创建一条" />}
      {visible.map((row) => <Card size="small" type="inner" key={row.id} title={row.name}
        extra={<Space size={4}>
          <Button size="small" type="primary" ghost aria-label={`使用 ${row.name}`} icon={<SendOutlined />}
            disabled={working} onClick={() => void use(row)}>使用</Button>
          <Button size="small" aria-label={`编辑 ${row.name}`} icon={<EditOutlined />}
            disabled={working} onClick={() => setEdit({ id: row.id, name: row.name, category: row.category, content: row.content })} />
          <Button size="small" danger aria-label={`删除 ${row.name}`} icon={<DeleteOutlined />}
            disabled={working} onClick={() => void remove(row)} />
        </Space>}>
        <Space direction="vertical" size={4} className="w-full">
          <Space size={8} wrap>
            <Tag>{row.category || uncategorized}</Tag>
            <Tag>{VISIBILITY_LABELS[row.visibility] ?? row.visibility}</Tag>
            <Typography.Text type="secondary" className="text-xs">{`使用 ${row.usageCount} 次`}</Typography.Text>
            <Typography.Text type="secondary" className="text-xs">{row.updatedAt.slice(0, 19).replace('T', ' ')}</Typography.Text>
          </Space>
          <Typography.Paragraph className="mb-0" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {row.content}
          </Typography.Paragraph>
          <VariableChips content={row.content} label={`${row.name} 变量占位`} />
        </Space>
      </Card>)}
      {edit && <Card size="small" type="inner" title="编辑模板">
        <Space direction="vertical" size="small" className="w-full">
          <Space wrap>
            <Input aria-label="编辑模板名称" placeholder="名称" value={edit.name} maxLength={200}
              style={{ width: 220 }} disabled={working}
              onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
            <Input aria-label="编辑模板分类" placeholder="自定义分类（可留空）" value={edit.category} maxLength={64}
              style={{ width: 220 }} disabled={working}
              onChange={(event) => setEdit({ ...edit, category: event.target.value })} />
          </Space>
          <Input.TextArea aria-label="编辑模板内容" value={edit.content} maxLength={16000}
            autoSize={{ minRows: 3, maxRows: 10 }} disabled={working}
            onChange={(event) => setEdit({ ...edit, content: event.target.value })} />
          <VariableChips content={edit.content} label="编辑模板变量占位" />
          <Space>
            <Button type="primary" aria-label="保存模板" loading={working}
              disabled={!edit.name.trim() || !edit.content.trim()} onClick={() => void save()}>保存</Button>
            <Button aria-label="取消编辑" disabled={working} onClick={() => setEdit(null)}>取消</Button>
          </Space>
        </Space>
      </Card>}
    </Space>
  </Card>
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const names: Record<string, string> = {
    TEMPLATE_UNAUTHENTICATED: '尚未登录平台账号',
    TEMPLATE_COMMAND_INVALID: '命令未通过安全校验',
    TEMPLATE_BUSY: '上一条模板操作仍在进行，请稍后重试',
    TEMPLATE_TIMEOUT: '平台响应超时，请稍后重试',
    TEMPLATE_FAILED: '模板操作失败',
    TEMPLATE_CANCELED: '已取消',
    CHAT_NOT_FOUND: '平台暂未提供模板服务，或这条模板已不存在',
    CHAT_FORBIDDEN: '没有这条模板的操作权限',
    CHAT_IDENTITY_CHANGED: '登录身份已变化，请重新登录后再试'
  }
  return names[message] ?? `操作失败（${message.slice(0, 80)}）`
}

export default TemplatesSection
