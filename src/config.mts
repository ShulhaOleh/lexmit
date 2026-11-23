import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const CONFIG_FILE = 'lexmit.config.json'

type LexmitConfig = {
    historyBaseline: string
    localeDir: string
    readme: string
    statusAssetDir: string
    contributorsFile: string
    translationGuide: string
    maintainers: string[]
}

const CONFIG_KEYS = [
    'historyBaseline',
    'localeDir',
    'readme',
    'statusAssetDir',
    'contributorsFile',
    'translationGuide',
    'maintainers',
] as const

// The config sits at the Git repository root and commands may run from any directory below it.
function findRepositoryRoot(start: string) {
    let dir = resolve(start)
    while (!existsSync(join(dir, CONFIG_FILE))) {
        const parent = dirname(dir)
        if (parent === dir) {
            throw new Error(`${CONFIG_FILE} was not found in ${start} or any parent directory`)
        }
        dir = parent
    }
    return dir
}

// Every path is compared as a Git path, against git show and git diff output, so it has to be
// repository relative with forward slashes and no dot segments, or nothing would ever match it.
function parseRepositoryPath(key: string, value: unknown) {
    if (typeof value !== 'string' || value === '') {
        throw new Error(`${CONFIG_FILE}: ${key} must be a non-empty string`)
    }
    const segments = value.split('/')
    if (
        value.includes('\\') ||
        value.startsWith('/') ||
        /^[A-Za-z]:/u.test(value) ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
        throw new Error(
            `${CONFIG_FILE}: ${key} must be a repository relative path with forward slashes, got ${JSON.stringify(value)}`
        )
    }
    return value
}

// Acceptance reconstruction starts at the audited baseline. Pre-baseline events create no
// review debt. Rewriting repository history requires a new audit, never a guessed baseline,
// so only a full commit id is accepted.
function parseBaseline(value: unknown) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
        throw new Error(`${CONFIG_FILE}: historyBaseline must be a full 40 character commit id`)
    }
    return value
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u

// Accounts listed here are treated like repository admins when crediting translators. GitHub
// logins are case-insensitive, so two entries that differ only in case are duplicates.
function parseMaintainers(value: unknown) {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
        throw new Error(`${CONFIG_FILE}: maintainers must be an array of GitHub logins`)
    }
    const seen = new Set<string>()
    for (const login of value) {
        if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) {
            throw new Error(
                `${CONFIG_FILE}: maintainers must hold GitHub logins, got ${JSON.stringify(login)}`
            )
        }
        if (seen.has(login.toLowerCase())) {
            throw new Error(`${CONFIG_FILE}: maintainers lists ${login} more than once`)
        }
        seen.add(login.toLowerCase())
    }
    return value as string[]
}

export function parseConfig(text: string): LexmitConfig {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${CONFIG_FILE} must hold a JSON object`)
    }
    const unknownKeys = Object.keys(raw).filter(
        (key) => !(CONFIG_KEYS as readonly string[]).includes(key)
    )
    if (unknownKeys.length > 0) {
        throw new Error(`${CONFIG_FILE}: unknown key(s) ${unknownKeys.join(', ')}`)
    }
    const fields = raw as Record<string, unknown>
    const config = {
        historyBaseline: parseBaseline(fields.historyBaseline),
        localeDir: parseRepositoryPath('localeDir', fields.localeDir),
        readme: parseRepositoryPath('readme', fields.readme),
        statusAssetDir: parseRepositoryPath('statusAssetDir', fields.statusAssetDir),
        contributorsFile: parseRepositoryPath('contributorsFile', fields.contributorsFile),
        translationGuide: parseRepositoryPath('translationGuide', fields.translationGuide),
        maintainers: parseMaintainers(fields.maintainers),
    }
    // Every JSON file directly inside localeDir is read as a language.
    if (config.contributorsFile.startsWith(`${config.localeDir}/`)) {
        throw new Error(`${CONFIG_FILE}: contributorsFile must be outside localeDir`)
    }
    return config
}

export type ResolvedConfig = LexmitConfig & { root: string; i18nDir: string }

export function loadConfig(start: string): ResolvedConfig {
    const root = findRepositoryRoot(start)
    const config = parseConfig(readFileSync(join(root, CONFIG_FILE), 'utf8'))
    return { ...config, root, i18nDir: resolve(root, config.localeDir) }
}

let current: ResolvedConfig | undefined

// Loaded on first use, not on import. Importing the runtime helpers, or a test that passes
// every path itself, must work with no config file.
export function lexmitConfig() {
    current ??= loadConfig(process.cwd())
    return current
}
