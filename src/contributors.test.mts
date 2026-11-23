import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FIXTURE_LAYOUT } from './fixtures/layout.mts'
import assert from 'node:assert/strict'
import {
    applyMaintainerAttribution,
    collectTranslationContributors,
    fetchGitHubCommits,
    gitLocaleReader,
    legacyRevisionCheck,
    localeCommitComparer,
    localeJsonChanged,
    maintainerLogins,
} from './contributors.mts'
import { createGitAdapter } from './git.mts'

const LOCALE_DIR = FIXTURE_LAYOUT.localeDir

async function collectContributorsOnly(...args: Parameters<typeof collectTranslationContributors>) {
    const { contributors } = await collectTranslationContributors(...args)
    return contributors
}

function locale(value: string | undefined) {
    return value === undefined ? undefined : JSON.stringify({ key: value })
}

function runGit(directory: string, args: string[]) {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
}

type HistoryState = {
    source: string | Record<string, unknown>
    target: string | undefined
    author: string
    message?: string
}

const FIXTURE_LOCALE_DIR = 'locales'

function temporaryHistory(states: HistoryState[]) {
    const directory = mkdtempSync(join(tmpdir(), 'lexmit-i18n-attribution-'))
    const localeDirectory = join(directory, FIXTURE_LOCALE_DIR)
    mkdirSync(localeDirectory)
    runGit(directory, ['init', '-q'])
    runGit(directory, ['config', 'user.name', 'Fixture Default'])
    runGit(directory, ['config', 'user.email', 'fixture@example.test'])
    runGit(directory, ['config', 'core.autocrlf', 'false'])
    const commits: { sha: string; parent: string | undefined; author: string }[] = []
    try {
        for (const state of states) {
            writeFileSync(
                join(localeDirectory, 'en.json'),
                JSON.stringify(
                    typeof state.source === 'string' ? { key: state.source } : state.source
                )
            )
            if (state.target === undefined) {
                rmSync(join(localeDirectory, 'de.json'), { force: true })
            } else {
                writeFileSync(join(localeDirectory, 'de.json'), state.target)
            }
            runGit(directory, ['add', '-A'])
            runGit(directory, [
                '-c',
                `user.name=${state.author}`,
                '-c',
                `user.email=${state.author.toLowerCase().replaceAll(' ', '-')}@example.test`,
                'commit',
                '-m',
                state.message ?? state.author,
                '--author',
                `${state.author} <${state.author.toLowerCase().replaceAll(' ', '-')}@example.test>`,
                '--quiet',
            ])
            const sha = runGit(directory, ['rev-parse', 'HEAD'])
            commits.push({ sha, parent: commits.at(-1)?.sha, author: state.author })
        }
        return {
            directory,
            commits,
            // Collects through the production comparer, with historyBaseline at the given commit.
            collect({ baselineAt = 0 }: { baselineAt?: number } = {}) {
                const apiCommits = commits
                    .slice()
                    .reverse()
                    .map((commit) => ({
                        sha: commit.sha,
                        parents: commit.parent ? [{ sha: commit.parent }] : [],
                        author: { type: 'User', login: commit.author },
                    }))
                return collectContributorsOnly(
                    ['de'],
                    async (_localeId, page) => (page === 1 ? apiCommits : []),
                    localeCommitComparer({
                        readLocale: gitLocaleReader(directory, FIXTURE_LOCALE_DIR),
                        isLegacy: legacyRevisionCheck(
                            commits[baselineAt]!.sha,
                            createGitAdapter({ cwd: directory }).isAncestor
                        ),
                    })
                )
            },
        }
    } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
    }
}

async function withTemporaryHistory(
    states: HistoryState[],
    callback: (fixture: ReturnType<typeof temporaryHistory>) => Promise<unknown>
) {
    const fixture = temporaryHistory(states)
    try {
        return await callback(fixture)
    } finally {
        rmSync(fixture.directory, { recursive: true, force: true })
    }
}

