import type { CliIO } from './io.mts'
import type { Inspection } from './inspection.mts'
import type { StatusSummaries, SourceStatusSummary, TargetStatusSummary } from './summaries.mts'
import { readFileSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { lexmitConfig, type ResolvedConfig } from './config.mts'
import { inspectLocales, localeNativeName } from './inspection.mts'
import { buildStatusSummaries, deriveTargetStatus, targetFallbackLabel } from './summaries.mts'

export type TranslationContributors = Record<string, string[]>
type Metadata = { names: Record<string, string>; contributors: TranslationContributors }
export type ReadmeLayout = Pick<
    ResolvedConfig,
    'readme' | 'localeDir' | 'statusAssetDir' | 'translationGuide'
>
type ReadmeInputs = { i18nDir?: string; contributorsPath?: string; layout?: ReadmeLayout }

const START_MARKER = '<!-- TRANSLATION_STATUS_START -->'
const END_MARKER = '<!-- TRANSLATION_STATUS_END -->'

// The config holds repository paths, but links in the README resolve against its own directory.
function readmeLink(layout: ReadmeLayout, path: string) {
    return posix.relative(posix.dirname(layout.readme), path)
}

function translationGuide(layout: ReadmeLayout) {
    return `To improve an existing language or add a new one, follow the\n[translation guide](${readmeLink(layout, layout.translationGuide)}).`
}
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const PRETTIER_IGNORE = '<!-- prettier-ignore -->'

function escapeMarkdownLinkText(value: unknown) {
    return String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('|', '\\|')
        .replaceAll('[', '\\[')
        .replaceAll(']', '\\]')
        .replaceAll('(', '\\(')
        .replaceAll(')', '\\)')
}

function escapeHtmlAttribute(value: unknown) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
}

function defaultContributorsPath() {
    return resolve(lexmitConfig().root, lexmitConfig().contributorsFile)
}

export function readTranslationContributors(
    path = defaultContributorsPath()
): TranslationContributors {
    let contributors: unknown
    try {
        contributors = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        throw new Error(`Failed to read translation contributors at ${path}`, { cause: error })
    }

    if (typeof contributors !== 'object' || contributors === null || Array.isArray(contributors)) {
        throw new Error('Translation contributors must be a JSON object')
    }

    for (const [localeId, usernames] of Object.entries(contributors)) {
        if (!Array.isArray(usernames) || usernames.length === 0) {
            throw new Error(`Translation contributors for '${localeId}' must be a non-empty array`)
        }
        if (new Set(usernames).size !== usernames.length) {
            throw new Error(`Translation contributors for '${localeId}' contain duplicates`)
        }
        for (const username of usernames) {
            if (typeof username !== 'string' || !GITHUB_USERNAME.test(username)) {
                throw new Error(`Invalid GitHub username for translation locale '${localeId}'`)
            }
        }
    }

    return contributors as TranslationContributors
}

function contributorLinks(usernames: string[] | undefined) {
    if (!usernames) return '-'
    return [...usernames]
        .sort()
        .map((username) => `[${username}](https://github.com/${username})`)
        .join(', ')
}

function buildLocaleRows(inspection: Inspection, contributors: TranslationContributors) {
    const localeIds = new Set([
        inspection.sourceLocale,
        ...inspection.locales.map((locale) => locale.id),
    ])
    for (const localeId of Object.keys(contributors)) {
        if (!localeIds.has(localeId)) {
            throw new Error(`Translation contributors reference unknown locale '${localeId}'`)
        }
    }

    return {
        sourceLocale: inspection.sourceLocale,
        names: Object.fromEntries([
            [inspection.sourceLocale, localeNativeName(inspection.sourceLocale)],
            ...inspection.locales.map((locale) => [locale.id, localeNativeName(locale.id)]),
        ]),
        contributors,
    }
}

function renderImage(layout: ReadmeLayout, locale: string, alt: string) {
    return `<img src="${readmeLink(layout, `${layout.statusAssetDir}/${locale}.svg`)}" alt="${escapeHtmlAttribute(alt)}">`
}

function renderSourceRow(layout: ReadmeLayout, summary: SourceStatusSummary, metadata: Metadata) {
    const rawName = metadata.names[summary.locale]
    const name = escapeMarkdownLinkText(rawName)
    const alt = `English source: ${summary.total} valid strings.`
    return `| [${name} (${summary.locale})](${readmeLink(layout, `${layout.localeDir}/${summary.locale}.json`)}) | ${renderImage(layout, summary.locale, alt)} Complete | ${contributorLinks(metadata.contributors[summary.locale])} |`
}

function renderTargetRow(layout: ReadmeLayout, summary: TargetStatusSummary, metadata: Metadata) {
    const status = deriveTargetStatus(summary)
    const rawName = metadata.names[summary.locale]
    const name = escapeMarkdownLinkText(rawName)
    const fallback = status.usesEnglishFallback
        ? ` ${targetFallbackLabel(status.usesEnglishFallback)}.`
        : ''
    const alt = `${rawName} (${summary.locale}): ${summary.accepted} accepted, ${status.pending} review, ${summary.missing} missing; ${status.label}.${fallback}`
    const fallbackLine = status.usesEnglishFallback
        ? `<br><sub>${targetFallbackLabel(status.usesEnglishFallback)}</sub>`
        : ''
    return `| [${name} (${summary.locale})](${readmeLink(layout, `${layout.localeDir}/${summary.locale}.json`)}) | ${renderImage(layout, summary.locale, alt)} ${status.label}${fallbackLine} | ${contributorLinks(metadata.contributors[summary.locale])} |`
}

