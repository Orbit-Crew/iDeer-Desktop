import { useEffect } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ErrorBoundary } from './components/ErrorBoundary'
import AppLayout from './components/Layout/AppLayout'

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