const noCreditTransitions = [
    ['absent to scaffold', undefined, '! English'],
    ['scaffold refresh', '! Old English', '! New English'],
    ['accepted to pending marker', 'X', '? X'],
    ['Keep', '? X', 'X'],
    ['source return clear', '? X', 'X'],
    ['target deletion', 'X', undefined],
    ['NFC-equivalent target edit', 'e\u0301', 'é'],
] satisfies [string, string | undefined, string | undefined][]

for (const [name, previous, current] of noCreditTransitions) {
    test(`attribution ignores ${name}`, () => {
        assert.equal(
            localeJsonChanged(
                locale(previous),
                current === undefined ? '{}' : locale(current)!,
                'de'
            ),
            false
        )
    })
}

const creditTransitions = [
    ['Pending to accepted edit', '? X', 'Y'],
    ['Pending edit remaining Pending', '? X', '? Y'],
    ['first translation over scaffold', '! English', 'Y'],
    ['first translation without scaffold', undefined, 'Y'],
    ['direct accepted edit', 'X', 'Y'],
    ['punctuation edit', 'Hello', 'Hello!'],
    ['capitalization edit', 'word', 'Word'],
    ['target whitespace edit', 'foo bar', 'foo  bar'],
] satisfies [string, string | undefined, string][]

for (const [name, previous, current] of creditTransitions) {
    test(`attribution credits ${name}`, () => {
        assert.equal(localeJsonChanged(locale(previous), locale(current)!, 'de'), true)
    })
}

test('attribution ignores formatting and object ordering', () => {
    const before = JSON.stringify({ group: { first: 'X', second: 'Y' } })
    const after = '{"group":{"second":"Y","first":"X"}}'
    assert.equal(localeJsonChanged(before, after, 'de'), false)
})

test('attribution credits canonical content changes in a mixed transition', () => {
    const before = JSON.stringify({
        scaffold: '! Old',
        marker: 'X',
        keep: '? A',
        pendingEdit: '? B',
        direct: 'D',
        removed: 'Gone',
    })
    const after = JSON.stringify({
        scaffold: '! New',
        marker: '? X',
        keep: 'A',
        pendingEdit: '? C',
        direct: 'E',
    })
    assert.equal(localeJsonChanged(before, after, 'de'), true)
})

test('marker-only maintenance across locales credits no source maintainer', async () => {
    const snapshots = new Map([
        ['de-marker', [locale('X'), locale('? X')]],
        ['ru-marker', [locale('X'), locale('? X')]],
        ['uk-scaffold', [locale(undefined), locale('! English')]],
    ])
    const contributors = await collectContributorsOnly(
        ['de', 'ru', 'uk'],
        async (localeId, page) => {
            if (page > 1) return []
            const sha = localeId === 'uk' ? 'uk-scaffold' : `${localeId}-marker`
            return [
                {
                    sha,
                    parents: [{ sha: `${sha}-parent` }],
                    author: { type: 'User', login: 'SourceMaintainer' },
                },
            ]
        },
        (_localeId, commit) => {
            const [previous, current] = snapshots.get(commit.sha)!
            return localeJsonChanged(previous, current!, _localeId)
        }
    )
    assert.deepEqual(contributors, {})
})

test('pending edit remains attributable even while review is unresolved', async () => {
    const contributors = await collectContributorsOnly(
        ['de'],
        async () => [
            {
                sha: 'pending-edit',
                parents: [{ sha: 'parent' }],
                author: { type: 'User', login: 'TranslatorB' },
            },
        ],
        () => localeJsonChanged(locale('? X'), locale('? Y')!, 'de')
    )
    assert.deepEqual(contributors, { de: ['TranslatorB'] })
})

