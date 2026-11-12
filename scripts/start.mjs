import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const builtIndex = fileURLToPath(new URL('../dist/index.html', import.meta.url))
const buildScript = fileURLToPath(new URL('./build.mjs', import.meta.url))
const serverScript = fileURLToPath(new URL('../server/index.js', import.meta.url))

if (!existsSync(builtIndex)) {
  console.log('Frontend build is missing; building the storefront before server startup.')
  const build = spawnSync(process.execPath, [buildScript], { stdio: 'inherit', cwd: projectRoot })
  if (build.status !== 0 || !existsSync(builtIndex)) {
    console.error('Frontend build failed. Configure Render Build Command as `npm ci --include=dev && npm run build`.')
    process.exit(build.status ?? 1)
  }
}

const server = spawn(process.execPath, [serverScript], { stdio: 'inherit', cwd: projectRoot })
server.on('exit', (code) => process.exit(code ?? 0))
