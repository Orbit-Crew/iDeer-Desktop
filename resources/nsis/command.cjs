// Shared by the shipped helper and actual NSIS acceptance runners.
const { isAbsolute, resolve } = require('node:path')
function nsisInvocation(installer, programRoot) {
  for (const value of [installer, programRoot]) {
    if (typeof value !== 'string' || !isAbsolute(value) || /["\0\r\n]/.test(value)) throw new Error('UPDATE_INSTALLER_PATH_INVALID')
  }
  const file = resolve(installer)
  return { file, args: ['/S', '/D=' + resolve(programRoot)], options: {
    argv0: '"' + file + '"', windowsVerbatimArguments: true, windowsHide: true, shell: false
  } }
}
module.exports = { nsisInvocation }
