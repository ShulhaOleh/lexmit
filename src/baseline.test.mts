import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONFIG_FILE } from './config.mts'
import { createGitAdapter } from './git.mts'
import {
    analyzeCommittedHistory,
    BASELINE_ORIGIN,
    describeHistoryAvailability,
    describeHistoryBaseline,
    HISTORY_UNAVAILABLE,
    I18nHistoryDataError,
    I18nHistoryUnavailableError,
    resolveHistoryBaseline,
} from './history.mts'
import type { CliOutput } from './io.mts'
import { runI18nStatus } from './translate.mts'
import { runI18nEnforcement } from './verify.mts'

const LOCALE_DIR = 'i18n'
const LAYOUT = {
    localeDir: LOCALE_DIR,
    readme: 'README.md',
    statusAssetDir: 'assets/status',
    contributorsFile: 'contributors.json',
    translationGuide: 'docs/translating.md',
}
// A number is not a locale value, so a commit holding this file can never be a baseline.
const INVALID = { en: { key: 'Hello' }, de: { key: 42 } }
const VALID = { en: { key: 'Hello' }, de: { key: 'Hallo' } }

function git(cwd: string, args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function createRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'lexmit-baseline-'))
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'baseline@example.test'])
    git(dir, ['config', 'user.name', 'Baseline Test'])
    git(dir, ['config', 'commit.gpgsign', 'false'])
    git(dir, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(dir, LOCALE_DIR), { recursive: true })
    return dir
}

function withRepo(run: (dir: string) => unknown) {
    const dir = createRepo()
    try {
        return run(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

function writeLocales(dir: string, locales: Record<string, unknown>) {
    for (const [id, bundle] of Object.entries(locales)) {
        writeFileSync(join(dir, LOCALE_DIR, `${id}.json`), JSON.stringify(bundle, null, 4))
    }
}

function writeConfig(dir: string, extra: Record<string, unknown> = {}) {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ ...LAYOUT, ...extra }, null, 4))
}

function commit(dir: string, message: string) {
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', message])
    return git(dir, ['rev-parse', 'HEAD'])
}

function shallowClone(dir: string) {
    const clone = mkdtempSync(join(tmpdir(), 'lexmit-baseline-shallow-'))
    rmSync(clone, { recursive: true, force: true })
    const url = `file:///${dir.replace(/\\/g, '/')}`
    execFileSync('git', ['clone', '-q', '--depth=1', url, clone], { stdio: 'pipe' })
    assert.equal(git(clone, ['rev-parse', '--is-shallow-repository']), 'true')
    return clone
}

function output() {
    let value = ''
    const stream: CliOutput = { write: (chunk) => (value += chunk) }
    return { stream, value: () => value }
}

function verify(dir: string, args: string[] = []) {
    const stdout = output()
    const stderr = output()
    const status = runI18nEnforcement(args, {
        cwd: dir,
        localeDir: LOCALE_DIR,
        stdout: stdout.stream,
        stderr: stderr.stream,
    })
    return { status, stdout: stdout.value(), stderr: stderr.value() }
}

function derived(dir: string) {
    const baseline = resolveHistoryBaseline({ cwd: dir })
    assert.equal(baseline.origin, BASELINE_ORIGIN.DERIVED)
    return baseline.commit
}

// Every merge strategy below starts from a main branch whose locale files fail validation,
// which is why no existing commit could serve as an explicit baseline.
function adoptionBranch(dir: string) {
    writeLocales(dir, INVALID)
    commit(dir, 'invalid locales')
    git(dir, ['switch', '-q', '-c', 'adopt'])
    writeLocales(dir, VALID)
    writeConfig(dir)
    return commit(dir, 'fix locales and adopt lexmit')
}

test('on the adopting branch the commit that adds the config is the baseline', () => {
    withRepo((dir) => {
        const adopting = adoptionBranch(dir)
        writeLocales(dir, { en: { key: 'Hello there' }, de: { key: '? Hallo' } })
        commit(dir, 'later English change')

        assert.equal(derived(dir), adopting)
        const history = analyzeCommittedHistory({ cwd: dir, localeDir: LOCALE_DIR })
        assert.equal(history.baseline, adopting)
        assert.equal(history.baselineOrigin, BASELINE_ORIGIN.DERIVED)
    })
})

test('a squash merge makes the squash commit the baseline', () => {
    withRepo((dir) => {
        writeLocales(dir, INVALID)
        commit(dir, 'invalid locales')
        git(dir, ['switch', '-q', '-c', 'adopt'])
        writeConfig(dir)
        commit(dir, 'adopt lexmit before the fixes')
        writeLocales(dir, VALID)
        commit(dir, 'fix locales')
        git(dir, ['switch', '-q', 'main'])
        git(dir, ['merge', '-q', '--squash', 'adopt'])
        const squash = commit(dir, 'adopt lexmit (#1)')

        assert.equal(derived(dir), squash)
        const result = verify(dir)
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /Semantic check passed/u)
    })
})

