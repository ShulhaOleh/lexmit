import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const workflow = readFileSync(
    resolve(import.meta.dirname, '../.github/workflows/translation-status.yml'),
    'utf8'
)

function position(text: string) {
    const index = workflow.indexOf(text)
    assert.ok(index >= 0, `workflow is missing ${text}`)
    return index
}

test('the writer validates the source before writing and verifies its own output before committing', () => {
    const sourceCheck = position('must lexmit verify\n')
    const sync = position('must lexmit sync')
    const contributors = position('must lexmit contributors')
    const write = position('must lexmit presentation --write')
    const strict = position('must lexmit verify --synchronized')
    const check = position('must lexmit presentation --check')
    const guard = position('must lexmit guard "$BASE"')
    const commit = position('must git commit')

    assert.ok(sourceCheck < sync)
    assert.ok(sync < contributors && contributors < write)
    assert.ok(write < strict && strict < check)
    assert.ok(check < guard && guard < commit)
})

test('the writer proves a fixed point before the guard', () => {
    // The fixed-point proof compares content, so a generator that rewrites a file it just
    // created cannot pass by leaving the set of changed paths unchanged.
    assert.equal((workflow.match(/lexmit tree-state/gu) ?? []).length, 2)
    assert.ok(workflow.lastIndexOf('lexmit tree-state') < position('must lexmit guard'))
    assert.match(workflow, /must diff \/tmp\/lexmit-pass-one\.txt \/tmp\/lexmit-pass-two\.txt/u)
})

test('the writer stages only the paths its config names and never forces a push', () => {
    assert.match(workflow, /c\.readme, c\.contributorsFile, c\.statusAssetDir, c\.localeDir/u)
    assert.match(workflow, /must git add -- "\$\{OWNED\[@\]\}"/u)
    assert.doesNotMatch(workflow, /git add (-A|\.|--all)\b/u)
    assert.match(workflow, /git diff --cached --quiet/u)
    assert.doesNotMatch(workflow, /push[^\n]*(--force|\+refs|-f\b)/u)
    assert.match(workflow, /docs: update translation status/u)
})

test('the bot installs the exact lexmit version the caller pins in its package.json', () => {
    assert.match(workflow, /package-json:\n\s+description: [^\n]+\n\s+default: package\.json\n/u)
    assert.doesNotMatch(workflow, /lexmit-version/u)
    assert.match(workflow, /PACKAGE_JSON: \$\{\{ inputs\.package-json \}\}/u)
    assert.match(workflow, /must pin @shulha\/lexmit to an exact version/u)
    assert.match(workflow, /npm install --global "@shulha\/lexmit@\$VERSION"/u)
})

test('caller inputs reach the shell only through environment variables', () => {
    for (const line of workflow.split('\n')) {
        if (!line.includes('${{ inputs.')) continue
        assert.match(line, /^\s+(ref|[A-Z_]+): \$\{\{ inputs\.[\w-]+ \}\}$/u, line)
    }
})
