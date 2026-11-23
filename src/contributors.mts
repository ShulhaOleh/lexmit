import type { TranslationContributors } from './readme.mts'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseTargetValue, TARGET_VALUE_KIND } from './runtime.mts'
import { lexmitConfig } from './config.mts'
import { inspectLocales, SOURCE_LOCALE } from './inspection.mts'
import { flattenBundle } from './current.mts'
import { errorMessage } from './io.mts'
import { createGitAdapter } from './git.mts'

type GitHubCommit = {
    sha: string
    parents: { sha: string }[]
    author: { type: string; login: string } | null
}
type FetchCommits = (localeId: string, page: number) => Promise<unknown>
type ReadLocale = (revision: string, localeId: string) => string | undefined
type IsLegacyRevision = (revision: string) => boolean

const PER_PAGE = 100

export function gitLocaleReader(root: string, localeDir: string): ReadLocale {
    return (revision, localeId) => {
        const path = `${localeDir}/${localeId}.json`
        let listed
        try {
            listed = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', path], {
                cwd: root,
                encoding: 'utf8',
            })
        } catch (error) {
            throw new Error(`Could not inspect Git revision '${revision}'`, { cause: error })
        }
        if (listed.trim().length === 0) return undefined
        return execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' })
    }
}

// Before a project adopted lexmit it had no reason to keep every value a non-empty string, and
// credits still cover that history. Arrays, numbers, booleans, null and blank strings are dropped
// there so the strings around them can still be compared. A blank string is not a translation.
function withoutLegacyValues(value: unknown): unknown {
    if (!isPlainObject(value)) return value
    return Object.fromEntries(
        Object.entries(value).flatMap(([key, child]): [string, unknown][] => {
            if (typeof child === 'string') return child.trim().length > 0 ? [[key, child]] : []
            if (isPlainObject(child)) return [[key, withoutLegacyValues(child)]]
            return []
        })
    )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flattenHistorical(value: unknown, localeId: string, legacy: boolean) {
    const errors: string[] = []
    const flat = flattenBundle(legacy ? withoutLegacyValues(value) : value, localeId, errors)
    if (errors.length > 0) {
        throw new Error(`Invalid historical locale '${localeId}': ${errors.join('; ')}`)
    }
    return flat
}

function canonicalTargetContent(value: unknown, localeId: string, { legacy = false } = {}) {
    const entries = new Map<string, string>()
    for (const [key, storedValue] of Object.entries(flattenHistorical(value, localeId, legacy))) {
        const parsed = parseTargetValue(storedValue)
        if (parsed.kind !== TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
            entries.set(
                key,
                (
                    parsed as Extract<typeof parsed, { kind: 'accepted' | 'pending' }>
                ).targetText.normalize('NFC')
            )
        }
    }
    return entries
}

function canonicalSourceContent(value: unknown, legacy: boolean) {
    const entries = new Map<string, string>()
    for (const [key, text] of Object.entries(flattenHistorical(value, SOURCE_LOCALE, legacy))) {
        entries.set(key, text.normalize('NFC'))
    }
    return entries
}

// A locale file that does not parse as JSON reached main once, and history cannot be rewritten to
// remove it. Such a revision is uncomparable rather than fatal, so the caller counts it as a change.
const UNPARSEABLE = Symbol('unparseable')

function parseHistoricalJson(source: string): unknown {
    try {
        return JSON.parse(source)
    } catch {
        return UNPARSEABLE
    }
}

type ComparisonOptions = {
    previousLegacy?: boolean
    currentLegacy?: boolean
    // English at the compared revision. When it is given, a value copied from English earns no
    // credit. English that is missing or never parsed cannot be compared, so it filters nothing.
    source?: string
}

export function localeJsonChanged(
    previous: string | undefined,
    current: string,
    localeId: string,
    revision?: string,
    { previousLegacy = false, currentLegacy = false, source }: ComparisonOptions = {}
) {
    const previousBundle = previous === undefined ? {} : parseHistoricalJson(previous)
    const currentBundle = parseHistoricalJson(current)
    if (previousBundle === UNPARSEABLE || currentBundle === UNPARSEABLE) return true
    const sourceBundle = source === undefined ? UNPARSEABLE : parseHistoricalJson(source)

    try {
        const previousContent = canonicalTargetContent(previousBundle, localeId, {
            legacy: previousLegacy,
        })
        const currentContent = canonicalTargetContent(currentBundle, localeId, {
            legacy: currentLegacy,
        })
        const english =
            sourceBundle === UNPARSEABLE
                ? undefined
                : canonicalSourceContent(sourceBundle, currentLegacy)
        for (const [key, value] of currentContent) {
            if (isDeepStrictEqual(previousContent.get(key), value)) continue
            // A value copied from English, such as a brand name or a language's own name, took no
            // translation work. A key English does not have is an orphan, which is not translation
            // either.
            if (english === undefined) return true
            const englishValue = english.get(key)
            if (englishValue !== undefined && englishValue !== value) return true
        }
        return false
    } catch (error) {
        const location = revision ? ` at revision '${revision}'` : ''
        throw new Error(
            `Could not compare historical JSON for locale '${localeId}'${location}: ${errorMessage(error)}`,
            {
                cause: error,
            }
        )
    }
}

// lexmit verify keeps every file valid from historyBaseline on, including the baseline itself, so
// only its strict ancestors are legacy. The parent and child of one commit can fall on different
// sides, which is why this is decided per revision. Every locale asks about the same commits, so
// each answer is cached.
export function legacyRevisionCheck(
    baseline: string,
    isAncestor: (ancestor: string, descendant: string) => boolean
): IsLegacyRevision {
    const cache = new Map<string, boolean>()
    return (revision) => {
        let legacy = cache.get(revision)
        if (legacy === undefined) {
            legacy = revision !== baseline && isAncestor(revision, baseline)
            cache.set(revision, legacy)
        }
        return legacy
    }
}

// The config is read on the first comparison, not when the comparer is made, so a caller that
// fails before comparing anything does not need a config file.
export function localeCommitComparer({
    readLocale,
    isLegacy,
}: { readLocale?: ReadLocale; isLegacy?: IsLegacyRevision } = {}) {
    let read = readLocale
    let legacyAt = isLegacy
    return (localeId: string, commit: GitHubCommit) => {
        read ??= gitLocaleReader(lexmitConfig().root, lexmitConfig().localeDir)
        legacyAt ??= legacyRevisionCheck(
            lexmitConfig().historyBaseline,
            createGitAdapter({ cwd: lexmitConfig().root }).isAncestor
        )
        const current = read(commit.sha, localeId)
        if (current === undefined) return false
        const parent = commit.parents[0]?.sha
        const previous = parent ? read(parent, localeId) : undefined
        return localeJsonChanged(previous, current, localeId, commit.sha, {
            previousLegacy: previous !== undefined && legacyAt(parent!),
            currentLegacy: legacyAt(commit.sha),
            source: read(commit.sha, SOURCE_LOCALE),
        })
    }
}

export async function collectTranslationContributors(
    localeIds: string[],
    fetchCommits: FetchCommits,
    changesLocaleJson = localeCommitComparer()
) {
    const contributors: TranslationContributors = {}
    const creators: Record<string, string> = {}

    for (const localeId of localeIds) {
        const usernames = new Set<string>()
        let oldest: GitHubCommit | undefined
        for (let page = 1; ; page += 1) {
            const data = await fetchCommits(localeId, page)
            if (!Array.isArray(data)) {
                throw new Error(`GitHub returned invalid commit data for locale '${localeId}'`)
            }

            const commits = data as GitHubCommit[]
            for (const commit of commits) {
                if (typeof commit?.sha !== 'string' || !Array.isArray(commit.parents)) {
                    throw new Error(`GitHub returned an invalid commit for locale '${localeId}'`)
                }
                if (commit.parents.length > 1) continue
                if (commit.author?.type !== 'User') continue
                if (typeof commit.author.login !== 'string') {
                    throw new Error('GitHub returned a user without a login')
                }
                const username = commit.author.login
                if (await changesLocaleJson(localeId, commit)) usernames.add(username)
            }

            // GitHub returns newest first, including full pages followed by an empty page.
            if (commits.length > 0) oldest = commits.at(-1)
            if (commits.length < PER_PAGE) break
        }

        if (oldest?.author?.type === 'User') creators[localeId] = oldest.author.login
        if (usernames.size > 0) contributors[localeId] = [...usernames].sort()
    }

    return { contributors, creators }
}

export async function fetchGitHubCommits(
    repository: string,
    token: string,
    revision: string,
    localeDir: string,
    localeId: string,
    page: number
): Promise<unknown> {
    const url = new URL(`https://api.github.com/repos/${repository}/commits`)
    url.searchParams.set('sha', revision)
    url.searchParams.set('path', `${localeDir}/${localeId}.json`)
    url.searchParams.set('per_page', String(PER_PAGE))
    url.searchParams.set('page', String(page))

    const response = await fetch(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    })
    if (!response.ok) {
        throw new Error(`GitHub commit request failed with status ${response.status}`)
    }
    return response.json()
}