test('linked GitHub authors remain accumulated only for semantic target changes', async () => {
    const transitions = new Map([
        ['translator-a', [undefined, 'Y']],
        ['source-marker', ['Y', '? Y']],
        ['translator-b', ['Y', 'Z']],
        ['reviewer-keep', ['? Z', 'Z']],
    ])
    const contributors = await collectContributorsOnly(
        ['de'],
        async (_localeId, page) =>
            page === 1
                ? [...transitions.keys()].map((sha, index) => ({
                      sha,
                      parents: [{ sha: `parent-${index}` }],
                      author: { type: 'User', login: sha },
                  }))
                : [],
        (_localeId, commit) => {
            const [previous, current] = transitions.get(commit.sha)!
            return localeJsonChanged(locale(previous), locale(current)!, 'de')
        }
    )
    assert.deepEqual(contributors, { de: ['translator-a', 'translator-b'] })
})

test('linked marker-only identities are excluded while linked editors remain credited', async () => {
    const commits = [
        {
            sha: 'linked-marker',
            parents: [{ sha: 'parent-marker' }],
            author: { type: 'User', login: 'SquashedMarkerAuthor' },
        },
        {
            sha: 'linked-edit',
            parents: [{ sha: 'parent-edit' }],
            author: { type: 'User', login: 'SquashedTranslator' },
        },
        {
            sha: 'linked-merge',
            parents: [{ sha: 'one' }, { sha: 'two' }],
            author: { type: 'User', login: 'SquashedMarkerAuthor' },
        },
    ]
    const contributors = await collectContributorsOnly(
        ['de'],
        async (_localeId, page) => (page === 1 ? commits : []),
        (_localeId, commit) => commit.sha === 'linked-edit'
    )
    assert.deepEqual(contributors, { de: ['SquashedTranslator'] })
})

test('real Git history credits pending edits but not source markers or Keep', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
            { source: 'B', target: JSON.stringify({ key: '? X' }), author: 'Source Maintainer' },
            { source: 'B', target: JSON.stringify({ key: '? Y' }), author: 'Translator B' },
            { source: 'B', target: JSON.stringify({ key: 'Y' }), author: 'Reviewer C' },
            { source: 'C', target: JSON.stringify({ key: 'Z' }), author: 'Translator E' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), {
                de: ['Translator A', 'Translator B', 'Translator E'],
            })
        }
    )
})

test('real Git source and target changes classify marker and content transitions', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
            { source: 'B', target: JSON.stringify({ key: 'Y' }), author: 'Translator B' },
            { source: 'C', target: JSON.stringify({ key: '? Y' }), author: 'Source Maintainer' },
            { source: 'D', target: JSON.stringify({ key: 'Z' }), author: 'Translator D' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), {
                de: ['Translator A', 'Translator B', 'Translator D'],
            })
        }
    )
})

test('real Git deletion receives no credit and recreation receives credit', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
            { source: 'A', target: undefined, author: 'Source Maintainer' },
            { source: 'A', target: JSON.stringify({ key: 'Y' }), author: 'Translator C' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Translator A', 'Translator C'] })
        }
    )
})

test('real Git locale creation credits translations but not scaffolds', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: undefined, author: 'Source Maintainer' },
            {
                source: { scaffold: 'English', translated: 'Translation' },
                target: JSON.stringify({
                    scaffold: '! English',
                    translated: 'Übersetzung',
                }),
                author: 'Translator A',
            },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Translator A'] })
        }
    )
})

test('real Git formatting-only changes receive no credit', async () => {
    await withTemporaryHistory(
        [
            {
                source: { one: 'One', two: 'Two' },
                target: '{\n    "one": "X",\n    "two": "Y"\n}\n',
                author: 'Translator A',
            },
            {
                source: { one: 'One', two: 'Two' },
                target: '{"two":"Y","one":"X"}',
                author: 'Formatter B',
            },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Translator A'] })
        }
    )
})

