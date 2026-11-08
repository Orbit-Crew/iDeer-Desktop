// Issue 119: regenerate resources/nsis/components.nsh from the checked-in
// component catalog. The generated file is committed, and the test suite pins
// it byte-for-byte — run this after editing resources/components/catalog.json.
//   node scripts/generate-component-nsis.cjs           write the file
//   node scripts/generate-component-nsis.cjs --check   verify only
'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { generateNsis, loadCatalog } = require('./component-catalog.cjs')

const target = resolve(__dirname, '../resources/nsis/components.nsh')
const script = generateNsis(loadCatalog(resolve(__dirname, '..')))
if (process.argv[2] === '--check') {
  if (process.argv.length > 3) throw new Error('usage: generate-component-nsis.cjs [--check]')
  if (readFileSync(target, 'utf8') !== script) {
    console.error('components.nsh is stale — run: npm run components:generate')
    process.exitCode = 1
  } else {
    console.log('components.nsh is up to date with resources/components/catalog.json')
  }
} else {
  if (process.argv.length > 2) throw new Error('usage: generate-component-nsis.cjs [--check]')
  writeFileSync(target, script)
  console.log(`Wrote ${join('resources/nsis/components.nsh')} (${script.length} bytes)`)
}
