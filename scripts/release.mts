import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const PARTS = ['patch', 'minor', 'major'] as const
type Part = (typeof PARTS)[number]

export function bumpVersion(version: string, part: Part) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
    if (!match) throw new Error(`package.json version ${version} is not a plain x.y.z version`)
    const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
    if (part === 'major') return `${major + 1}.0.0`
    if (part === 'minor') return `${major}.${minor + 1}.0`
    return `${major}.${minor}.${patch + 1}`
}

// The Unreleased entries move under the new version heading, and an empty Unreleased section
// stays on top for the next change.
export function releaseChangelog(changelog: string, version: string) {
    const heading = '## Unreleased\n'
    const start = changelog.indexOf(heading)
    if (start === -1) throw new Error('CHANGELOG.md has no "## Unreleased" section')
    const bodyStart = start + heading.length
    const next = changelog.indexOf('\n## ', bodyStart)
    const body = changelog.slice(bodyStart, next === -1 ? undefined : next).trim()
    if (body === '') throw new Error('The Unreleased section in CHANGELOG.md is empty')
    return `${changelog.slice(0, bodyStart)}\n## ${version}\n\n${body}\n${next === -1 ? '' : changelog.slice(next)}`
}

function git(args: string[]) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function release(part: Part) {
    if (git(['branch', '--show-current']) !== 'main') throw new Error('Release from main')
    if (git(['status', '--porcelain']) !== '') throw new Error('Commit or stash your changes first')

    const packageText = readFileSync('package.json', 'utf8')
    const current = (JSON.parse(packageText) as { version: string }).version
    const version = bumpVersion(current, part)

    writeFileSync('CHANGELOG.md', releaseChangelog(readFileSync('CHANGELOG.md', 'utf8'), version))
    writeFileSync(
        'package.json',
        packageText.replace(`"version": "${current}"`, `"version": "${version}"`)
    )

    git(['add', 'package.json', 'CHANGELOG.md'])
    git(['commit', '-m', `chore(release): ${version}`])
    git(['tag', '-a', `v${version}`, '-m', `v${version}`])
    process.stdout.write(
        `Created chore(release): ${version} and tag v${version}.\nPublish it with: git push origin main v${version}\n`
    )
}

if (import.meta.main) {
    const part = process.argv[2]
    if (!PARTS.includes(part as Part)) {
        process.stderr.write('Usage: bun release patch|minor|major\n')
        process.exit(2)
    }
    try {
        release(part as Part)
    } catch (error) {
        process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
    }
}