test('malformed historical target leaves fail closed through real Git collection', async () => {
    await assert.rejects(
        withTemporaryHistory(
            [
                { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
                { source: 'A', target: JSON.stringify({ key: 42 }), author: 'Broken Commit' },
            ],
            // The broken commit comes after the baseline, where every file has to be valid.
            (fixture) => fixture.collect({ baselineAt: 0 })
        ),
        /Invalid historical locale 'de'.*must be a string or object/s
    )
})

test('a revision whose JSON never parsed counts as a change', () => {
    const broken = '{"key": "X\n}'
    assert.equal(localeJsonChanged(undefined, broken, 'de'), true)
    assert.equal(localeJsonChanged(broken, locale('X')!, 'de'), true)
})

test('malformed target marker syntax remains rejected', () => {
    assert.throws(
        () => localeJsonChanged(locale('X'), locale('? ? X')!, 'de'),
        /Could not compare historical JSON for locale 'de'/
    )
})

test('non-string historical target leaves fail closed', () => {
    for (const invalid of ['42', 'null', '["x"]']) {
        for (const options of [{}, { previousLegacy: false, currentLegacy: false }]) {
            assert.throws(
                () => localeJsonChanged('{"key":"X"}', `{"key":${invalid}}`, 'de', 'r', options),
                /Invalid historical locale 'de'.*must be a string or object/s
            )
        }
    }
})

test('legacy revisions skip non-string values and still compare the strings', () => {
    const legacy = { previousLegacy: true, currentLegacy: true }
    for (const invalid of ['42', 'null', 'true', '["x"]', '[]']) {
        assert.equal(
            localeJsonChanged('{"key":"X"}', `{"key":${invalid}}`, 'de', 'r', legacy),
            false,
            invalid
        )
        assert.equal(
            localeJsonChanged(
                `{"key":${invalid},"other":"Y"}`,
                `{"key":${invalid},"other":"Z"}`,
                'de',
                'r',
                legacy
            ),
            true,
            invalid
        )
        assert.equal(
            localeJsonChanged(
                `{"group":{"key":${invalid},"other":"Y"}}`,
                `{"group":{"key":${invalid},"other":"Y"}}`,
                'de',
                'r',
                legacy
            ),
            false,
            invalid
        )
    }
})

test('legacy revisions skip blank strings and still compare the strings around them', () => {
    const legacy = { previousLegacy: true, currentLegacy: true }
    for (const blank of ['""', '"   "', '"\\n\\t"']) {
        assert.equal(localeJsonChanged('{"key":"X"}', `{"key":${blank}}`, 'de', 'r', legacy), false)
        assert.equal(
            localeJsonChanged(
                `{"key":${blank},"other":"Y"}`,
                `{"key":${blank},"other":"Z"}`,
                'de',
                'r',
                legacy
            ),
            true,
            blank
        )
        assert.equal(
            localeJsonChanged(
                `{"key":${blank},"other":"Y"}`,
                `{"key":${blank},"other":"Y"}`,
                'de',
                'r',
                legacy
            ),
            false,
            blank
        )
    }
})

test('an empty string after the baseline is still rejected', () => {
    for (const blank of ['""', '"   "']) {
        for (const options of [{}, { previousLegacy: true }]) {
            assert.throws(
                () => localeJsonChanged('{}', `{"key":${blank}}`, 'de', 'r', options),
                /Invalid historical locale 'de'.*'key' is empty/s
            )
        }
        assert.throws(
            () =>
                localeJsonChanged('{}', locale('X')!, 'de', 'r', {
                    source: `{"key":${blank}}`,
                }),
            /Invalid historical locale 'en'.*'key' is empty/s
        )
    }
})

test('a legacy empty English string is skipped and its key becomes an orphan', () => {
    const source = JSON.stringify({ empty: '', title: 'Title' })
    const options = { currentLegacy: true, source }
    assert.equal(
        localeJsonChanged('{}', JSON.stringify({ empty: 'Leer' }), 'de', 'r', options),
        false
    )
    assert.equal(
        localeJsonChanged(
            '{}',
            JSON.stringify({ empty: 'Leer', title: 'Titel' }),
            'de',
            'r',
            options
        ),
        true
    )
})

test('legacy mode is chosen per revision, not per commit', () => {
    const arrayParent = '{"dayAbbr":["So","Mo"]}'
    const keyedChild = '{"dayAbbr":{"sun":"So","mon":"Mo"}}'
    assert.equal(
        localeJsonChanged(arrayParent, keyedChild, 'de', 'r', { previousLegacy: true }),
        true
    )
    assert.throws(
        () => localeJsonChanged(arrayParent, arrayParent, 'de', 'r', { previousLegacy: true }),
        /'dayAbbr' must be a string or object/
    )
    assert.throws(
        () => localeJsonChanged(arrayParent, keyedChild, 'de', 'r', { currentLegacy: true }),
        /'dayAbbr' must be a string or object/
    )
})

test('real Git restructure of a legacy array at the baseline compares without throwing', async () => {
    await withTemporaryHistory(
        [
            {
                source: { title: 'Title', dayAbbr: ['S', 'M'] },
                target: JSON.stringify({ title: 'Titel', dayAbbr: ['So', 'Mo'] }),
                author: 'Creator',
            },
            {
                source: { title: 'Title', dayAbbr: { sun: 'S', mon: 'M' } },
                target: JSON.stringify({ title: 'Titel', dayAbbr: { sun: 'So', mon: 'Mo' } }),
                author: 'Adopter',
            },
        ],
        async (fixture) => {
            // The keyed values are new and differ from English, so the restructure counts.
            assert.deepEqual(await fixture.collect({ baselineAt: 1 }), {
                de: ['Adopter', 'Creator'],
            })
        }
    )
})

test('real Git legacy commits credit string changes made next to an array', async () => {
    await withTemporaryHistory(
        [
            {
                source: { title: 'Title', days: ['S'], blank: '' },
                target: JSON.stringify({ title: 'Titel', days: ['So'], blank: ' ' }),
                author: 'Creator',
            },
            {
                source: { title: 'Title', days: ['S', 'M'] },
                target: JSON.stringify({ title: 'Titel', days: ['So', 'Mo'] }),
                author: 'Array Editor',
            },
            {
                source: { title: 'Title', days: ['S', 'M'] },
                target: JSON.stringify({ title: 'Überschrift', days: ['So', 'Mo', 'Di'] }),
                author: 'Translator',
            },
            {
                source: { title: 'Title' },
                target: JSON.stringify({ title: 'Überschrift' }),
                author: 'Adopter',
            },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect({ baselineAt: 3 }), {
                de: ['Creator', 'Translator'],
            })
        }
    )
})

