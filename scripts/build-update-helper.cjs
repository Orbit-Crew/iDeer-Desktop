const { buildSync } = require('esbuild')
buildSync({ entryPoints: ['src/main/update-helper.ts'], bundle: true, external: ['original-fs'], platform: 'node', format: 'cjs', target: 'node16', outfile: 'out/main/update-helper.cjs' })
