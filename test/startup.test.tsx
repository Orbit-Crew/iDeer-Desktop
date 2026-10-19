import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/renderer/src/App'

describe('Desktop startup without Server', () => {
  it('shows why tasks are unavailable and offers an exit', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('请先在系统浏览器登录并绑定设备')
    expect(html).toContain('设备连接：')
    expect(html).toContain('尚未配置设备时，任务不可用')
    expect(html).toContain('退出应用')
    expect(html).not.toMatch(/办公室|DeepSeek|Ollama|API Key/)
    expect(html).not.toMatch(/<textarea|type="submit"/)
  })
})
