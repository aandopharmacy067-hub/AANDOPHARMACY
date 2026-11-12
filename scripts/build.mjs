import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const run = (script, args) => spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: 'inherit', cwd: process.cwd() })
const typecheck = run('../node_modules/typescript/bin/tsc', ['-b'])
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1)
const bundle = run('../node_modules/vite/bin/vite.js', ['build'])
if (bundle.status !== 0) process.exit(bundle.status ?? 1)

const builtIndex = fileURLToPath(new URL('../dist/index.html', import.meta.url))
if (!existsSync(builtIndex)) {
	console.error('Frontend build did not produce dist/index.html; the server cannot serve the application.')
	process.exit(1)
}
