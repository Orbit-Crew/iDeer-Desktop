import type { ChatCommand, ChatSnapshot } from '../shared/desktop'
import type { RuntimeProcess } from './runtime'
import { createHash, randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Owns the native save step; artifact bytes never enter the renderer. */
export async function downloadThreadArtifact(runtime: Pick<RuntimeProcess, 'chat'>,
  command: Extract<ChatCommand, { action: 'download' }>,
  chooseDestination: (name: string) => Promise<string | undefined>): Promise<ChatSnapshot> {
  const { download, ...view } = await runtime.chat(command)
  if (view.error) return view
  if (!download || view.scope !== command.scope || download.artifact_id !== command.artifactId ||
      !download.name || download.name.length > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(download.name) ||
      !Number.isSafeInteger(download.bytes) || download.bytes < 0 || download.bytes > 65536 ||
      !/^[0-9a-f]{64}$/.test(download.sha256) || typeof download.content !== 'string' ||
      download.content.length > 87384) throw new Error('DOWNLOAD_INVALID')
  const bytes = Buffer.from(download.content, 'base64')
  if (bytes.toString('base64') !== download.content || bytes.length !== download.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== download.sha256) throw new Error('DOWNLOAD_INTEGRITY_FAILED')
  const destination = await chooseDestination(download.name)
  if (!destination) return { ...view, downloadStatus: 'cancelled' }
  // The user may switch accounts while the native dialog is pending. The
  // current Runtime scope includes the device binding and business identity.
  const current = await runtime.chat({ action: 'state' })
  if (current.error || current.scope !== command.scope) throw new Error('DOWNLOAD_IDENTITY_CHANGED')
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.download`)
  let staged = false
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    staged = true
    renameSync(temporary, destination)
    staged = false
  } catch {
    throw new Error('DOWNLOAD_SAVE_FAILED')
  } finally {
    if (staged) { try { unlinkSync(temporary) } catch { /* Preserve the original failure. */ } }
  }
  return { ...current, downloadStatus: 'saved' }
}
