const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const executable = resolve('artifacts/issue-102/build-final/.runtime/python.exe')
const env = {}
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) {
  if (process.env[key]) env[key] = process.env[key]
}
const content = '中文\r\n第二行🙂\n'
const program = 'import json,sys; value=json.loads(sys.stdin.readline()); print(json.dumps({"stdin":sys.stdin.encoding,"stdout":sys.stdout.encoding,"utf8mode":sys.flags.utf8_mode,"value":value,"has_surrogate":any(0xd800<=ord(c)<=0xdfff for c in value)}))'
const output = []
for (const extra of [[], ['-X', 'utf8']]) {
  const args = ['-I', '-u', ...extra, '-c', program]
  const result = spawnSync(executable, args, { env, input: JSON.stringify(content) + '\n', encoding: 'utf8', windowsHide: true })
  output.push({ executable, args, exitCode: result.status, result: JSON.parse(result.stdout), exact: JSON.parse(result.stdout).value === content })
}
writeFileSync(resolve('artifacts/issue-102/focusedUTF8/probe.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify(output))