test('a merge commit is the baseline because its first-parent diff adds the config', () => {
    withRepo((dir) => {
        adoptionBranch(dir)
        git(dir, ['switch', '-q', 'main'])
        writeFileSync(join(dir, 'notes.txt'), 'unrelated')
        commit(dir, 'unrelated work on main')
        git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge adopt', 'adopt'])
        const merge = git(dir, ['rev-parse', 'HEAD'])

        assert.equal(derived(dir), merge)
        assert.equal(verify(dir).status, 0)
    })
})

test('a rebase merge makes the rebased commit the baseline', () => {
    withRepo((dir) => {
        const original = adoptionBranch(dir)
        writeFileSync(join(dir, 'later.txt'), 'later')
        commit(dir, 'later work on the branch')
        git(dir, ['switch', '-q', 'main'])
        writeFileSync(join(dir, 'notes.txt'), 'unrelated')
        commit(dir, 'unrelated work on main')
        git(dir, ['switch', '-q', 'adopt'])
        git(dir, ['rebase', '-q', 'main'])
        git(dir, ['switch', '-q', 'main'])
        git(dir, ['merge', '-q', '--ff-only', 'adopt'])
        const rebased = git(dir, ['rev-parse', 'HEAD~1'])

        assert.notEqual(rebased, original)
        assert.equal(derived(dir), rebased)
        assert.equal(verify(dir).status, 0)
    })
})

test('deleting and re-adding the config moves the baseline to the re-add', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        commit(dir, 'adopt')
        rmSync(join(dir, CONFIG_FILE))
        commit(dir, 'drop lexmit')
        writeConfig(dir)
        const readded = commit(dir, 'adopt again')
        writeLocales(dir, { en: { key: 'Hello there' }, de: { key: '? Hallo' } })
        commit(dir, 'later English change')

        assert.equal(derived(dir), readded)
    })
})

test('an explicit historyBaseline wins over derivation, even in a shallow clone', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        const explicit = commit(dir, 'valid locales')
        writeConfig(dir, { historyBaseline: explicit })
        const adding = commit(dir, 'adopt with an explicit baseline')
        assert.notEqual(adding, explicit)
        assert.deepEqual(resolveHistoryBaseline({ cwd: dir }), {
            commit: explicit,
            origin: BASELINE_ORIGIN.CONFIG,
        })
        assert.equal(
            analyzeCommittedHistory({ cwd: dir, localeDir: LOCALE_DIR }).baseline,
            explicit
        )

        // An explicit id needs no Git lookup, so a shallow clone does not stop it.
        const clone = shallowClone(dir)
        try {
            assert.equal(resolveHistoryBaseline({ cwd: clone }).commit, explicit)
        } finally {
            rmSync(clone, { recursive: true, force: true })
        }
    })
})

test('a shallow clone refuses to derive the baseline and never returns the tip', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        commit(dir, 'adopt')
        writeLocales(dir, { en: { key: 'Hello there' }, de: { key: '? Hallo' } })
        commit(dir, 'later English change')
        const clone = shallowClone(dir)
        try {
            // The tip of a depth 1 clone looks like it adds every file.
            const tip = git(clone, ['rev-parse', 'HEAD'])
            assert.equal(
                git(clone, [
                    'log',
                    '--first-parent',
                    '--diff-filter=A',
                    '--format=%H',
                    '-1',
                    '--',
                    CONFIG_FILE,
                ]),
                tip
            )
            assert.throws(
                () => resolveHistoryBaseline({ cwd: clone }),
                (error: I18nHistoryUnavailableError) =>
                    error instanceof I18nHistoryUnavailableError &&
                    error.reason === HISTORY_UNAVAILABLE.HISTORY_INCOMPLETE &&
                    /fetch-depth 0/u.test(error.message) &&
                    !error.message.includes(tip)
            )
            const availability = describeHistoryAvailability({
                cwd: clone,
                localeDir: LOCALE_DIR,
            })
            assert.equal(availability.available, false)
            assert.equal(availability.baseline, undefined)

            const result = verify(clone)
            assert.equal(result.status, 1)
            assert.match(result.stderr, /Deriving the baseline needs full history/u)
            assert.match(describeHistoryBaseline({ cwd: clone }), /^Baseline unavailable: /u)
        } finally {
            rmSync(clone, { recursive: true, force: true })
        }
    })
})

test('an uncommitted config stops history commands with a clear error', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        commit(dir, 'locales before lexmit')
        writeConfig(dir)

        const notCommitted = (error: I18nHistoryUnavailableError) =>
            error instanceof I18nHistoryUnavailableError &&
            error.reason === HISTORY_UNAVAILABLE.CONFIG_NOT_COMMITTED &&
            /lexmit\.config\.json is not committed yet/u.test(error.message) &&
            !/Fetch full history/u.test(error.message)
        assert.throws(() => resolveHistoryBaseline({ cwd: dir }), notCommitted)
        assert.throws(
            () => analyzeCommittedHistory({ cwd: dir, localeDir: LOCALE_DIR }),
            notCommitted
        )
        const result = verify(dir)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /is not committed yet/u)
    })
})

