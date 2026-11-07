// Issue 113: the Synapse map's bridge contract. The pane is a read-only
// projection of the platform's own Thread rows: it rides the existing
// trusted threads list read plus the conversation's state read, gains no
// channel of its own, and no management knob can ride the list shape —
// opening and branching are session actions that ride the conversation's
// serialized command path through the session store, never the map's own
// bridge calls.
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('synapse bridge contract (#113)', () => {
  it('rides the existing read-only threads list and chat state reads', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-113/unused')
    // The map's one list command — a plain list read — fails only because
    // no Runtime is running.
    await expect(runtime.threads({ action: 'list' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    // No management knob may ride the list read: any extra key is a
    // broadened shape and is rejected before any process starts.
    for (const patch of [{ threadId: 'thread-A' }, { query: 'x' }, { manage: true }]) {
      await expect(runtime.threads({ action: 'list', ...patch } as never)).rejects.toThrow('THREADS_COMMAND_INVALID')
    }
    // The gate observation rides the same read-only state read the
    // conversation and the office pane already perform.
    await expect(runtime.chat({ action: 'state' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it('keeps the map graph free of any surface beyond the two read-only reads', async () => {
    const result = await build({
      entryPoints: ['src/renderer/src/dock/panels/synapsePane.tsx'],
      bundle: true,
      packages: 'external',
      platform: 'node',
      outdir: 'out/security-check',
      write: false
    })
    const text = result.outputFiles.map((file) => file.text).join('')
    // The two bridge touches are the threads list read and the chat state
    // read — no other bridge method, no channel naming, no push
    // subscription, no embedded-content seam ever appears in this graph.
    expect(text).toMatch(/window\.ideer\.threads/)
    expect(text).toMatch(/window\.ideer\.chat/)
    expect(text).not.toMatch(/window\.ideer\.(?!(chat|threads)\b)/)
    expect(text).not.toMatch(/ipcRenderer|sendToHost|openExternal|webview|\.send\(/)
    expect(text).not.toMatch(/invoke\(|\.on\(/)
  })
})
