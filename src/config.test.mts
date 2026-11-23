import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONFIG_FILE, loadConfig, parseConfig } from './config.mts'

const VALID = {
    historyBaseline: 'da1040c9f04d7e004d5cd1fee3af15fabaa80b7e',
    localeDir: 'apps/desktop/src/renderer/src/i18n',
    readme: 'README.md',
    statusAssetDir: 'assets/i18n/status',
    contributorsFile: 'apps/desktop/translation-contributors.generated.json',
    translationGuide: 'docs/contributing/translating.md',
}

function parseWith(overrides: Record<string, unknown>) {
    return () => parseConfig(JSON.stringify({ ...VALID, ...overrides }))
}

test('the config is found from a directory below the repository root', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'lexmit-config-'))
    context.after(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(VALID))
    const nested = join(root, 'apps', 'desktop')
    mkdirSync(nested, { recursive: true })

    const config = loadConfig(nested)
    assert.equal(config.root, root)
    assert.equal(config.i18nDir, join(root, VALID.localeDir))
    assert.equal(config.historyBaseline, VALID.historyBaseline)
})

test('a missing config names the directory the search started from', (context) => {
    const start = mkdtempSync(join(tmpdir(), 'lexmit-no-config-'))
    context.after(() => rmSync(start, { recursive: true, force: true }))
    assert.throws(() => loadConfig(start), new RegExp(`${CONFIG_FILE} was not found`, 'u'))
})

test('config accepts repository relative paths and a full commit id', () => {
    assert.deepEqual(parseConfig(JSON.stringify(VALID)), VALID)
})

test('config rejects unknown and missing keys', () => {
    assert.throws(parseWith({ localDir: 'i18n' }), /unknown key\(s\) localDir/u)
    assert.throws(parseWith({ readme: undefined }), /readme must be/u)
    assert.throws(() => parseConfig('[]'), /must hold a JSON object/u)
})

test('config rejects paths Git would never report', () => {
    for (const localeDir of [
        '',
        '/abs/i18n',
        'C:/i18n',
        'apps\\i18n',
        './i18n',
        'apps/../i18n',
        'apps/i18n/',
        'apps//i18n',
    ]) {
        assert.throws(parseWith({ localeDir }), /localeDir must be/u, JSON.stringify(localeDir))
    }
})

test('config rejects a contributors file that would be read as a language', () => {
    assert.throws(
        parseWith({ localeDir: 'locales', contributorsFile: 'locales/contributors.json' }),
        /contributorsFile must be outside localeDir/u
    )
    assert.doesNotThrow(
        parseWith({ localeDir: 'locales', contributorsFile: 'locales-contributors.json' })
    )
})

test('config rejects an abbreviated or symbolic history baseline', () => {
    for (const historyBaseline of [
        'da1040c9',
        'HEAD',
        'DA1040C9F04D7E004D5CD1FEE3AF15FABAA80B7E',
    ]) {
        assert.throws(parseWith({ historyBaseline }), /historyBaseline must be a full/u)
    }
})
