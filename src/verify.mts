import { errorMessage, type CliIO } from './io.mts'
import type { LocaleBundle } from './files.mts'
import type { HistoryAnalysis, HistoryGit } from './history.mts'
import type { HistoryEvent, HistorySnapshot } from './history-events.mts'
import type { SyncPlan, SyncOperation } from './sync.mts'
import { serializeLocale } from './files.mts'
import { formatTargetValue, TARGET_VALUE_KIND } from './runtime.mts'
import { HISTORY_EVENT } from './history-events.mts'
import { CONFIG_FILE, lexmitConfig, loadConfig } from './config.mts'
import {
    analyzeAdoptingSnapshot,
    analyzeCommittedHistory,
    analyzeRepairableProspective,
    stagedSnapshot,
    assertHistoryDecisionEvidence,
    formatHistoryBaseline,
    workingTreeSnapshot,
} from './history.mts'
import { createGitAdapter } from './git.mts'
import { planI18nSync, validatePlannedBundles } from './sync.mts'

type EnforcementOptions = {
    cwd?: string
    localeDir?: string
    baseline?: string
    snapshot?: HistorySnapshot
    git?: HistoryGit & Pick<ReturnType<typeof createGitAdapter>, 'stagedChangedPaths'>
}
type AnalysisOptions = EnforcementOptions & { adopting?: boolean }
type EnforcementResult = {
    pass: boolean
    skipped: boolean
    history?: Pick<HistoryAnalysis, 'baseline' | 'baselineOrigin'>
    operations: { locale: string; key: string; kind: string }[]
    allOperations: SyncOperation[]
    workflowSummary?: ReturnType<typeof summarizeWorkflow>
    unsynchronized?: { locale: string; key: string; kind: string }[]
}
type WorkflowItem = { locale?: string; key: string }

function setPath(root: LocaleBundle, dottedKey: string, value: string) {
    const parts = dottedKey.split('.')
    let cursor = root
    for (const part of parts.slice(0, -1)) {
        cursor[part] ??= {}
        cursor = cursor[part] as LocaleBundle
    }
    cursor[parts.at(-1)!] = value
}

function snapshotBundles(snapshot: HistorySnapshot) {
    const sourceBundle: LocaleBundle = {}
    for (const [key, value] of snapshot.source) setPath(sourceBundle, key, value)

    const locales = new Map<string, LocaleBundle>()
    for (const [localeId, locale] of snapshot.locales) {
        const bundle: LocaleBundle = {}
        for (const [key, value] of locale.targets) {
            const stored = formatTargetValue(value)
            if (stored !== undefined) setPath(bundle, key, stored)
        }
        locales.set(localeId, bundle)
    }
    return { sourceBundle, locales }
}

function relevantPath(path: string, localeDir: string) {
    const normalized = path.replaceAll('\\', '/')
    return (
        normalized === `${localeDir}/en.json` ||
        (normalized.startsWith(`${localeDir}/`) && normalized.endsWith('.json'))
    )
}

function comparePlan(plan: SyncPlan, current: { locales: Map<string, LocaleBundle> }) {
    const operations = plan.locales.flatMap((locale) => locale.operations)
    const differences: { locale: string; key: string; kind: string }[] = []
    for (const locale of plan.locales) {
        const expected = serializeLocale(locale.bundle)
        const actual = serializeLocale(current.locales.get(locale.id) ?? {})
        if (expected !== actual) {
            differences.push(
                ...(locale.operations.length > 0
                    ? locale.operations
                    : [{ locale: locale.id, key: '<locale>', kind: 'serialization-drift' }])
            )
        }
    }
    return { differences, operations }
}

const TARGET_EDIT_EVENTS = new Set<string>([
    HISTORY_EVENT.FIRST_TRANSLATION,
    HISTORY_EVENT.ACCEPTED_EDIT,
    HISTORY_EVENT.EDIT_FROM_PENDING,
    HISTORY_EVENT.PENDING_EDIT,
])

