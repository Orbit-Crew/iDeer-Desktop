import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from './update-filesystem'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { controlledBytes, controlledDownload, controlledOrigin } from './controlled-http'
import { MAX_MANIFEST_BYTES, verifyUpdate, type PendingUpdate, type UpdateCurrent, type UpdateVerification } from './updates'

export interface StagedUpdate {
  id: string
  stageRoot: string
  payloadRoot: string
  installerPath?: string
  pending: PendingUpdate
}

/** Reject reparse points in every component, including the chosen release root. */
export function regularUpdateFile(base: string, path: string): string {
  const target = resolve(base, path)
  const rel = relative(resolve(base), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('UPDATE_FILE_OUTSIDE_PROGRAM_DIRECTORY')
  let current = resolve(base)
  if (lstatSync(current).isSymbolicLink()) throw new Error('UPDATE_REPARSE_POINT_REJECTED')
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('UPDATE_REPARSE_POINT_REJECTED')
  }
  if (!statSync(target).isFile() || relative(realpathSync(base), realpathSync(target)).startsWith('..')) throw new Error('UPDATE_FILE_INVALID')
  return target
}

function textFile(base: string, path: string, limit: number): string {
  const target = regularUpdateFile(base, path)
  if (statSync(target).size > limit) throw new Error('UPDATE_MANIFEST_TOO_LARGE')
  return readFileSync(target, 'utf8')
}

function copyVerified(source: string, target: string | null, expected: { sha256: string; bytes: number }): void {
  if (statSync(source).size !== expected.bytes) throw new Error('UPDATE_PAYLOAD_SIZE_MISMATCH')
  const input = openSync(source, 'r')
  const output = target ? openSync(target, 'wx', 0o600) : null
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null)
      if (!count) break
      bytes += count
      if (bytes > expected.bytes) throw new Error('UPDATE_PAYLOAD_SIZE_MISMATCH')
      const chunk = buffer.subarray(0, count)
      hash.update(chunk)
      if (output !== null) {
        let written = 0
        while (written < count) written += writeSync(output, chunk, written, count - written)
      }
    }
    if (bytes !== expected.bytes) throw new Error('UPDATE_PAYLOAD_SIZE_MISMATCH')
    if (hash.digest('hex') !== expected.sha256) throw new Error('UPDATE_PAYLOAD_HASH_MISMATCH')
    if (output !== null) fsyncSync(output)
  } finally { closeSync(input); if (output !== null) closeSync(output) }
}

function durableText(path: string, text: string): void {
  const file = openSync(path, 'wx', 0o600)
  try { writeFileSync(file, text, 'utf8'); fsyncSync(file) } finally { closeSync(file) }
}

