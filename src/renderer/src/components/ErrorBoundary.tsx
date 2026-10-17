import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

// 全局兜底：任意子树渲染抛错（如脏数据里混入对象导致
// "Objects are not valid as a React child"）时，展示可恢复的错误页，
// 而不是整个应用白屏崩溃。数据层会同步把对象规整为字符串，边界只是最后防线。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 捕获到渲染错误：', error, info)
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, error: undefined })
    // 重置状态后重新加载当前路由对应的视图
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen gap-4 p-8 text-center">
          <div className="text-lg font-medium text-gray-800">应用遇到意外错误</div>
          <div className="text-sm text-gray-500 max-w-md break-words">
            {this.state.error?.message || '渲染过程中发生未知错误。重新加载通常可以恢复。'}
          </div>
          <Button type="primary" onClick={this.handleReload}>
            重新加载
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
