#!/usr/bin/env node
// Issue 107 release tooling: build and sign a Desktop update manifest.
// The signing key never enters the repository, the log output or the package:
// it is read from UPDATES_PRIVATE_KEY_PEM (env) or --private-key <file>, and
// this script only writes the manifest and its detached signature.
const fs = require('node:fs')
const path = require('node:path')
const { createPrivateKey, sign } = require('node:crypto')

function main() {
  const args = process.argv.slice(2)
  const flag = name => {
    const index = args.indexOf(name)
    if (index < 0) throw new Error(`missing ${name}`)
    return args[index + 1]
  }
  const manifestPath = path.resolve(flag('--manifest'))
  const outPath = path.resolve(flag('--out'))
  const keyPem = process.env.UPDATES_PRIVATE_KEY_PEM ||
    fs.readFileSync(path.resolve(flag('--private-key')), 'utf8')
  const canonical = fs.readFileSync(manifestPath, 'utf8')
  const signature = sign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(keyPem))
  fs.mkdirSync(outPath, { recursive: true })
  fs.writeFileSync(path.join(outPath, 'manifest.json'), canonical)
  fs.writeFileSync(path.join(outPath, 'manifest.sig'), signature.toString('hex') + '\n')
  console.log('signed manifest written to', outPath)
}

main()