// A squash merge names the merging maintainer as author, which history cannot tell apart from
// translation. Creating a locale is the one act that is unambiguously the translator's.
// GitHub logins are case-insensitive, and a login typed into the config may not match the case
// the API returns.
export function applyMaintainerAttribution(
    contributors: TranslationContributors,
    maintainers: Set<string>,
    creators: Record<string, string>
) {
    const folded = new Set([...maintainers].map((login) => login.toLowerCase()))
    const filtered: TranslationContributors = {}
    for (const [localeId, usernames] of Object.entries(contributors)) {
        const kept = usernames.filter(
            (username) =>
                !folded.has(username.toLowerCase()) ||
                creators[localeId]?.toLowerCase() === username.toLowerCase()
        )
        if (kept.length > 0) filtered[localeId] = kept
    }
    return filtered
}

// GitHub does not say which accounts belong to the same person, so a maintainer's second account
// looks like any other translator. The project lists such accounts in the config instead.
export function maintainerLogins(admins: Iterable<string>, configured: readonly string[]) {
    return new Set([...admins, ...configured])
}

// Trusted translators hold push access and org membership, so admin is the only boundary that
// does not strip their credit. Listing collaborators needs only Metadata read.
async function fetchMaintainers(repository: string, token: string) {
    const maintainers = new Set<string>()
    for (let page = 1; ; page += 1) {
        const url = new URL(`https://api.github.com/repos/${repository}/collaborators`)
        url.searchParams.set('permission', 'admin')
        url.searchParams.set('per_page', String(PER_PAGE))
        url.searchParams.set('page', String(page))

        const response = await fetch(url, {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
            },
        })
        if (!response.ok) {
            throw new Error(
                `GitHub collaborator request failed with status ${response.status}. ` +
                    'Without the maintainer list every maintainer would be credited as a translator.'
            )
        }
        const collaborators: unknown = await response.json()
        if (!Array.isArray(collaborators)) {
            throw new Error('GitHub returned invalid collaborator data')
        }
        for (const collaborator of collaborators) {
            if (typeof collaborator?.login !== 'string') {
                throw new Error('GitHub returned a collaborator without a login')
            }
            maintainers.add(collaborator.login)
        }
        if (collaborators.length < PER_PAGE) return maintainers
    }
}

export async function updateTranslationContributors() {
    const repository = process.env.GITHUB_REPOSITORY
    const token = process.env.GITHUB_TOKEN
    if (!repository || !token) {
        throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
    }

    const inspection = inspectLocales()
    if (inspection.errors.length > 0) {
        throw new Error(
            `Cannot update translation contributors with invalid locales:\n${inspection.errors.join('\n')}`
        )
    }

    const { root, localeDir } = lexmitConfig()
    const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: root,
        encoding: 'utf8',
    }).trim()
    const localeIds = inspection.locales.map((locale) => locale.id)
    const { contributors, creators } = await collectTranslationContributors(
        localeIds,
        (localeId, page) =>
            fetchGitHubCommits(repository, token, revision, localeDir, localeId, page)
    )
    const maintainers = maintainerLogins(
        await fetchMaintainers(repository, token),
        lexmitConfig().maintainers
    )
    const credited = applyMaintainerAttribution(contributors, maintainers, creators)
    writeFileSync(
        resolve(lexmitConfig().root, lexmitConfig().contributorsFile),
        `${JSON.stringify(credited, null, 4)}\n`
    )
    process.stdout.write('Updated translator credits.\n')
}
