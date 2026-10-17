// Adapted from the pinned linz Sidebar. Business navigation is not enabled.
import { DoubleLeftOutlined, RocketOutlined } from '@ant-design/icons'
import { Button, Tag } from 'antd'
import { useUIStore } from '../../stores/uiStore'

export default function Sidebar(): JSX.Element {
  const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel)
  return (
    <aside className="w-[260px] min-w-[260px] h-full flex flex-col border-r border-line bg-white text-gray-700">
      <div className="px-5 py-4 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-card">
          <RocketOutlined className="text-white text-base" />
        </div>
        <span className="text-base font-semibold text-gray-900">iDeer Desktop</span>
        <button onClick={toggleLeftPanel} className="ml-auto p-1.5 text-gray-400 rounded"
          title="隐藏侧边栏" aria-label="隐藏侧边栏">
          <DoubleLeftOutlined style={{ fontSize: 12 }} />
        </button>
      </div>
      <div className="px-5 flex-1">
        <div className="py-2 text-sm text-gray-500">平台连接</div>
        <Tag>未连接</Tag>
        <p className="mt-4 text-xs text-gray-500">接入 Server 后才能使用平台能力。</p>
      </div>
      <div className="px-5 py-4 border-t border-line-light text-xs text-gray-500">
        <p className="mb-3">版本 0.1.0</p>
        <Button block onClick={() => void window.ideer.quit()}>退出应用</Button>
      </div>
    </aside>
  )
}
