import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Space, Switch, Tag, Typography } from 'antd'
import type { RuntimeStatus, SkillCommand, SkillImportView, SkillPreferenceCommand, SkillPreferencesView, SkillScriptAuthorizationView, SkillScriptCommand, SkillScriptView, SkillTriggerPreferenceView } from '../../../shared/desktop'

const originNames: Record<string, string> = { markdown: 'Markdown', zip: 'ZIP', directory: '目录' }
const statusNames: Record<SkillImportView['status'], string> = {
  imported: '已导入为私有草稿',
  published: '已发布版本副本',
  failed: '失败'
}

export interface SkillSectionProps {
  runtime?: RuntimeStatus
  busy: boolean
  error: string
  onCommand: (command: SkillCommand) => void
  /** Issue 121: injectable for tests; defaults to the real pinned IPC bridge. */
  onPreferences?: (command: SkillPreferenceCommand) => Promise<SkillPreferencesView>
  /** Issue 121: the Server's already-known projection (static render/tests). */
  initialPreferences?: SkillPreferencesView
  /** Issue 122: injectable for tests; defaults to the real pinned IPC bridge. */
  onScriptCommands?: (command: SkillScriptCommand) => Promise<SkillScriptView>
}

interface PreferenceDraft {
  enabled: boolean
  keywords: string
  alwaysInject: boolean
  applicableAgentIds: string
  priority: number
}

const draftOf = (row: SkillTriggerPreferenceView): PreferenceDraft => ({
  enabled: row.enabled,
  keywords: row.keywords.join(', '),
  alwaysInject: row.alwaysInject,
  applicableAgentIds: row.applicableAgentIds.join(', '),
  priority: row.priority
})

const parseList = (value: string): string[] =>
  value.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== '')

/**
 * Issue 120 Skill 入口：把本机的一个 Markdown、ZIP 或目录技能包显式导入为
 * 本人私有的平台技能草稿。设备侧预览展示正文、脚本与引用的完整上传范围，
 * 取消则什么都不上传；确认后按包指纹绑定上传为私有草稿，发布走平台既有的
 * 草稿校验与发布流程取得版本副本。内置技能只读，任何修改都产生新的草稿或
 * 版本；本地草稿不会成为独立可执行渠道，执行始终由平台编排。
 *
 * Issue 121 触发偏好：在同一入口为本人账号的技能配置启用、关键词、始终注入、
 * 适用 Agent 与优先级。配置只经由固定 IPC 通道发往 Server 端点保存；匹配、
 * 可见性/发布/依赖闭包校验与注入全部由 Server 在 Run 准备时完成，桌面端没有
 * 匹配代码，也不驱动模型。
 */
