// Layout arrangement button (issue 71): floats over the workspace top-right
// and opens the eight fixed arrangements from the pinned linz dock.
import { useState } from 'react'
import { Popover } from 'antd'
import { LayoutOutlined } from '@ant-design/icons'
import { useUIStore } from '../stores/uiStore'
import { LAYOUT_PRESETS, applyPreset, renderThumb } from './layoutPresets'

/**
 * 预设列表（Popover 内容）：独立导出，便于静态验收渲染八种排布。
 */
export function LayoutPresetList({ onPick }: { onPick?: () => void }): JSX.Element {
  return (
    <div className="w-[232px]">
      <div className="text-xs font-medium text-gray-500 mb-1.5">窗口排布</div>
      <div className="space-y-0.5">
        {LAYOUT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            onClick={() => {
              applyPreset(preset.id)
              onPick?.()
            }}
            className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded transition-colors hover:bg-gray-100 text-left"
            title={preset.description}
          >
            <span className="w-14 h-9 shrink-0">{renderThumb(preset.spec)}</span>
            <span className="text-xs text-gray-700 leading-tight">
              {preset.title}
              <span className="block text-[10px] text-gray-400">{preset.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 布局预设按钮：点击弹出"窗口排布"选择器，供用户挑选一种布局。
 * 选中后应用对应 dock 布局（仅对话 / 对话+右侧工具 / 三栏工作台 / ...）。
 */
export default function LayoutPresetDropdown(): JSX.Element {
  const companionPanesVisible = useUIStore((s) => s.companionPanesVisible)
  const [popOpen, setPopOpen] = useState(false)

  return (
    <Popover
      open={popOpen}
      onOpenChange={setPopOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      zIndex={100}
      content={<LayoutPresetList onPick={() => setPopOpen(false)} />}
    >
      <button
        className={`absolute top-3 right-4 z-20 p-2 rounded transition-colors ${
          companionPanesVisible
            ? 'text-primary bg-primary/10 hover:bg-primary/20'
            : 'text-gray-500 hover:text-primary hover:bg-gray-100'
        }`}
        title="切换窗口排布"
        aria-label="切换窗口排布"
      >
        <LayoutOutlined />
      </button>
    </Popover>
  )
}