export function summarizeWorkflow({
    history,
    baseSnapshot,
    currentSnapshot,
}: {
    history: { prospectiveEvents?: Pick<HistoryEvent, 'kind' | 'locale' | 'key'>[] }
    baseSnapshot?: Pick<HistorySnapshot, 'locales'>
    currentSnapshot: Pick<HistorySnapshot, 'locales'>
}) {
    const summary: Record<
        | 'targetContentEdits'
        | 'keeps'
        | 'newlyPending'
        | 'scaffoldsAdded'
        | 'scaffoldsRefreshed'
        | 'scaffoldsRemoved'
        | 'sourceReturnClears',
        WorkflowItem[]
    > = {
        targetContentEdits: [],
        keeps: [],
        newlyPending: [],
        scaffoldsAdded: [],
        scaffoldsRefreshed: [],
        scaffoldsRemoved: [],
        sourceReturnClears: [],
    }
    for (const event of history.prospectiveEvents ?? []) {
        const item = { locale: event.locale, key: event.key }
        if (TARGET_EDIT_EVENTS.has(event.kind)) summary.targetContentEdits.push(item)
        if (event.kind === HISTORY_EVENT.KEEP) summary.keeps.push(item)
        if (
            event.kind === HISTORY_EVENT.SOURCE_TRIGGERED_PENDING ||
            event.kind === HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED
        ) {
            summary.newlyPending.push(item)
        }
        if (event.kind === HISTORY_EVENT.SCAFFOLD_CREATED) summary.scaffoldsAdded.push(item)
        if (event.kind === HISTORY_EVENT.SCAFFOLD_REFRESHED) summary.scaffoldsRefreshed.push(item)
        if (event.kind === HISTORY_EVENT.SOURCE_RETURN_CLEARED)
            summary.sourceReturnClears.push(item)
    }
    const baseLocales = baseSnapshot?.locales ?? new Map()
    for (const [localeId, baseLocale] of baseLocales) {
        const currentLocale = currentSnapshot.locales.get(localeId)
        for (const [key, value] of baseLocale.targets) {
            if (value.kind !== TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) continue
            if (!currentLocale?.targets.has(key))
                summary.scaffoldsRemoved.push({ locale: localeId, key })
        }
    }
    return summary
}

export function formatWorkflowSummary(summary: ReturnType<typeof summarizeWorkflow>) {
    const labels = [
        ['targetContentEdits', 'target-content edits'],
        ['keeps', 'accepted unchanged / Keeps'],
        ['newlyPending', 'newly Pending reviews'],
        ['scaffoldsAdded', 'scaffolds added'],
        ['scaffoldsRefreshed', 'scaffolds refreshed'],
        ['scaffoldsRemoved', 'scaffolds removed'],
        ['sourceReturnClears', 'source-return clears'],
    ] as const
    return labels
        .filter(([key]) => summary[key].length > 0)
        .map(([key, label]) => `${label}: ${summary[key].length}`)
        .join(', ')
}

export function summarizeEnforcementOperations(operations: { kind: string }[]) {
    const counts = new Map()
    for (const operation of operations)
        counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1)
    return [...counts.entries()].map(([kind, count]) => `${kind}: ${count}`).join(', ')
}

export function stagedI18nPaths({
    cwd = process.cwd(),
    localeDir = lexmitConfig().localeDir,
    git,
}: EnforcementOptions = {}) {
    const adapter = git ?? createGitAdapter({ cwd })
    return adapter.stagedChangedPaths().filter((path) => relevantPath(path, localeDir))
}

// Both gates need the same reconstruction: committed history, the candidate tree read as one
// further transition, and the synchronization plan that tree implies. They differ only in what
// they conclude from it, so the analysis is built once here and judged twice below.
function analyzeSnapshot({
    cwd = lexmitConfig().root,
    localeDir = lexmitConfig().localeDir,
    baseline,
    snapshot,
    git,
    adopting = false,
}: AnalysisOptions = {}) {
    const adapter = git ?? createGitAdapter({ cwd })
    const history = adopting
        ? undefined
        : analyzeCommittedHistory({ cwd, localeDir, baseline, git: adapter })
    const currentSnapshot = snapshot ?? workingTreeSnapshot(cwd, localeDir)
    const committed = history ?? analyzeAdoptingSnapshot(currentSnapshot)
    if (currentSnapshot.source.size === 0) {
        throw new Error('Staged/current English source locale is missing')
    }
    const missingLocales = [...committed.snapshot.locales.keys()].filter(
        (localeId) => !currentSnapshot.locales.has(localeId)
    )
    if (missingLocales.length > 0) {
        throw new Error(`Staged/current target locale is missing: ${missingLocales.join(', ')}`)
    }
    const prospective = analyzeRepairableProspective(committed, currentSnapshot)
    assertHistoryDecisionEvidence(prospective)
    const { sourceBundle, locales } = snapshotBundles(currentSnapshot)

    // Plan validation distinguishes translation errors from derived marker debt. Deferring a
    // placeholder mismatch requires proven source-change provenance.
    const plan = planI18nSync({ history: prospective, sourceBundle })
    validatePlannedBundles(plan)

    return {
        history: prospective,
        plan,
        comparison: comparePlan(plan, { locales }),
        workflowSummary: summarizeWorkflow({
            history: prospective,
            baseSnapshot: committed.snapshot,
            currentSnapshot,
        }),
    }
}

// Is this tree valid translation data? A source-only change is, and so is a translation whose
// English moved before the bot wrote its marker. Reaching this return means the plan validated.
export function checkI18nSemantics(options: EnforcementOptions = {}) {
    return semanticResult(analyzeSnapshot(options))
}