export function SkillSection({ runtime, busy, error, onCommand, onPreferences, initialPreferences, onScriptCommands }: SkillSectionProps): JSX.Element {
  const preferencesApi = onPreferences ?? ((command: SkillPreferenceCommand) => window.ideer.skillPreferences(command))
  const scriptsApi = onScriptCommands ?? ((command: SkillScriptCommand) => window.ideer.skillScripts(command))
  const [rows, setRows] = useState<SkillTriggerPreferenceView[] | null>(initialPreferences ? initialPreferences.skills : null)
  const [loadError, setLoadError] = useState('')
  const [drafts, setDrafts] = useState<Record<string, PreferenceDraft>>({})
  const [working, setWorking] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [scriptGrants, setScriptGrants] = useState<SkillScriptAuthorizationView[]>(runtime?.skillScriptAuthorizations ?? [])
  const [scriptError, setScriptError] = useState('')

  const reload = useCallback(async () => {
    try {
      const view = await preferencesApi({ action: 'list' })
      setRows(view.skills)
      setDrafts(Object.fromEntries(view.skills.map((row) => [row.skillId, draftOf(row)])))
      setLoadError('')
    } catch (exception) {
      setRows([])
      setLoadError(exception instanceof Error ? exception.message : String(exception))
    }
  }, [preferencesApi])

  const reloadScripts = useCallback(async () => {
    try {
      const view = await scriptsApi({ action: 'list' })
      setScriptGrants(view.authorizations)
      setScriptError('')
    } catch (exception) {
      setScriptGrants([])
      setScriptError(exception instanceof Error ? exception.message : String(exception))
    }
  }, [scriptsApi])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { void reloadScripts() }, [reloadScripts])

  const apply = async (command: SkillPreferenceCommand): Promise<void> => {
    setWorking(true)
    setSaveError('')
    try {
      const view = await preferencesApi(command)
      setRows(view.skills)
      setDrafts(Object.fromEntries(view.skills.map((row) => [row.skillId, draftOf(row)])))
    } catch (exception) {
      setSaveError(exception instanceof Error ? exception.message : String(exception))
    } finally {
      setWorking(false)
    }
  }

  const save = (row: SkillTriggerPreferenceView): void => {
    const draft = drafts[row.skillId]
    if (!draft) return
    void apply({
      action: 'set',
      skillId: row.skillId,
      enabled: draft.enabled,
      keywords: parseList(draft.keywords).slice(0, 16),
      alwaysInject: draft.alwaysInject,
      applicableAgentIds: parseList(draft.applicableAgentIds).slice(0, 32),
      priority: draft.priority
    })
  }

  const revokeScriptGrant = async (authorizationId: string): Promise<void> => {
    setWorking(true)
    setScriptError('')
    try {
      const view = await scriptsApi({ action: 'revoke', authorizationId })
      setScriptGrants(view.authorizations)
    } catch (exception) {
      setScriptError(exception instanceof Error ? exception.message : String(exception))
    } finally {
      setWorking(false)
    }
  }

  const rows_ = rows ?? []
  return <>
    <Card className="max-w-3xl mt-2" size="small" title="技能包导入">
      <Typography.Paragraph>
        选择一个 Markdown、ZIP 或目录技能包：先在设备侧预览正文、脚本、引用与指纹，确认后才上传为你的私有平台技能草稿；发布版本需再次确认，走平台既有的草稿校验与发布流程。取消或未确认的包不会上传，本地草稿也不会在设备上执行。
      </Typography.Paragraph>
      <Space className="mb-2">
        <Button aria-label="导入Markdown技能" disabled={busy}
          onClick={() => onCommand({ action: 'import', kind: 'markdown' })}>导入 Markdown 技能…</Button>
        <Button aria-label="导入ZIP技能" disabled={busy}
          onClick={() => onCommand({ action: 'import', kind: 'zip' })}>导入 ZIP 技能…</Button>
        <Button aria-label="导入目录技能" disabled={busy}
          onClick={() => onCommand({ action: 'import', kind: 'directory' })}>导入目录技能…</Button>
      </Space>
      {error && <Alert type="error" message={`技能导入未完成：${error}`} />}
      {runtime?.skillImportStorageError && <Alert type="error" message="技能导入记录存储不可用，状态显示可能不完整" />}
      {!rows_.length && !loadError && <Typography.Text type="secondary">当前账号与设备尚无技能导入记录。</Typography.Text>}
      {(runtime?.skillImports ?? []).map(row => <Card key={row.id} size="small" className="mt-2">
        <Typography.Paragraph>
          {row.status === 'failed' ? `导入失败：${row.errorCode}` : `${row.slug || row.resourceId} · ${statusNames[row.status]}`}
          {row.status !== 'failed' && ` · ${row.fileCount} 个文件（${originNames[row.origin] || row.origin}）`}
        </Typography.Paragraph>
        {row.status === 'published' && <Typography.Paragraph>
          平台版本副本：V{row.version} · <Typography.Text copyable>指纹 {row.contentHash}</Typography.Text>
        </Typography.Paragraph>}
        {row.status === 'imported' && <Typography.Paragraph>
          私有草稿 R{row.revision} · <Typography.Text copyable>包指纹 {row.contentHash}</Typography.Text>
        </Typography.Paragraph>}
        <Typography.Paragraph type="secondary">账号绑定 · {row.createdAt}</Typography.Paragraph>
        {row.status === 'imported' && <Button
          aria-label={`发布技能 ${row.slug || row.resourceId}`}
          disabled={busy}
          onClick={() => onCommand({ action: 'publish', resourceId: row.resourceId, expectedDraftRevision: row.revision })}>发布此草稿为版本副本…</Button>}
        {row.status === 'failed' && <Typography.Paragraph type="secondary">失败后可重新导入；未上传的内容不会保留在平台上。</Typography.Paragraph>}
      </Card>)}
    </Card>
    <Card className="max-w-3xl mt-2" size="small" title="触发偏好（Server 端匹配）">
      <Typography.Paragraph>
        为本人账号的技能配置启用、关键词、始终注入、适用 Agent 与优先级。配置仅保存到 Server；Server 在 Run 准备时按既有规则完成匹配注入（明确选用优先、空关键词始终注入、每次最多注入一个、可见性/发布/依赖闭包重新校验）。桌面端不匹配、不驱动模型；进行中的 Run 不受后续修改影响。
      </Typography.Paragraph>
      {loadError && <Alert type="error" message={`触发偏好不可用：${loadError}`} />}
      {saveError && <Alert type="error" message={`偏好未保存：${saveError}`} />}
      {rows === null && <Typography.Text type="secondary">正在加载触发偏好…</Typography.Text>}
      {rows !== null && !rows_.length && <Typography.Text type="secondary">当前账号尚无技能触发偏好。</Typography.Text>}
      {rows_.map(row => {
        const draft = drafts[row.skillId]
        const set = (patch: Partial<PreferenceDraft>): void =>
          setDrafts((current) => ({ ...current, [row.skillId]: { ...(current[row.skillId] ?? draftOf(row)), ...patch } }))
        return <Card key={row.skillId} size="small" className="mt-2">
          <Typography.Paragraph>
            {row.slug || row.skillId} · {row.available ? <Tag color="green">可用</Tag> : <Tag color="red">不可用</Tag>}
            {row.latestVersion > 0 && ` · 平台版本 V${row.latestVersion}`}
          </Typography.Paragraph>
          <Space direction="vertical" className="w-full" size={4}>
            <Space size={12} wrap>
              <span aria-label={`偏好启用 ${row.slug}`}>启用 <Switch aria-label={`偏好启用开关 ${row.slug}`} checked={draft?.enabled ?? row.enabled} onChange={(checked) => set({ enabled: checked })} /></span>
              <span aria-label={`始终注入 ${row.slug}`}>始终注入 <Checkbox aria-label={`始终注入勾选 ${row.slug}`} checked={draft?.alwaysInject ?? row.alwaysInject} onChange={(event) => set({ alwaysInject: event.target.checked })} /></span>
              <span aria-label={`优先级 ${row.slug}`}>优先级 <InputNumber aria-label={`优先级输入 ${row.slug}`} value={draft?.priority ?? row.priority} min={-1000} max={1000} step={1} onChange={(value) => set({ priority: typeof value === 'number' ? Math.trunc(value) : 0 })} /></span>
            </Space>
            <span aria-label={`关键词 ${row.slug}`}>关键词（逗号分隔，留空则始终注入）
              <Input aria-label={`关键词输入 ${row.slug}`} value={draft?.keywords ?? row.keywords.join(', ')}
                onChange={(event) => set({ keywords: event.target.value })} placeholder="例如：周报, report" />
            </span>
            <span aria-label={`适用Agent ${row.slug}`}>适用 Agent（逗号分隔 UUID，留空则对所有 Agent 生效）
              <Input aria-label={`适用Agent输入 ${row.slug}`} value={draft?.applicableAgentIds ?? row.applicableAgentIds.join(', ')}
                onChange={(event) => set({ applicableAgentIds: event.target.value })} placeholder="留空 = 全部 Agent" />
            </span>
            <Space>
              <Button aria-label={`保存偏好 ${row.slug}`} disabled={working || !draft} onClick={() => save(row)}>保存偏好</Button>
              <Button aria-label={`清除偏好 ${row.slug}`} disabled={working} onClick={() => void apply({ action: 'clear', skillId: row.skillId })}>清除</Button>
            </Space>
          </Space>
        </Card>
      })}
    </Card>
    <Card className="max-w-3xl mt-2" size="small" title="脚本授权（设备本地）">
      <Typography.Paragraph>
        自定义技能脚本默认关闭。每次执行都会先在本机确认；勾选“记住”只对当前脚本内容与声明的环境范围生效——脚本或范围变化会重新询问。撤销后再次执行需要重新批准；目录授权、技能共享和内置身份都不能代替脚本审批。
      </Typography.Paragraph>
      {runtime?.skillScriptStorageError && <Alert type="error" message="脚本授权记录存储不可用，状态显示可能不完整" />}
      {scriptError && <Alert type="error" message={`脚本授权不可用：${scriptError}`} />}
      {!scriptGrants.length && !scriptError && <Typography.Text type="secondary">本机当前没有已记住的技能脚本授权。</Typography.Text>}
      {scriptGrants.map(row => <Card key={row.id} size="small" className="mt-2">
        <Typography.Paragraph>
          {row.slug || row.resourceId} · {row.scriptPath} · V{row.version}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          <Typography.Text copyable>脚本指纹 {row.scriptSha256}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">账号与设备绑定 · {row.createdAt}</Typography.Paragraph>
        <Button aria-label={`撤销脚本授权 ${row.slug || row.resourceId}`} disabled={working}
          onClick={() => void revokeScriptGrant(row.id)}>撤销此授权</Button>
      </Card>)}
    </Card>
  </>
}