test('a repository with no commits has no derived baseline either', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        assert.throws(
            () => resolveHistoryBaseline({ cwd: dir }),
            (error: I18nHistoryUnavailableError) =>
                error.reason === HISTORY_UNAVAILABLE.CONFIG_NOT_COMMITTED
        )
    })
})

test('verify --staged on the adopting commit checks the staged files alone', () => {
    withRepo((dir) => {
        writeLocales(dir, INVALID)
        commit(dir, 'invalid locales')
        writeLocales(dir, { en: { key: 'Hello', more: 'More' }, de: { key: 'Hallo' } })
        writeConfig(dir)
        git(dir, ['add', '-A'])

        const result = verify(dir, ['--staged'])
        assert.equal(result.status, 0, result.stderr)
        assert.match(
            result.stdout,
            /^Baseline this commit \(adds lexmit\.config\.json\)\nSemantic check passed/u
        )
        // The missing German key is marker work for the bot, not review debt.
        assert.match(result.stdout, /1 derived marker update\(s\) pending/u)

        // After the commit, the same files are the derived baseline.
        const adopting = commit(dir, 'adopt')
        assert.equal(derived(dir), adopting)
    })
})

test('verify --staged on the adopting commit still rejects invalid staged files', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        commit(dir, 'valid locales')
        writeLocales(dir, INVALID)
        writeConfig(dir)
        git(dir, ['add', '-A'])

        const result = verify(dir, ['--staged'])
        assert.equal(result.status, 1)
        assert.match(result.stderr, /unsupported number content/u)
    })
})

test('verify --staged passes on the first commit of a new repository', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        git(dir, ['add', '-A'])
        const result = verify(dir, ['--staged'])
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /^Baseline this commit/u)
    })
})

test('verify --staged with a staged explicit baseline replays history as before', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        const explicit = commit(dir, 'valid locales')
        writeLocales(dir, { en: { key: 'Hello there' }, de: { key: '? Hallo' } })
        writeConfig(dir, { historyBaseline: explicit })
        git(dir, ['add', '-A'])
        const result = verify(dir, ['--staged'])
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /^Baseline [0-9a-f]{7} \(historyBaseline\)\n/u)
    })
})

test('invalid locale files at a derived baseline explain why that commit was checked', () => {
    withRepo((dir) => {
        writeLocales(dir, INVALID)
        writeConfig(dir)
        const adopting = commit(dir, 'adopt before the fixes')
        writeLocales(dir, VALID)
        commit(dir, 'fix locales')

        assert.throws(
            () => analyzeCommittedHistory({ cwd: dir, localeDir: LOCALE_DIR }),
            (error: Error) =>
                error instanceof I18nHistoryDataError &&
                error.message.includes(`de.json@${adopting}`) &&
                error.message.endsWith(
                    'The baseline is the commit that added lexmit.config.json. ' +
                        'Add the config in the same commit as the locale fixes, or set historyBaseline.'
                )
        )
        // A baseline the caller chose is not explained as a derived one.
        assert.throws(
            () => analyzeCommittedHistory({ cwd: dir, localeDir: LOCALE_DIR, baseline: adopting }),
            (error: Error) =>
                error instanceof I18nHistoryDataError &&
                !error.message.includes('The baseline is the commit')
        )
        const result = verify(dir)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /Add the config in the same commit as the locale fixes/u)
    })
})

test('verify names the baseline it used once, and only when it chose it', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        const adopting = commit(dir, 'adopt')
        const result = verify(dir)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(
            result.stdout.split('\n')[0],
            `Baseline ${adopting.slice(0, 7)} (added lexmit.config.json)`
        )
        assert.equal(result.stdout.match(/^Baseline /gmu)?.length, 1)

        const stdout = output()
        runI18nEnforcement([], {
            cwd: dir,
            localeDir: LOCALE_DIR,
            baseline: adopting,
            stdout: stdout.stream,
            stderr: output().stream,
        })
        assert.doesNotMatch(stdout.value(), /Baseline/u)
    })
})

test('status prints the baseline line above the coverage rows', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        const adopting = commit(dir, 'adopt')
        const line = describeHistoryBaseline({ cwd: dir })
        assert.equal(line, `Baseline ${adopting.slice(0, 7)} (added lexmit.config.json)`)

        const stdout = output()
        const status = runI18nStatus({
            i18nDir: join(dir, LOCALE_DIR),
            stdout: stdout.stream,
            stderr: output().stream,
            env: {},
            baselineLine: line,
        })
        assert.equal(status, 0)
        assert.equal(stdout.value().split('\n')[0], line)
        assert.match(stdout.value(), /English \(en\)/u)
    })
})

test('the derived baseline is looked up once per process', () => {
    withRepo((dir) => {
        writeLocales(dir, VALID)
        writeConfig(dir)
        const adopting = commit(dir, 'adopt')
        const adapter = createGitAdapter({ cwd: dir })
        assert.equal(resolveHistoryBaseline({ cwd: dir, git: adapter }).commit, adopting)
        const calls = adapter.counters.gitCalls
        assert.equal(resolveHistoryBaseline({ cwd: dir, git: adapter }).commit, adopting)
        assert.equal(adapter.counters.gitCalls, calls)
    })
})
