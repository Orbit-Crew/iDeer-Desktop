// Issue 73: the model settings page, restored to the original settings
// entry. The content follows the decision record: the platform's authorized
// model list, the account-level default (the same setting the Web writes),
// and the 备用模型 pick. Provider/Base URL/API-Key inputs and an Ollama
// section do not exist here — their absence is stated in place, not hidden.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Modal, Select, Space, Typography } from 'antd'
import type { ModelCommand, ModelSettingsView } from '../../../../shared/desktop'

export const MODEL_ABSENCE_NOTES = [
  '不提供供应商、Base URL 或 API Key 输入：模型凭据全部保存在平台侧，桌面不持有任何模型密钥。',
  'Ollama 等本机模型本期不接入：设备上不存在推理路径，此处原位说明该能力缺席。'
] as const

export function ModelSettingsSection({ view, busy, error, onCommand }: {
  view: ModelSettingsView | null
  busy: boolean
  error: string
  onCommand: (command: ModelCommand) => void
}): JSX.Element {
  const options = (view?.models ?? []).map((row) => ({
    value: row.name, label: `${row.displayName || row.name}${row.description ? ` · ${row.description}` : ''}`
  }))
  return <Space direction="vertical" size="middle" className="w-full">
    {error && <Alert type="error" showIcon message={`模型设置不可用：${error}`} />}
    {!view && !error && <Typography.Text type="secondary">正在读取平台授权模型…</Typography.Text>}
    {view && <>
      {!view.canRead && <Alert type="warning" showIcon message="当前账号没有平台模型目录的读取权限"
        description="模型列表来自平台按权限过滤的授权目录；无法读取时不能选择模型，新会话将使用平台默认模型。" />}
      {view.canRead && <>
        <div>
          <Typography.Paragraph className="mb-1">账号默认模型</Typography.Paragraph>
          <Select aria-label="账号默认模型" className="w-full" placeholder="未选择时使用平台默认"
            value={view.accountDefault || undefined} allowClear disabled={busy}
            options={options}
            onChange={(name) => onCommand({ action: 'set-default', modelName: name ?? '' })} />
          <Typography.Text type="secondary">写入账号级默认偏好（与 Web 端同一设置）；新会话默认使用，原会话可在聊天中临时切换。</Typography.Text>
        </div>
        <div>
          <Typography.Paragraph className="mb-1">备用模型</Typography.Paragraph>
          <Select aria-label="备用模型" className="w-full" placeholder="不设置备用模型"
            value={view.fallback || undefined} allowClear disabled={busy}
            options={options.filter((option) => option.value !== view.accountDefault)}
            onChange={(name) => onCommand({ action: 'set-fallback', modelName: name ?? '' })} />
          <Typography.Text type="secondary">
            主模型不可用或调用失败时改用备用模型重试；每次切换都会在会话中明确显示实际使用的模型，绝不静默切换。备用选择保存在本机。
          </Typography.Text>
        </div>
      </>}
      <div>
        <Typography.Paragraph className="mb-1">能力缺席说明</Typography.Paragraph>
        {MODEL_ABSENCE_NOTES.map((note) => <Typography.Paragraph key={note} type="secondary" className="mb-1">{note}</Typography.Paragraph>)}
      </div>
    </>}
  </Space>
}

export default function ModelSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [view, setView] = useState<ModelSettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loadGeneration = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    try {
      const next = await window.ideer.models({ action: 'list' })
      if (generation === loadGeneration.current) { setView(next); setError('') }
    } catch (exception) {
      if (generation === loadGeneration.current) setError(exception instanceof Error ? exception.message : String(exception))
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const onCommand = (command: ModelCommand): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const next = await window.ideer.models(command)
        setView(next); setError('')
      } catch (exception) {
        setError(exception instanceof Error ? exception.message : String(exception))
        void load()
      } finally {
        setBusy(false)
      }
    })()
  }

  return <Modal title="设置" open={open} onCancel={onClose} footer={null} width={640}>
    <Typography.Title level={5}>模型</Typography.Title>
    <ModelSettingsSection view={view} busy={busy} error={error} onCommand={onCommand} />
  </Modal>
}