test('real Git baseline commit is not legacy', async () => {
    await assert.rejects(
        withTemporaryHistory(
            [
                { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
                { source: 'A', target: JSON.stringify({ key: ['X'] }), author: 'Baseline' },
            ],
            (fixture) => fixture.collect({ baselineAt: 1 })
        ),
        /Invalid historical locale 'de'.*must be a string or object/s
    )
})

test('the baseline ancestry check runs once per revision across locales', async () => {
    const files = new Map([
        ['base:en', '{"key":"A"}'],
        ['one:en', '{"key":"A"}'],
        ['one:de', '{"key":"X"}'],
        ['one:fr', '{"key":"Y"}'],
        ['two:en', '{"key":"A"}'],
        ['two:de', '{"key":"Z"}'],
        ['two:fr', '{"key":"W"}'],
    ])
    const asked: string[] = []
    const commits = [
        { sha: 'two', parents: [{ sha: 'one' }], author: { type: 'User', login: 'B' } },
        { sha: 'one', parents: [{ sha: 'base' }], author: { type: 'User', login: 'A' } },
    ]
    const contributors = await collectContributorsOnly(
        ['de', 'fr'],
        async (_localeId, page) => (page === 1 ? commits : []),
        localeCommitComparer({
            readLocale: (revision, localeId) => files.get(`${revision}:${localeId}`),
            isLegacy: legacyRevisionCheck('base', (ancestor, descendant) => {
                assert.equal(descendant, 'base')
                asked.push(ancestor)
                return false
            }),
        })
    )
    assert.deepEqual(contributors, { de: ['A', 'B'], fr: ['A', 'B'] })
    assert.deepEqual(asked.sort(), ['one', 'two'])
})

test('a target value copied from English earns no credit', () => {
    const source = JSON.stringify({ key: 'Vanilla' })
    for (const copied of ['Vanilla', '? Vanilla']) {
        assert.equal(
            localeJsonChanged(locale('VANILLA'), locale(copied)!, 'de', 'r', { source }),
            false
        )
    }
    assert.equal(
        localeJsonChanged(locale('X'), locale('e\u0301')!, 'de', 'r', {
            source: JSON.stringify({ key: 'é' }),
        }),
        false
    )
    assert.equal(
        localeJsonChanged(locale('VANILLA'), locale('Vanille')!, 'de', 'r', { source }),
        true
    )
})

test('a translated change still credits next to a copied one', () => {
    const source = JSON.stringify({ brand: 'Vanilla', title: 'Title' })
    const before = JSON.stringify({ brand: 'VANILLA', title: 'Titel' })
    assert.equal(
        localeJsonChanged(
            before,
            JSON.stringify({ brand: 'Vanilla', title: 'Überschrift' }),
            'de',
            'r',
            {
                source,
            }
        ),
        true
    )
    assert.equal(
        localeJsonChanged(before, JSON.stringify({ brand: 'Vanilla', title: 'Titel' }), 'de', 'r', {
            source,
        }),
        false
    )
})

test('a target key without an English counterpart earns no credit', () => {
    const source = JSON.stringify({ key: 'Key' })
    assert.equal(
        localeJsonChanged('{}', JSON.stringify({ langZhCN: '简体中文' }), 'de', 'r', { source }),
        false
    )
    assert.equal(
        localeJsonChanged('{}', JSON.stringify({ key: 'Schlüssel' }), 'de', 'r', { source }),
        true
    )
})

test('English that never parsed cannot rule out a change', () => {
    assert.equal(localeJsonChanged(locale('X'), locale('Y')!, 'de', 'r', { source: '{' }), true)
})

test('real Git compares a target with English at the same commit, not its parent', async () => {
    await withTemporaryHistory(
        [
            { source: 'Moin', target: JSON.stringify({ key: 'Hallo' }), author: 'Creator' },
            { source: 'Hello', target: JSON.stringify({ key: 'Moin' }), author: 'Translator' },
            { source: 'Plain', target: JSON.stringify({ key: 'Plain' }), author: 'Copier' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Creator', 'Translator'] })
        }
    )
})

test('maintainer attribution keeps a maintainer only where they created the locale', () => {
    const credited = applyMaintainerAttribution(
        {
            de: ['ShulhaOleh', 'TarekLP'],
            ru: ['ShulhaOleh'],
            uk: ['ShevRuslan1', 'ShulhaOleh'],
        },
        new Set(['ShulhaOleh']),
        { de: 'TarekLP', ru: 'ShulhaOleh', uk: 'ShevRuslan1' }
    )
    assert.deepEqual(credited, {
        de: ['TarekLP'],
        ru: ['ShulhaOleh'],
        uk: ['ShevRuslan1'],
    })
})

test('maintainer attribution drops a locale left with no contributors', () => {
    const credited = applyMaintainerAttribution({ pl: ['ShulhaOleh'] }, new Set(['ShulhaOleh']), {
        pl: 'SomeoneElse',
    })
    assert.deepEqual(credited, {})
})

test('maintainer attribution never filters ordinary contributors', () => {
    const credited = applyMaintainerAttribution(
        { uk: ['ShevRuslan1', 'TarekLP'] },
        new Set(['ShulhaOleh']),
        {}
    )
    assert.deepEqual(credited, { uk: ['ShevRuslan1', 'TarekLP'] })
})

test('a new locale excludes every maintainer that did not create it', () => {
    const credited = applyMaintainerAttribution(
        { fr: ['ShulhaOleh', 'SecondMaintainer', 'FrenchTranslator'] },
        new Set(['ShulhaOleh', 'SecondMaintainer']),
        { fr: 'FrenchTranslator' }
    )
    assert.deepEqual(credited, { fr: ['FrenchTranslator'] })
})

test('promoting a translator to maintainer leaves their credit intact', () => {
    const contributors = { uk: ['ShevRuslan1'], de: ['TarekLP'] }
    const creators = { uk: 'ShevRuslan1', de: 'TarekLP' }
    const before = applyMaintainerAttribution(contributors, new Set(['ShulhaOleh']), creators)
    const after = applyMaintainerAttribution(
        contributors,
        new Set(['ShulhaOleh', 'ShevRuslan1']),
        creators
    )
    assert.deepEqual(after, before)
    assert.deepEqual(after, { uk: ['ShevRuslan1'], de: ['TarekLP'] })
})

test('a promoted maintainer loses credit only where they did not create the locale', () => {
    const credited = applyMaintainerAttribution(
        { uk: ['ShevRuslan1'], fr: ['ShevRuslan1'] },
        new Set(['ShevRuslan1']),
        { uk: 'ShevRuslan1', fr: 'FrenchTranslator' }
    )
    assert.deepEqual(credited, { uk: ['ShevRuslan1'] })
})

test('declared maintainers are removed where they did not create the locale', () => {
    const maintainers = maintainerLogins(new Set(['ShevRuslan1', 'ShulhaOleh']), ['Ruslan4234'])
    const credited = applyMaintainerAttribution(
        {
            uk: ['Ruslan4234', 'ShevRuslan1', 'tozetsu'],
            'zh-CN': ['Ruslan4234', 'tozetsu'],
        },
        maintainers,
        { uk: 'ShevRuslan1', 'zh-CN': 'tozetsu' }
    )
    assert.deepEqual(credited, { uk: ['ShevRuslan1', 'tozetsu'], 'zh-CN': ['tozetsu'] })
})

test('a declared maintainer who created the locale keeps the credit', () => {
    const credited = applyMaintainerAttribution(
        { uk: ['Ruslan4234'], fr: ['Ruslan4234', 'FrenchTranslator'] },
        maintainerLogins([], ['Ruslan4234']),
        { uk: 'Ruslan4234', fr: 'FrenchTranslator' }
    )
    assert.deepEqual(credited, { uk: ['Ruslan4234'], fr: ['FrenchTranslator'] })
})

test('maintainer matching ignores the case of logins', () => {
    const credited = applyMaintainerAttribution(
        { uk: ['Ruslan4234', 'ShulhaOleh', 'ShevRuslan1'], de: ['TarekLP'] },
        maintainerLogins(new Set(['shulhaoleh', 'SHEVRUSLAN1']), ['ruslan4234']),
        { uk: 'shevruslan1', de: 'tareklp' }
    )
    assert.deepEqual(credited, { uk: ['ShevRuslan1'], de: ['TarekLP'] })
})

test('the oldest commit for a locale is reported as its creator', async () => {
    const { creators } = await collectTranslationContributors(
        ['uk'],
        async (_localeId, page) =>
            page === 1
                ? [
                      {
                          sha: 'latest',
                          parents: [{ sha: 'mid' }],
                          author: { type: 'User', login: 'ShulhaOleh' },
                      },
                      {
                          sha: 'first',
                          parents: [],
                          author: { type: 'User', login: 'ShevRuslan1' },
                      },
                  ]
                : [],
        () => true
    )
    assert.deepEqual(creators, { uk: 'ShevRuslan1' })
})

for (const count of [0, 99, 100, 101, 200]) {
    test('creator attribution survives ' + count + ' paginated commits', async () => {
        const commits = Array.from({ length: count }, (_, index) => ({
            sha: 'commit-' + index,
            parents: [],
            author: { type: 'User', login: index === count - 1 ? 'Creator' : 'Translator' },
        }))
        const pages: number[] = []
        const { contributors, creators } = await collectTranslationContributors(
            ['de'],
            async (_localeId, page) => {
                pages.push(page)
                return commits.slice((page - 1) * 100, page * 100)
            },
            () => true
        )
        assert.deepEqual(creators, count === 0 ? {} : { de: 'Creator' })
        assert.deepEqual(
            applyMaintainerAttribution(contributors, new Set(['Creator']), creators),
            count === 0 ? {} : { de: ['Creator', 'Translator'] }
        )
        assert.deepEqual(
            pages,
            Array.from({ length: Math.floor(count / 100) + 1 }, (_, i) => i + 1)
        )
    })
}

test('every commit API page is pinned to the resolved checkout', async (t) => {
    const urls: URL[] = []
    t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
        urls.push(new URL(url))
        return { ok: true, json: async () => [] }
    })
    const revision = 'a'.repeat(40)
    for (const page of [1, 2]) {
        await fetchGitHubCommits(
            'owner/repository',
            'fixture-token',
            revision,
            LOCALE_DIR,
            'de',
            page
        )
    }
    for (const [index, url] of urls.entries()) {
        assert.equal(url.searchParams.get('sha'), revision)
        assert.equal(url.searchParams.get('path'), 'apps/desktop/src/renderer/src/i18n/de.json')
        assert.equal(url.searchParams.get('page'), String(index + 1))
        assert.equal(url.searchParams.get('per_page'), '100')
    }
})

