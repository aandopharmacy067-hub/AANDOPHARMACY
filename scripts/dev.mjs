import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const server = fileURLToPath(new URL('../server/index.js', import.meta.url))
const children = [
	spawn(process.execPath, [server], { stdio: 'inherit', cwd: process.cwd() }),
	spawn(process.execPath, [vite, '--host', '0.0.0.0', ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() }),
]
for (const child of children) child.on('exit', (code) => {
	for (const other of children) if (other !== child) other.kill()
	process.exit(code ?? 0)
})
