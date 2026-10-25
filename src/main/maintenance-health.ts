import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableJSON, readDataFormat, sha256File } from './recovery'
import { pause, type MaintenanceTransaction } from './maintenance'
import type { RuntimeProcess } from './runtime'

/** The app answers only the fixed maintenance handshake in its own staged profile. */
export async function serveMaintenanceHealth(options: { id: string; userData: string; executable: string;
    desktopVersion: string; electronVersion: string; runtime: RuntimeProcess; quit(): Promise<void> }): Promise<void> {
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
  // Stay fenced until the out-of-process helper verifies actual hashes and health.
  for (;;) {
    if (existsSync(join(stage, 'health-stop.json'))) {
      await options.runtime.stopForInstall()
      await options.quit()
      return
    }
    if (existsSync(join(stage, 'health-accept.json'))) {
      const acceptance = JSON.parse(readFileSync(join(stage, 'health-accept.json'), 'utf8'))
      if (acceptance.nonce !== request.nonce) throw new Error('UPDATE_HEALTH_NONCE_INVALID')
      await options.runtime.installDrain('abort')
      return
    }
    await pause(100)
  }
}