function semanticResult(analysis: ReturnType<typeof analyzeSnapshot>) {
    return {
        pass: true,
        skipped: false as const,
        history: analysis.history,
        plan: analysis.plan,
        operations: [],
        allOperations: analysis.comparison.operations,
        unsynchronized: analysis.comparison.differences,
        workflowSummary: analysis.workflowSummary,
    }
}

// Has the bot caught up? Only the writer's own post-generation check and an explicit local
// run ask this. It must never gate a contributor's commit.
export function checkI18nSnapshot(options: EnforcementOptions = {}) {
    const analysis = analyzeSnapshot(options)
    return {
        pass: analysis.comparison.differences.length === 0,
        skipped: false,
        history: analysis.history,
        plan: analysis.plan,
        operations: analysis.comparison.differences,
        allOperations: analysis.comparison.operations,
        workflowSummary: analysis.workflowSummary,
    }
}

// The config sits at the repository root, so its staged path is the bare file name.
function adoptsConfig(
    cwd: string,
    git: Pick<HistoryGit, 'resolveRevision' | 'treeBlobs'>,
    staged: string[]
) {
    if (!staged.includes(CONFIG_FILE)) return false
    if (git.resolveRevision('HEAD') && git.treeBlobs('HEAD', CONFIG_FILE).size > 0) return false
    return loadConfig(cwd).historyBaseline === undefined
}

export function checkStagedI18n(options: EnforcementOptions = {}) {
    const cwd = options.cwd ?? lexmitConfig().root
    const localeDir = options.localeDir ?? lexmitConfig().localeDir
    const git = options.git ?? createGitAdapter({ cwd })
    const staged = git.stagedChangedPaths()
    // A pre-commit hook on the adopting commit has no committed baseline yet. The staged files
    // are the baseline to be, so they are checked alone and the commit can pass its own hook.
    if (options.baseline === undefined && adoptsConfig(cwd, git, staged)) {
        const snapshot = stagedSnapshot(git, localeDir)
        return semanticResult(
            analyzeSnapshot({ ...options, cwd, localeDir, git, snapshot, adopting: true })
        )
    }
    if (!staged.some((path) => relevantPath(path, localeDir))) {
        return { pass: true, skipped: true as const, operations: [], allOperations: [] }
    }
    return checkI18nSemantics({
        ...options,
        cwd,
        localeDir,
        git,
        snapshot: stagedSnapshot(git, localeDir),
    })
}

export function formatEnforcementFailure(result: {
    operations: { locale: string; key: string; kind: string }[]
}) {
    const lines = ['Derived i18n markers are not synchronized.', '']
    if (result.operations.length > 0) {
        lines.push('Planned operations:')
        for (const operation of result.operations) {
            lines.push(`  ${operation.locale} ${operation.key} (${operation.kind})`)
        }
        lines.push('')
    }
    lines.push('Run:', '  lexmit sync', '', 'Then stage the updated locale files.')
    return lines.join('\n')
}

const MODES = new Set(['--staged', '--synchronized'])

export function runI18nEnforcement(
    args: string[],
    {
        stdout = process.stdout,
        stderr = process.stderr,
        ...options
    }: CliIO & EnforcementOptions = {}
) {
    if (args.length > 1 || (args.length === 1 && !MODES.has(args[0]!))) {
        stderr.write('Usage: lexmit verify [--staged|--synchronized]\n')
        return 2
    }
    const synchronized = args[0] === '--synchronized'
    const label = synchronized ? 'Synchronization check' : 'Semantic check'
    try {
        const result: EnforcementResult = synchronized
            ? checkI18nSnapshot(options)
            : args[0] === '--staged'
              ? checkStagedI18n(options)
              : checkI18nSemantics(options)
        if (result.skipped) {
            stdout.write(`${label} skipped (no staged locale/source files).\n`)
            return 0
        }
        const baseline =
            result.history &&
            formatHistoryBaseline(result.history.baseline, result.history.baselineOrigin)
        if (baseline) stdout.write(`${baseline}\n`)
        if (!result.pass) {
            stderr.write(`${formatEnforcementFailure(result)}\n`)
            return 1
        }
        const details = [
            result.allOperations.length ? summarizeEnforcementOperations(result.allOperations) : '',
            result.workflowSummary ? formatWorkflowSummary(result.workflowSummary) : '',
        ].filter(Boolean)
        stdout.write(`${label} passed${details.length ? ` (${details.join('; ')})` : ''}.\n`)
        // Marker work the bot still owes is reported, never charged to this tree.
        if (result.unsynchronized && result.unsynchronized.length > 0) {
            stdout.write(
                `${result.unsynchronized.length} derived marker update(s) pending. The translation status workflow writes them.\n`
            )
        }
        return 0
    } catch (error) {
        const command = synchronized ? 'lexmit verify --synchronized' : 'lexmit verify'
        stderr.write(`${command}: ${errorMessage(error)}\n`)
        return 1
    }
}
