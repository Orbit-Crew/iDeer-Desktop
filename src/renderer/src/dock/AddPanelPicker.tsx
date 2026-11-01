// Add-panel picker from the pinned linz dock (issue 71): a "+" dropdown on
// pane chrome, or an inline grid for an empty pane. Lists registered,
// non-anchor panels; unwired ones stay listed with their honest placeholder.
import { Button, Dropdown } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useDockStore } from './dockStore'
import { PANEL_REGISTRY } from './panelRegistry'
import { getPanelMeta } from './panelMeta'
import type { PanelTypeId } from './types'

interface AddPanelPickerProps {
  paneId: string
  /** inline：在空窗格里渲染居中网格；否则渲染 "+" 下拉 */
  inline?: boolean
  title?: string
}

/** 可添加的面板类型（排除 chat 锚点） */
const ADDABLE = PANEL_REGISTRY.filter((p) => !p.anchorOnly)

export default function AddPanelPicker({
  paneId,
  inline,
  title = '添加面板'
}: AddPanelPickerProps): JSX.Element {
  const openPanel = useDockStore((s) => s.openPanel)
  const pick = (type: PanelTypeId): void => {
    void openPanel(paneId, type)
  }

  if (inline) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6 bg-gray-50">
        <span className="text-sm text-gray-400">空面板</span>
        <div className="grid grid-cols-2 gap-3">
          {ADDABLE.map((p) => (
            <button
              key={p.id}
              onClick={() => pick(p.id)}
              className="w-[150px] h-[96px] rounded-card border border-gray-200 hover:border-primary hover:shadow-md cursor-pointer transition-all flex flex-col items-center justify-center gap-2 bg-white"
            >
              <span className="text-xl text-primary">{p.icon}</span>
              <span className="text-sm font-medium text-gray-800">{getPanelMeta(p.id).title}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const menuItems = ADDABLE.map((p) => ({
    key: p.id,
    label: (
      <span className="flex items-center gap-1.5">
        <span className="text-primary">{p.icon}</span>
        {getPanelMeta(p.id).title}
      </span>
    ),
    onClick: () => pick(p.id)
  }))

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottom">
      <Button size="small" type="text" icon={<PlusOutlined />} title={title} aria-label={title} />
    </Dropdown>
  )
}
