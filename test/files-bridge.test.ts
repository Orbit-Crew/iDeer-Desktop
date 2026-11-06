// Issue 94: the human browsing seam's wire gate on the Desktop side. The
// Runtime's own store owns containment; these pin the main-side shape gate
// and its order — action, logical-path shape, then availability — so a
// malformed request never reaches the wire and an unavailable Runtime never
// pretends to browse.
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

function unavailableRuntime(): RuntimeProcess {
  // No child ever starts: every shape-valid call must end unavailable.
  return new RuntimeProcess('does-not-matter', 'does-not-matter')
}

describe('files seam wire gate (issue 94)', () => {
  it('rejects unknown actions before anything else', async () => {
    const runtime = unavailableRuntime()
    await expect(runtime.files('write' as 'list', '/workspace/x')).rejects.toThrow('FILES_ACTION_INVALID')
  })

  it('rejects non-logical paths before checking runtime availability', async () => {
    const runtime = unavailableRuntime()
    // The Runtime's store normalizes empty middle segments itself; the gate
    // here mirrors its real rejections instead of guessing stricter ones.
    const bad = ['relative/path', '', 'C:/tmp', '/a/../b', '/a\\b', '/x\x00y', '/' + 'a'.repeat(4097)]
    for (const path of bad) await expect(runtime.files('list', path)).rejects.toThrow('FILES_PATH_INVALID')
    await expect(runtime.files('read', '/workspace/../escape')).rejects.toThrow('FILES_PATH_INVALID')
  })

  it('keeps a workspace-suffixed colon segment out of the logical space', async () => {
    const runtime = unavailableRuntime()
    await expect(runtime.files('locate', '/workspace/hidden:suffix')).rejects.toThrow('FILES_PATH_INVALID')
  })

  it('answers a shape-valid request with the runtime availability fence', async () => {
    const runtime = unavailableRuntime()
    await expect(runtime.files('list', '/workspace')).rejects.toThrow('WORKSPACE_UNAVAILABLE')
    await expect(runtime.files('read', '/workspace/a.txt')).rejects.toThrow('WORKSPACE_UNAVAILABLE')
    await expect(runtime.files('locate', '/workspace/a.txt')).rejects.toThrow('WORKSPACE_UNAVAILABLE')
  })
})
