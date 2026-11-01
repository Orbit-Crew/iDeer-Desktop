import { describe, expect, it } from 'vitest'
import { buildMessageMarkdown, buildSessionMarkdown } from '../src/main/chat-export'
import type { ChatSnapshot } from '../src/shared/desktop'

const stateWith = (overrides: Partial<ChatSnapshot>): ChatSnapshot => ({
  scope: 'scope-1',
  resources: [],
  threads: [{ id: 'thread-1', title: '结构计算助手', status: 'idle' }],
  thread: { id: 'thread-1', status: 'idle', agentId: 'agent-1', skillId: '' },
  messages: [],
  events: [],
  stream: 'idle', error: '', lastEventId: '',
  ...overrides
})

const at = new Date('2026-11-01T10:00:00')

describe('session export document (#79)', () => {
  it('renders every interface-visible message with its exact role label and verbatim text', () => {
    const state = stateWith({
      messages: [
        { id: 'm1', role: 'human', text: '你好，请帮我核对这份报告的边界条件', name: '' },
        { id: 'm2', role: 'ai', text: '结果如下：\n```python\nprint(sum([1, 2]))\n```\n计算已完成，公式 $E=mc^2$ 也已核对。', name: '' },
        { id: 'm3', role: 'tool', text: '站点返回 200，摘要共 3 条', name: 'web_search' }
      ]
    })
    const document = buildSessionMarkdown(state, at)
    const human = document.indexOf('## 你')
    const agent = document.indexOf('## Agent')
    const tool = document.indexOf('## 工具 web_search')
    expect(human).toBeGreaterThan(-1)
    expect(agent).toBeGreaterThan(human)
    expect(tool).toBeGreaterThan(agent)
    // Verbatim: the exact message text, unmodified, including markdown source.
    expect(document).toContain('你好，请帮我核对这份报告的边界条件')
    expect(document).toContain('```python\nprint(sum([1, 2]))\n```')
    expect(document).toContain('公式 $E=mc^2$ 也已核对')
    expect(document).toContain('站点返回 200，摘要共 3 条')
  })

  it('titles the document with the thread title and marks the formatting difference honestly', () => {
    const state = stateWith({
      messages: [{ id: 'm1', role: 'ai', text: '回复内容', name: '' }]
    })
    const document = buildSessionMarkdown(state, at)
    expect(document).toContain('# 结构计算助手')
    // The interface shows message text verbatim; the export says so instead of
    // pretending a markdown renderer was applied.
    expect(document).toContain('原样文本')
    expect(document).toContain('代码块、公式与图片按消息原文呈现')
    // Receipts and operational cards are excluded; the note says so.
    expect(document).toContain('不含附件内容、本地任务回执与服务端事件')
    expect(document).toMatch(/导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('falls back to a generic title when the thread is not in the catalog', () => {
    const state = stateWith({ threads: [] })
    expect(buildSessionMarkdown(state, at)).toContain('# 平台会话')
  })

  it('keeps a constructed session free of hidden facts and receipt details', () => {
    const state = stateWith({
      messages: [
        { id: 'human-id-1', role: 'human', text: '请读取授权目录里的数据并写入结果', name: '',
          request: { version: 1, kind: 'human_input_request', source: 'platform-internal-source',
            request_id: 'req-internal-123', question: '需要先确认输出格式，选哪种？', title: '输出格式',
            context: '平台内部说明文字也只到这里', input_mode: 'single_choice',
            options: [{ id: 'opt-1', label: 'CSV', value: 'csv' }, { id: 'opt-2', label: 'Markdown', value: 'md' }] } },
        { id: 'human-id-2', role: 'human', text: 'CSV', name: '', response: { request_id: 'req-internal-123' } },
        { id: 'ai-id-1', role: 'ai', text: '已完成 CSV 输出。', name: '' }
      ],
      events: [{ id: 'evt-internal-9', event: 'task_started', detail: 'internal graph detail {"node":"secret-node"}' }],
      localTasks: [{ task_id: 'task-internal-7', run_id: 'run-internal-7', capability: 'local.files.write',
        logical_target: '/workspace/x', status: 'completed', receipt: { status: 'completed', result_hash: 'deadbeef' } }],
      localConsents: [{ taskId: 'task-internal-7', runId: 'run-internal-7', threadId: 'thread-1',
        requestHash: 'a'.repeat(64), kind: 'file-write', path: 'C:/Users/neo/secret.txt', content: 'SECRET-WRITE-CONTENT' }],
      artifacts: [{ artifact_id: 'att-internal-1', name: 'secret.bin', bytes: 1, sha256: 'b'.repeat(64) }],
      run: { id: 'run-internal-7', status: 'idle', selection: { agent_version: 7 } }
    })
    const document = buildSessionMarkdown(state, at)
    // Visible clarification facts stay (title, question, options, answer marker)…
    expect(document).toContain('输出格式')
    expect(document).toContain('需要先确认输出格式，选哪种？')
    expect(document).toContain('选项：CSV、Markdown')
    expect(document).toContain('（已回答）')
    // …while every internal identity, receipt and hidden payload stays out.
    for (const hidden of ['req-internal-123', 'platform-internal-source', 'SECRET-WRITE-CONTENT',
      'task-internal-7', 'run-internal-7', 'deadbeef', 'evt-internal-9', 'internal graph detail',
      'att-internal-1', 'secret.bin', 'human-id-1', 'ai-id-1', 'a'.repeat(64), 'b'.repeat(64),
      'C:/Users/neo/secret.txt', 'agent_version']) {
      expect(document).not.toContain(hidden)
    }
  })

  it('marks an unanswered clarification as pending', () => {
    const state = stateWith({
      messages: [{ id: 'human-id-1', role: 'human', text: '', name: '',
        request: { version: 1, kind: 'human_input_request', source: 's', request_id: 'req-1',
          question: '继续吗？', input_mode: 'free_text' } }]
    })
    const document = buildSessionMarkdown(state, at)
    expect(document).toContain('需要你的输入')
    expect(document).toContain('继续吗？')
    expect(document).toContain('（待回答）')
    expect(document).not.toContain('（已回答）')
  })

  it('exports exactly one reply with the same verbatim contract', () => {
    const state = stateWith({
      messages: [
        { id: 'human-id-1', role: 'human', text: '帮我总结结论', name: '' },
        { id: 'ai-id-1', role: 'ai', text: '结论：边界条件成立。\n```text\nmax = 42\n```', name: '' },
        { id: 'ai-id-2', role: 'ai', text: '另一条回复，不应出现', name: '' }
      ]
    })
    const reply = state.messages[1]
    const document = buildMessageMarkdown(state, reply, at)
    expect(document).toContain('# 结构计算助手')
    expect(document).toContain('## Agent')
    expect(document).toContain('结论：边界条件成立。\n```text\nmax = 42\n```')
    expect(document).toContain('原样文本')
    expect(document).not.toContain('帮我总结结论')
    expect(document).not.toContain('另一条回复，不应出现')
    expect(document).not.toContain('ai-id-1')
  })
})