for (const status of [401, 403, 429, 500]) {
    test(
        'commit API failure ' + status + ' aborts instead of returning empty history',
        async (t) => {
            t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status }))
            await assert.rejects(
                fetchGitHubCommits('owner/repo', 'token', 'a'.repeat(40), LOCALE_DIR, 'de', 1),
                new RegExp('status ' + status)
            )
        }
    )
}

for (const failureAt of ['fetch', 'json']) {
    test('commit API propagates ' + failureAt + ' failure', async (t) => {
        const failure = new Error(failureAt + ' failed')
        t.mock.method(globalThis, 'fetch', async () => {
            if (failureAt === 'fetch') throw failure
            return {
                ok: true,
                json: async () => {
                    throw failure
                },
            }
        })
        await assert.rejects(
            fetchGitHubCommits('owner/repo', 'token', 'a'.repeat(40), LOCALE_DIR, 'de', 1),
            (error) => error === failure
        )
    })
}

test('pagination aborts on malformed later pages', async () => {
    const fullPage = Array.from({ length: 100 }, () => ({ sha: 'a', parents: [], author: null }))
    for (const invalidPage of [{}, [{ sha: 42, parents: [] }], [{ sha: 'a', parents: null }]]) {
        await assert.rejects(
            collectTranslationContributors(
                ['de'],
                async (_locale, page) => (page === 1 ? fullPage : invalidPage),
                () => true
            ),
            /invalid commit/
        )
    }
})

for (const author of [null, { type: 'Bot', login: 'Robot' }]) {
    test('unlinked or bot creator at a full-page boundary does not credit a newer maintainer', async () => {
        const commits = Array.from({ length: 100 }, (_, index) => ({
            sha: 'commit-' + index,
            parents: [],
            author: index === 99 ? author : { type: 'User', login: 'Maintainer' },
        }))
        const { contributors, creators } = await collectTranslationContributors(
            ['de'],
            async (_locale, page) => (page === 1 ? commits : []),
            () => true
        )
        assert.deepEqual(creators, {})
        assert.deepEqual(
            applyMaintainerAttribution(contributors, new Set(['Maintainer']), creators),
            {}
        )
    })
}

test('an empty locale history cannot inherit the preceding locale creator', async () => {
    const result = await collectTranslationContributors(
        ['de', 'fr'],
        async (locale) =>
            locale === 'de'
                ? [{ sha: 'first', parents: [], author: { type: 'User', login: 'Creator' } }]
                : [],
        () => true
    )
    assert.deepEqual(result, { contributors: { de: ['Creator'] }, creators: { de: 'Creator' } })
})
