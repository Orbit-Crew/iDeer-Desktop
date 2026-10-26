import * as nodeFs from 'node:fs'

// Electron's patched fs treats app.asar as a directory. Update signatures,
// backups and replacement always operate on the exact archive bytes.
const rawFs: typeof nodeFs = process.versions.electron ? require('original-fs') : nodeFs
export const { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } = rawFs
