import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Writes content through a random-named staged file and an atomic rename so
 * readers never observe a partial file. Throws the underlying failure; the
 * caller maps it to its own domain error. */
export function atomicWriteFile(destination: string, content: string | Buffer, tempTag: string): void {
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.${tempTag}`)
  let staged = false
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    staged = true
    renameSync(temporary, destination)
    staged = false
  } finally {
    if (staged) { try { unlinkSync(temporary) } catch { /* Preserve the original failure. */ } }
  }
}
