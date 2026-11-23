import assert from 'node:assert/strict'
import test from 'node:test'
import { localeEnglishName, localeNativeName } from './runtime.mts'

function assertNames(localeId: string, nativeName: string, englishName: string) {
    assert.equal(localeNativeName(localeId), nativeName, `native name of ${localeId}`)
    assert.equal(localeEnglishName(localeId), englishName, `English name of ${localeId}`)
}

test('locale names: Chinese region tags use the name of their script', () => {
    assertNames('zh-CN', '简体中文', 'Simplified Chinese')
    assertNames('zh-SG', '简体中文', 'Simplified Chinese')
    assertNames('zh-TW', '繁體中文', 'Traditional Chinese')
    assertNames('zh-HK', '繁體中文', 'Traditional Chinese')
})

test('locale names: tags without a region keep their plain language name', () => {
    assertNames('en', 'English', 'English')
    assertNames('uk', 'Українська', 'Ukrainian')
    assertNames('de', 'Deutsch', 'German')
})

test('locale names: region tags without a dedicated script name use the dialect name', () => {
    assertNames('pt-BR', 'Português (Brasil)', 'Brazilian Portuguese')
    assertNames('de-AT', 'Österreichisches Deutsch', 'Austrian German')
    assertNames('en-GB', 'British English', 'British English')
    assertNames('es-419', 'Español latinoamericano', 'Latin American Spanish')
})

test('locale names: an explicit script is named as written', () => {
    assertNames('sr-Latn', 'Srpski (latinica)', 'Serbian (Latin)')
})

test('locale names: a tag Intl cannot name falls back to the tag without throwing', () => {
    assertNames('zz', 'zz', 'zz')
    assertNames('zz-US', 'zz-US', 'zz-US')
})

test('locale names: a malformed tag falls back to the input without throwing', () => {
    for (const localeId of ['en-', 'not a locale', '']) {
        assertNames(localeId, localeId, localeId)
    }
})
