// Retains linz's sidebar width, collapse rail and content layout.
import { DoubleRightOutlined } from '@ant-design/icons'
import { Alert, Card, Typography } from 'antd'
import { useUIStore } from '../../stores/uiStore'
import Sidebar from './Sidebar'

export default function AppLayout(): JSX.Element {
  const leftPanelOpen = useUIStore((state) => state.leftPanelOpen)
  const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel)
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="relative flex-shrink-0 h-full overflow-hidden border-r border-line bg-white"
        style={{ width: leftPanelOpen ? 260 : 20, transition: 'width 0.2s ease-in-out' }}>
        {leftPanelOpen ? <Sidebar /> : (
          <button onClick={toggleLeftPanel} className="w-5 pt-4 text-gray-400"
            title="显示侧边栏" aria-label="显示侧边栏">
            <DoubleRightOutlined style={{ fontSize: 12 }} />
          </button>
        )}
      </div>
      <main className="flex-1 overflow-auto p-10">
        <Typography.Title level={3}>平台连接</Typography.Title>
        <Card className="max-w-3xl mt-6 shadow-card">
          <Typography.Title level={4}>未连接 Server</Typography.Title>
          <Alert type="warning" showIcon message="当前无法登录、聊天或执行本地任务" />
          <Typography.Paragraph className="mt-5">
            此版本尚未接入 iDeer Server。平台能力接入前，任务暂不可用。
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            原 linz 安装和数据保留在原位置，可继续通过原应用查阅。
          </Typography.Paragraph>
        </Card>
      </main>
    </div>
  )
}