function renderLegend(layout: ReadmeLayout) {
    const legend = readmeLink(layout, `${layout.statusAssetDir}/legend`)
    return `<div class="i18n-status-legend"><img src="${legend}/accepted.svg" alt=""> Accepted <img src="${legend}/review.svg" alt=""> Review <img src="${legend}/missing.svg" alt=""> Missing</div>`
}

export function renderTranslationStatusReadme({
    summaries,
    names,
    contributors,
    layout = lexmitConfig(),
}: Metadata & { summaries: StatusSummaries; layout?: ReadmeLayout }) {
    if (!summaries?.source || !Array.isArray(summaries.targets)) {
        throw new Error('README renderer requires source and target summaries')
    }
    const metadata = { names, contributors }
    const rows = [
        '| Language | Translation | Contributors |',
        '| --- | --- | --- |',
        renderSourceRow(layout, summaries.source, metadata),
        ...summaries.targets
            .slice()
            .sort((a, b) => a.locale.localeCompare(b.locale))
            .map((summary) => renderTargetRow(layout, summary, metadata)),
    ]
    // GitHub centers a block-level child of an align="center" div, which text-align alone does
    // not do for a table. The blank lines are what make the table inside parse as Markdown, and
    // the ignore comment must sit directly above the table, or the formatter repads its columns
    // and the generated block does not match this output.
    const centered = [
        '<div align="center">',
        '',
        PRETTIER_IGNORE,
        rows.join('\n'),
        '',
        renderLegend(layout),
        '',
        '</div>',
    ]
    return `${centered.join('\n')}\n\n${translationGuide(layout)}`
}

export function buildTranslationTable(
    inspection: Inspection,
    contributors: TranslationContributors,
    summaries = buildStatusSummaries(inspection),
    layout: ReadmeLayout = lexmitConfig()
) {
    const metadata = buildLocaleRows(inspection, contributors)
    return renderTranslationStatusReadme({ summaries, ...metadata, layout })
}

export function replaceTranslationTable(
    readme: string,
    table: string,
    layout: ReadmeLayout = lexmitConfig()
) {
    const start = readme.indexOf(START_MARKER)
    const end = readme.indexOf(END_MARKER)
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`README.md must contain ${START_MARKER} before ${END_MARKER}`)
    }

    const before = readme.slice(0, start + START_MARKER.length)
    const after = readme.slice(end).replace(`\n\n${translationGuide(layout)}`, '')
    return `${before}\n\n${table}\n\n${after}`
}

export function expectedReadme(
    readme: string,
    {
        i18nDir = lexmitConfig().i18nDir,
        contributorsPath,
        layout = lexmitConfig(),
    }: ReadmeInputs = {}
) {
    const inspection = inspectLocales(i18nDir)
    if (inspection.errors.length > 0) {
        throw new Error(
            `Cannot update README with invalid locales:\n${inspection.errors.join('\n')}`
        )
    }
    const contributors = readTranslationContributors(contributorsPath)
    const table = buildTranslationTable(inspection, contributors, undefined, layout)
    return replaceTranslationTable(readme, table, layout)
}

export function materializeReadme(
    readmePath = resolve(lexmitConfig().root, lexmitConfig().readme),
    inputs: ReadmeInputs = {}
) {
    const current = readFileSync(readmePath, 'utf8')
    const expected = expectedReadme(current, inputs)
    if (expected !== current) writeFileSync(readmePath, expected)
    return expected
}

export function runReadmeCommand(
    args: string[],
    {
        readmePath = resolve(lexmitConfig().root, lexmitConfig().readme),
        i18nDir = lexmitConfig().i18nDir,
        contributorsPath = defaultContributorsPath(),
        layout = lexmitConfig(),
        stdout = process.stdout,
        stderr = process.stderr,
    }: CliIO & ReadmeInputs & { readmePath?: string } = {}
) {
    const supported =
        args.length === 0 ||
        (args.length === 1 && ['--stdout', '--check', '--write'].includes(args[0]!))
    if (!supported) {
        stderr.write('Usage: lexmit readme [--stdout|--check|--write]\n')
        return 2
    }

    const current = readFileSync(readmePath, 'utf8')
    const expected = expectedReadme(current, { i18nDir, contributorsPath, layout })

    if (args[0] === '--stdout') {
        stdout.write(expected)
        return 0
    }

    if (args[0] === '--check') {
        if (expected === current) {
            stdout.write('README.md is current.\n')
            return 0
        }
        stderr.write('lexmit readme: README.md is out of date\n')
        return 1
    }

    if (args[0] === '--write') {
        const expected = materializeReadme(readmePath, { i18nDir, contributorsPath, layout })
        stdout.write(expected === current ? 'README.md is current.\n' : 'Updated README.md.\n')
        return 0
    }

    if (expected === current) {
        stdout.write('README.md is current.\n')
        return 0
    }

    stdout.write('Rendered the expected README in memory. README.md is unchanged.\n')
    return 0
}
