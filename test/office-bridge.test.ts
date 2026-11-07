// Issue 112: the office pane's bridge contract. The pane is a read-only
// observer of the platform's Run/subagent projection: it rides the existing
// trusted chat state read, gains no channel of its own, and no control knob
// can ride the state shape — the security seam (test/security.test.ts) stays
// untouched because the office adds zero IPC surface.
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('office bridge contract (#112)', () => {
  it('rides the existing read-only state command and rejects broadened shapes', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-112/unused')
    // The office pane's only command — a plain state read — is a valid chat
    // command that fails solely because no Runtime is running.
    await expect(runtime.chat({ action: 'state' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    // No control knob may ride the state read: any extra key is a broadened
    // shape and is rejected before any process starts.
    for (const patch of [{ control: 'dispatch' }, { manage: true }, { dispatch: [] }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'state', ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it('keeps the office pane graph free of any surface beyond the chat state read', async () => {
    const result = await build({
      entryPoints: ['src/renderer/src/dock/panels/officePane.tsx'],
      bundle: true,
      packages: 'external',
      platform: 'node',
      outdir: 'out/security-check',
      write: false
    })
    const text = result.outputFiles.map((file) => file.text).join('')
    // The one bridge touch is the read-only chat state read the conversation
    // already uses — no other bridge method, no channel naming, no push
    // subscription, no embedded-content seam ever appears in this graph.
    expect(text).toMatch(/window\.ideer\.chat/)
    expect(text).not.toMatch(/window\.ideer\.(?!chat\b)/)
    expect(text).not.toMatch(/ipcRenderer|sendToHost|openExternal|webview|\.send\(/)
    expect(text).not.toMatch(/invoke\(|\.on\(/)
  })
})
