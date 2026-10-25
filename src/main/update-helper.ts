import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { durableJSON, readDataFormat } from './recovery'
import { pause, processAlive, runMaintenance, type MaintenanceHost, type MaintenanceTransaction } from './maintenance'

export function nativeMaintenanceHost(options: { stopTimeoutMs?: number } = {}): MaintenanceHost {
  let launched: ChildProcess | null = null
  let runtimePid = 0
  let active: MaintenanceTransaction | null = null
  const waitExit = async (pids: number[], duration: number): Promise<void> => {
    const deadline = Date.now() + duration
    while (pids.some(processAlive)) {
      if (Date.now() > deadline) throw new Error('UPDATE_PROCESS_STOP_UNCONFIRMED')
      await pause(100)
    }
  }
  return {
    async waitStopped(t) {
      active = t
      await waitExit([t.parentPid, ...(t.relatedPids || [])], options.stopTimeoutMs ?? 30000)
      // If a helper was interrupted during verification, a previously launched
      // app must exit through its fixed control channel before any restoration.
      const launchPath = join(t.stageRoot, 'launched.json')
      if (existsSync(launchPath)) {
        const previous = JSON.parse(readFileSync(launchPath, 'utf8'))
        const runtimePath = join(t.stageRoot, 'health-runtime.json')
        const previousRuntime = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, 'utf8')).pid : 0
        if (processAlive(previous.pid)) {
          durableJSON(join(t.stageRoot, 'health-stop.json'), { stop: true })
        }
        await waitExit([previous.pid, previous.runtimePid || previousRuntime], 20000)
      }
    },
    async install(t) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const installer = spawn(t.installerPath!, ['/S', '/D=' + t.programRoot], { env, windowsHide: true, stdio: 'ignore', shell: false })
      await new Promise<void>((resolveExit, reject) => {
        installer.once('error', reject)
        installer.once('exit', code => code === 0 ? resolveExit() : reject(new Error('UPDATE_INSTALLER_EXIT_' + code)))
      })
    },
    async launchAndVerify(t, rollback) {
      active = t
      runtimePid = 0
      for (const name of ['health-response.json', 'health-runtime.json', 'health-stop.json', 'health-accept.json']) rmSync(join(t.stageRoot, name), { force: true })
      const nonce = randomUUID()
      durableJSON(join(t.stageRoot, 'health-request.json'), { nonce, rollback })
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      launched = spawn(t.executable, ['--user-data-dir=' + t.userData, '--ideer-maintenance=' + t.id], {
        cwd: t.programRoot, env, detached: true, windowsHide: true, stdio: 'ignore', shell: false })
      await new Promise<void>((resolveSpawn, reject) => { launched!.once('spawn', resolveSpawn); launched!.once('error', reject) })
      durableJSON(join(t.stageRoot, 'launched.json'), { pid: launched.pid })
      const deadline = Date.now() + 40000
      const responsePath = join(t.stageRoot, 'health-response.json')
      while (!existsSync(responsePath)) {
        if (!launched.pid || !processAlive(launched.pid) || Date.now() > deadline) throw new Error('UPDATE_APPLICATION_START_FAILED')
        await pause(100)
      }
      const health = JSON.parse(readFileSync(responsePath, 'utf8'))
      runtimePid = health.runtimePid
      durableJSON(join(t.stageRoot, 'launched.json'), { pid: launched.pid, runtimePid })
      const expected = rollback ? { desktop: t.current.desktopVersion, electron: t.current.electronVersion, python: t.current.runtimePython,
        asar: t.oldAsarSHA256, lock: t.oldLockSHA256, readers: t.current.readableFormats } : {
        desktop: t.manifest.desktop.version, electron: t.manifest.desktop.electron, python: t.manifest.runtime.python,
        asar: t.manifest.desktop.asarSHA256, lock: t.manifest.runtime.lockSHA256, readers: t.manifest.dataCompatibility.readableFormats }
      const format = readDataFormat(t.userData)
      if (health.nonce !== nonce || health.pid !== launched.pid || health.error || resolve(health.executable || '') !== resolve(t.executable) ||
          health.desktopVersion !== expected.desktop || health.electronVersion !== expected.electron || health.runtimePython !== expected.python ||
          health.asarSHA256 !== expected.asar || health.lockSHA256 !== expected.lock || health.echo !== 'ideer-update-health-v1' ||
          !processAlive(runtimePid) || !expected.readers.includes(format) || health.dataFormat !== format ||
          (!rollback && format !== t.manifest.dataCompatibility.targetFormat)) throw new Error('UPDATE_APPLICATION_HEALTH_MISMATCH')
      durableJSON(join(t.stageRoot, 'health-accept.json'), { nonce })
      launched.unref()
    },
    async stopLaunched() {
      if (!active) return
      const runtimePath = join(active.stageRoot, 'health-runtime.json')
      if (!runtimePid && existsSync(runtimePath)) runtimePid = JSON.parse(readFileSync(runtimePath, 'utf8')).pid
      if (launched?.pid && processAlive(launched.pid)) {
        durableJSON(join(active.stageRoot, 'health-stop.json'), { stop: true })
      }
      await waitExit([launched?.pid || 0, runtimePid], 20000)
    }
  }
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('UPDATE_TRANSACTION_REQUIRED')
  const host = nativeMaintenanceHost()
  const waitStopped = host.waitStopped
  // runMaintenance validates the transaction path and signed manifest before
  // calling the host. Even the readiness write must use those verified facts.
  host.waitStopped = async t => {
    durableJSON(join(t.stageRoot, 'helper-ready.json'), { pid: process.pid })
    await waitStopped(t)
  }
  const result = await runMaintenance(path, host)
  if (result.journalPath) durableJSON(join(dirname(result.journalPath), 'helper-ready.json'), { pid: process.pid })
}
if (process.argv[1]?.endsWith('update-helper.cjs')) void main().catch(() => { process.exitCode = 1 })
