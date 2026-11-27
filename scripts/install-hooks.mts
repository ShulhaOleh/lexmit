import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hooksPath = '.githooks'
const gitOptions = { cwd: root, encoding: 'utf8' as const }

function installHooks() {
    if (process.env.CI || !existsSync(join(root, '.git'))) return

    const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], gitOptions)
    if (configured.error) throw configured.error
    if (configured.status === 0) {
        if (configured.stdout.trim() !== hooksPath) {
            console.warn('Lexmit skipped hook setup because core.hooksPath is already configured.')
        }
        return
    }
    if (configured.status !== 1) throw new Error(configured.stderr || 'Could not read Git config')

    const defaultHooks = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
        gitOptions
    ).trim()
    const trackedHook = join(root, hooksPath, 'pre-commit')
    if (existsSync(defaultHooks)) {
        const existing = readdirSync(defaultHooks, { withFileTypes: true }).filter(
            (entry) => !entry.isDirectory() && !entry.name.endsWith('.sample')
        )
        const customHook = existing.find(
            (entry) =>
                entry.name !== 'pre-commit' ||
                !entry.isFile() ||
                !readFileSync(join(defaultHooks, entry.name)).equals(readFileSync(trackedHook))
        )
        if (customHook) {
            console.warn(`Lexmit skipped hook setup because ${customHook.name} already exists.`)
            return
        }
    }

    execFileSync('git', ['config', '--local', 'core.hooksPath', hooksPath], gitOptions)
}

installHooks()
