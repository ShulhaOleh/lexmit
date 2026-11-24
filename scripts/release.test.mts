import assert from 'node:assert/strict'
import test from 'node:test'
import { bumpVersion, releaseChangelog } from './release.mts'

test('versions bump by the requested part and reset the lower parts', () => {
    assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1')
    assert.equal(bumpVersion('0.1.3', 'minor'), '0.2.0')
    assert.equal(bumpVersion('0.4.2', 'major'), '1.0.0')
    assert.throws(() => bumpVersion('0.2.0-beta.1', 'patch'), /plain x\.y\.z/u)
})

test('released entries move under the new version and Unreleased starts empty', () => {
    const changelog = [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '### Fixed',
        '',
        '- A fix.',
        '',
        '## 0.1.0',
        '',
        '- First release.',
        '',
    ].join('\n')
    assert.equal(
        releaseChangelog(changelog, '0.1.1'),
        [
            '# Changelog',
            '',
            '## Unreleased',
            '',
            '## 0.1.1',
            '',
            '### Fixed',
            '',
            '- A fix.',
            '',
            '## 0.1.0',
            '',
            '- First release.',
            '',
        ].join('\n')
    )
})

test('a release with nothing under Unreleased is refused', () => {
    assert.throws(
        () => releaseChangelog('# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- First.\n', '0.1.1'),
        /Unreleased section in CHANGELOG\.md is empty/u
    )
    assert.throws(() => releaseChangelog('# Changelog\n', '0.1.1'), /no "## Unreleased"/u)
})