/** One pending release, shared by online and offline entry points. */
export class UpdateService {
  private active: StagedUpdate | null = null
  private generation = 0
  private controller: AbortController | null = null
  constructor(private readonly options: { directory: string; publicKeyPem: string; current(): UpdateCurrent; timeoutMs?: number }) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    if (lstatSync(options.directory).isSymbolicLink()) throw new Error('UPDATE_REPARSE_POINT_REJECTED')
  }

  get staged(): StagedUpdate | null { return this.active ? structuredClone(this.active) : null }

  restore(): UpdateVerification {
    try {
      const pointer = JSON.parse(textFile(this.options.directory, 'pending.json', 256)) as { id: string; source: 'online' | 'offline' }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pointer.id) ||
          !['online', 'offline'].includes(pointer.source)) throw new Error('UPDATE_STAGE_INVALID')
      const stageRoot = join(this.options.directory, 'stage-' + pointer.id)
      const verified = verifyUpdate(textFile(stageRoot, 'manifest.json', MAX_MANIFEST_BYTES),
        textFile(stageRoot, 'manifest.sig', 256).trim(), this.options.publicKeyPem, this.options.current(), pointer.source)
      if (!verified.pending) throw new Error(verified.error)
      this.active = { id: pointer.id, stageRoot, payloadRoot: join(stageRoot, 'payload'), pending: verified.pending,
        installerPath: verified.pending.kind === 'full' ? join(stageRoot, 'installer.exe') : undefined }
      this.validateStaged()
      return { ok: true, error: '', pending: this.active!.pending }
    } catch (error) {
      this.cancel()
      return { ok: false, error: existsSync(join(this.options.directory, 'pending.json')) ? 'UPDATE_STAGE_INVALID' :
        String(error instanceof Error ? error.message : error), pending: null }
    }
  }

  /** Recheck immutable signed facts immediately before handing a stage to installation. */
  validateStaged(): StagedUpdate {
    try { return this.verifiedStage() } catch (error) { this.cancel(); throw error }
  }

  /** Local view refresh never cancels, fetches or discards a staged release. */
  readStaged(): UpdateVerification {
    if (!this.active) return { ok: true, error: '', pending: null }
    try { return { ok: true, error: '', pending: this.verifiedStage().pending } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'UPDATE_STAGE_INVALID', pending: null } }
  }

  private verifiedStage(): StagedUpdate {
    const stage = this.active
    if (!stage) throw new Error('UPDATE_NOT_STAGED')
      const verified = verifyUpdate(textFile(stage.stageRoot, 'manifest.json', MAX_MANIFEST_BYTES),
        textFile(stage.stageRoot, 'manifest.sig', 256).trim(), this.options.publicKeyPem, this.options.current(), stage.pending.source)
      if (!verified.pending) throw new Error(verified.error)
      for (const file of verified.pending.manifest.files) copyVerified(regularUpdateFile(stage.payloadRoot, file.path), null, file)
      if (verified.pending.manifest.installer) copyVerified(regularUpdateFile(stage.stageRoot, 'installer.exe'), null, verified.pending.manifest.installer)
      return structuredClone(stage)
  }

  cancel(): UpdateVerification {
    this.generation++
    this.controller?.abort()
    this.controller = null
    if (this.active) rmSync(this.active.stageRoot, { recursive: true, force: true })
    this.active = null
    rmSync(join(this.options.directory, 'pending.json'), { force: true })
    return { ok: false, error: 'UPDATE_IMPORT_CANCELED', pending: null }
  }

  async check(origin: string): Promise<UpdateVerification> {
    return this.stage('online', async (signal) => {
      controlledOrigin(origin)
      const text = (await controlledBytes(origin, '/updates/desktop/manifest.json',
        { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: this.options.timeoutMs, signal })).toString('utf8')
      const signature = (await controlledBytes(origin, '/updates/desktop/manifest.sig',
        { maxBytes: 256, timeoutMs: this.options.timeoutMs, signal })).toString('utf8').trim()
      return { text, signature }
    }, async (entry, destination, signal) => {
      const path = entry.path === 'installer.exe' ? '/updates/desktop/installer.exe' : '/updates/desktop/files/' + entry.path
      const actual = await controlledDownload(origin, path, destination,
        { maxBytes: entry.bytes, timeoutMs: this.options.timeoutMs, signal })
      if (actual.bytes !== entry.bytes) throw new Error('UPDATE_PAYLOAD_SIZE_MISMATCH')
      if (actual.sha256 !== entry.sha256) throw new Error('UPDATE_PAYLOAD_HASH_MISMATCH')
    })
  }

  async import(manifestPath: string | null): Promise<UpdateVerification> {
    if (!manifestPath) return this.cancel()
    if (basename(manifestPath) !== 'manifest.json') {
      this.cancel()
      return { ok: false, error: 'UPDATE_MANIFEST_NAME_INVALID', pending: null }
    }
    const directory = dirname(manifestPath)
    return this.stage('offline', async () => ({ text: textFile(directory, 'manifest.json', MAX_MANIFEST_BYTES),
      signature: textFile(directory, 'manifest.sig', 256).trim() }), async (entry, destination) => {
      copyVerified(regularUpdateFile(entry.path === 'installer.exe' ? directory : join(directory, 'files'), entry.path), destination, entry)
    })
  }

  private async stage(source: 'online' | 'offline', metadata: (signal: AbortSignal) => Promise<{ text: string; signature: string }>,
      payload: (entry: { path: string; sha256: string; bytes: number }, destination: string, signal: AbortSignal) => Promise<void>): Promise<UpdateVerification> {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const id = randomUUID()
    const stageRoot = join(this.options.directory, 'stage-' + id)
    try {
      const { text, signature } = await metadata(controller.signal)
      const verified = verifyUpdate(text, signature, this.options.publicKeyPem, this.options.current(), source)
      if (!verified.pending) return verified
      const pending = verified.pending
      const payloadRoot = join(stageRoot, 'payload')
      mkdirSync(payloadRoot, { recursive: true, mode: 0o700 })
      for (const entry of pending.manifest.files) {
        const destination = join(payloadRoot, entry.path)
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        await payload(entry, destination, controller.signal)
      }
      const installerPath = pending.kind === 'full' ? join(stageRoot, 'installer.exe') : undefined
      if (installerPath && pending.manifest.installer) await payload(pending.manifest.installer, installerPath, controller.signal)
      if (controller.signal.aborted || generation !== this.generation) throw new Error('UPDATE_CANCELED')
      durableText(join(stageRoot, 'manifest.json'), text)
      durableText(join(stageRoot, 'manifest.sig'), signature)
      durableText(join(stageRoot, 'pending.json'), JSON.stringify({ id, source }))
      renameSync(join(stageRoot, 'pending.json'), join(this.options.directory, 'pending.json'))
      this.active = { id, stageRoot, payloadRoot, installerPath, pending }
      return verified
    } catch (error) {
      rmSync(stageRoot, { recursive: true, force: true })
      return { ok: false, error: String(error instanceof Error ? error.message : error).replace('CONTROLLED_', 'UPDATE_'), pending: null }
    } finally { if (generation === this.generation) this.controller = null }
  }
}
