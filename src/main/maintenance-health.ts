import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableJSON, readDataFormat, readRecoveryState, sha256File } from './recovery'
import { pause, type MaintenanceTransaction } from './maintenance'
import { DRAIN_DEADLINE_MS, planDrain } from './installer'
import type { DesktopStatus } from '../shared/desktop'
import type { RuntimeProcess } from './runtime'

export interface MaintenanceSession {
  usable(status: DesktopStatus): Promise<void>
  failed(): void
}

/** Maintenance never force-kills work, even when startup or window loading fails. */
export async function stopMaintenanceRuntime(runtime: RuntimeProcess): Promise<void> {
  let status = runtime.status()
  if (!status.pid && ['stopped', 'missing', 'crashed'].includes(status.process)) return
  const startingDeadline = Date.now() + 15000
  while (status.process !== 'running') {
    if (!status.pid && ['stopped', 'missing', 'crashed'].includes(status.process)) return
    if (Date.now() > startingDeadline) throw new Error('UPDATE_RUNTIME_STOP_UNCONFIRMED')
    await pause(100); status = runtime.status()
  }
  await runtime.installDrain('begin')
  const deadline = Date.now() + DRAIN_DEADLINE_MS
  for (;;) {
    const state = planDrain(runtime.status())
    if (state === 'blocked') throw new Error('UPDATE_RUNTIME_STOP_NOT_SAFE')
    if (state === 'ready') break
    if (Date.now() > deadline) throw new Error('UPDATE_RUNTIME_STOP_UNCONFIRMED')
    await pause(100)
  }
  await runtime.stopForInstall()
}

/** Phase one verifies the interpreter; phase two confirms real window and IPC usability. */
export async function serveMaintenanceHealth(options: { id: string; userData: string; executable: string;
    desktopVersion: string; electronVersion: string; runtime: RuntimeProcess; quit(): Promise<void> }): Promise<MaintenanceSession | null> {
  if (!/^[0-9a-f-]{36}$/.test(options.id)) throw new Error('UPDATE_HEALTH_ID_INVALID')
  const stage = join(options.userData, 'Updates', 'stage-' + options.id)
  const t = JSON.parse(readFileSync(join(stage, 'transaction.json'), 'utf8')) as MaintenanceTransaction
  if (t.id !== options.id || resolve(t.userData) !== resolve(options.userData) || resolve(t.executable) !== resolve(options.executable)) throw new Error('UPDATE_HEALTH_BINDING_INVALID')
  const request = JSON.parse(readFileSync(join(stage, 'health-request.json'), 'utf8')) as { nonce: string }
  durableJSON(join(stage, 'health-runtime.json'), { pid: options.runtime.status().pid || 0 })
  const deadline = Date.now() + 15000
  while (options.runtime.status().process !== 'running') {
    if (Date.now() > deadline) throw new Error('UPDATE_RUNTIME_START_FAILED')
    await pause(100)
  }
  const health = await options.runtime.health()
  const status = options.runtime.status()
  if (!status.installDrain || status.activeTasks !== 0 || status.receiptStorageError) throw new Error('UPDATE_HEALTH_NOT_DRAINED')
  durableJSON(join(stage, 'health-response.json'), { nonce: request.nonce, pid: process.pid, executable: options.executable,
    desktopVersion: options.desktopVersion, electronVersion: options.electronVersion, runtimePython: health.python,
    runtimePid: health.pid, echo: health.echo, dataFormat: readDataFormat(options.userData),
    asarSHA256: sha256File(join(t.programRoot, 'resources/app.asar')),
    lockSHA256: sha256File(join(t.programRoot, 'resources/runtime/distribution.lock.json')) })
  for (;;) {
    if (existsSync(join(stage, 'health-stop.json'))) {
      await stopMaintenanceRuntime(options.runtime); await options.quit(); return null
    }
    if (existsSync(join(stage, 'health-accept.json'))) {
      const acceptance = JSON.parse(readFileSync(join(stage, 'health-accept.json'), 'utf8'))
      if (acceptance.nonce !== request.nonce) throw new Error('UPDATE_HEALTH_NONCE_INVALID')
      await options.runtime.installDrain('abort')
      const unfenceDeadline = Date.now() + 15000
      while (options.runtime.status().process !== 'running' || options.runtime.status().installDrain !== false) {
        if (Date.now() > unfenceDeadline) throw new Error('UPDATE_RUNTIME_UNFENCE_UNCONFIRMED')
        await pause(100)
      }
      break
    }
    await pause(100)
  }
  const failed = (): void => durableJSON(join(stage, 'health-error.json'), { nonce: request.nonce, error: 'UPDATE_DESKTOP_NOT_USABLE' })
  // Keep the safe stop channel alive after accept, until the helper commits
  // updated/rolled-back. A window failure must still be recoverable.
  void (async () => {
    for (;;) {
      if (existsSync(join(stage, 'health-stop.json'))) {
        await stopMaintenanceRuntime(options.runtime); await options.quit(); return
      }
      const state = readRecoveryState(options.userData)?.state
      if (state === 'updated' || state === 'rolled-back' || state === 'recovery-failed') return
      await pause(100)
    }
  })().catch(failed)
  return {
    failed,
    async usable(observed) {
      const current = options.runtime.status()
      const echo = await options.runtime.health()
      if (observed.version !== options.desktopVersion || observed.runtime.process !== 'running' || observed.runtime.pid !== echo.pid ||
          current.process !== 'running' || current.installDrain !== false || current.receiptStorageError || echo.echo !== 'ideer-update-health-v1') throw new Error('UPDATE_DESKTOP_IPC_NOT_USABLE')
      durableJSON(join(stage, 'health-usable.json'), { nonce: request.nonce, pid: process.pid, runtimePid: echo.pid,
        desktopVersion: observed.version, windowLoaded: true, rendererReady: true, ipcReady: true, runtimeUnfenced: true, echo: echo.echo })
    }
  }
}
