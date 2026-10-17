import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/renderer/src/App'

describe('Desktop startup without Server', () => {
  it('shows why tasks are unavailable and offers an exit', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('未连接 Server')
    expect(html).toContain('当前无法登录、聊天或执行本地任务')
    expect(html).toContain('退出应用')
    expect(html).not.toMatch(/办公室|DeepSeek|Ollama|API Key/)
    expect(html).not.toMatch(/<textarea|type="submit"/)
  })
})
