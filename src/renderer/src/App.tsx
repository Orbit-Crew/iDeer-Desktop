import { useEffect } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ErrorBoundary } from './components/ErrorBoundary'
import AppLayout from './components/Layout/AppLayout'
import { collectPanes, useDockStore } from './dock/dockStore'
import { saveLayout } from './dock/persistence'
import { useUIStore } from './stores/uiStore'

/** 布局只剩锚点而开关仍点亮时收起开关，避免"点亮却无窗格可展示" */
function reconcileCompanionVisibility(): void {
  const layout = useDockStore.getState().layout
  if (!collectPanes(layout).some((p) => !p.anchor) && useUIStore.getState().companionPanesVisible) {
    useUIStore.getState().setCompanionPanesVisible(false)
  }
}

export default function App(): JSX.Element {
  useEffect(() => {
    const preventDefault = (event: DragEvent): void => event.preventDefault()
    document.addEventListener('dragover', preventDefault)
    document.addEventListener('drop', preventDefault)
    return () => {
      document.removeEventListener('dragover', preventDefault)
      document.removeEventListener('drop', preventDefault)
    }
  }, [])

  // 布局变更时持久化（仅在 layout 引用变化时写入；paneRects 等瞬态字段不触发）。
  // 启动时校准伴随窗格开关；关闭最后一个辅助窗格后自动置回隐藏态。
  useEffect(() => {
    reconcileCompanionVisibility()
    return useDockStore.subscribe((state, prev) => {
      if (state.layout !== prev.layout) {
        saveLayout(state.layout)
        reconcileCompanionVisibility()
      }
    })
  }, [])

  return (
    <ConfigProvider locale={zhCN} theme={{ token: {
      colorPrimary: '#1E6FCC', colorInfo: '#1E6FCC', colorBorder: '#E4E8F0',
      colorBgLayout: '#F4F6FA', colorText: '#1F2329', colorTextSecondary: '#4E5566',
      borderRadius: 8, controlHeight: 32,
      fontFamily: 'Inter, "HarmonyOS Sans SC", "思源黑体", "PingFang SC", "Microsoft YaHei", sans-serif'
    } }}>
      <ErrorBoundary><AppLayout /></ErrorBoundary>
    </ConfigProvider>
  )
}
