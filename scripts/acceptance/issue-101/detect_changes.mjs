// Invoke the same local backend as GitNexus 1.6.10's CLI, retaining unsliced JSON.
import { writeFileSync, writeSync } from 'node:fs'
import { LocalBackend } from '/home/neowyh/.npm-global/lib/node_modules/gitnexus/dist/mcp/local/local-backend.js'

const [repo, output] = process.argv.slice(2)
const backend = new LocalBackend()
try {
  if (!await backend.init()) throw new Error('No indexed repository available')
  const result = await backend.callTool('detect_changes', { scope: 'all', repo, worktree: repo })
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  writeSync(1, JSON.stringify({ summary: result.summary, partial: result.partial || false,
    truncated: result.truncated || false, error: result.error || null,
    listedSymbols: result.changed_symbols?.length, listedProcesses: result.affected_processes?.length }) + '\n')
  if (result.error || result.partial || result.truncated || !(result.summary?.changed_count > 0)) process.exitCode = 1
} finally {
  await backend.dispose()
}
