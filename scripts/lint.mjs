import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../node_modules/oxlint/dist/cli.js', import.meta.url))
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() })
child.on('exit', (code) => process.exit(code ?? 0))
