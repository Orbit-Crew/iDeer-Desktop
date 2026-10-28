import { Alert, Button, Card, Space, Typography } from 'antd'
import type { ConnectorCommand, ConnectorView, RuntimeStatus } from '../../../shared/desktop'

export interface ConnectorSectionProps {
  runtime?: RuntimeStatus
  busy: boolean
  error: string
  onCommand: (command: ConnectorCommand) => void
}

const categoryHints: Record<string, string> = {
  CONNECTOR_MANIFEST_INVALID: '组件清单缺失、格式不正确或包含未受支持的配置字段',
  CONNECTOR_PACKAGE_INVALID: '所选目录不是一个可识别的连接器组件包',
  CONNECTOR_ENTRY_INVALID: '组件入口缺失或无效，请核对组件完整性',
  CONNECTOR_VERSION_MISMATCH: '组件要求的运行环境版本高于本机提供版本',
  CONNECTOR_DEPENDENCY_MISSING: '组件声明了本机无法探测的依赖，请先补齐依赖',
  CONNECTOR_IDENTITY_CONFLICT: '平台上同一版本已绑定不同内容，请以真实升级（新版本号）重试',
  CONNECTOR_REGISTRATION_UNAVAILABLE: '平台身份登记未完成，安装已取消且本机未改动',
  CONNECTOR_ALREADY_INSTALLED: '该组件已安装且内容一致',
  CONNECTOR_CANCELED: '已取消，本机与平台均未改动',
  CONNECTOR_NOT_INSTALLED: '该连接器不存在或已移除',
  CONNECTOR_IDENTITY_CHANGED: '登录身份已变化，请刷新后重试',
  CONNECTOR_UNAVAILABLE: 'Runtime 不可用，请先启动并登录',
  CONNECTOR_STORAGE_UNAVAILABLE: '连接器登记存储不可用，状态显示可能不完整'
}

/**
 * Issue 123 Connector 入口：按需把本机的一个组件目录离线安装为受管
 * Connector。目录定位与安装/移除确认都在主进程完成；设备侧先做只读
 * 校验（版本/依赖/入口/包完整性），确认后才登记平台身份（仅名称/版本/
 * 指纹）并生成本机受控配置。命令行、入口与环境不离开本设备，不发布、
 * 不共享、不跨设备同步；其他账号与其他设备不可见也不可运行。
 */
export function ConnectorSection({ runtime, busy, error, onCommand }: ConnectorSectionProps): JSX.Element {
  const rows: ConnectorView[] = runtime?.connectors ?? []
  const hint = categoryHints[error] || '安装未完成：需要已认证会话、已确认的工作目录，且所选目录必须是有效的连接器组件'
  return <Space direction="vertical" className="w-full">
    <Typography.Paragraph>
      把本机的一个组件目录安装为仅本人可用的受管 Connector：本机校验版本、依赖与入口后生成受控配置，
      平台只登记名称、版本与指纹身份。运行绑定与数据目录留在本设备，不会同步为其他设备可运行的配置。
    </Typography.Paragraph>
    <Button
      type="primary"
      loading={busy}
      disabled={busy || !runtime || runtime.process !== 'running'}
      onClick={() => onCommand({ action: 'install' })}
    >安装本地连接器组件…</Button>
    {error && <Alert type="error" message={hint} />}
    {runtime?.connectorStorageError && <Alert type="error" message={categoryHints[runtime.connectorStorageError] ?? '连接器登记存储不可用'} />}
    {!rows.length && <Typography.Text type="secondary">当前账号与设备尚无已安装的连接器。</Typography.Text>}
    {rows.map(row => <Card key={row.slug} size="small">
      <Typography.Paragraph>
        {row.displayName}（{row.slug}） · 版本 {row.version} · 入口 {row.entry}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">已安装 · {row.createdAt}</Typography.Paragraph>
      <Typography.Paragraph copyable className="!mb-2">清单指纹：{row.manifestHash}</Typography.Paragraph>
      <Button
        danger
        disabled={busy || !runtime || runtime.process !== 'running'}
        onClick={() => onCommand({ action: 'remove', slug: row.slug })}
      >移除此连接器…</Button>
    </Card>)}
  </Space>
}
