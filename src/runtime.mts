export const TARGET_VALUE_KIND = Object.freeze({
    ABSENT: 'absent',
    ACCEPTED: 'accepted',
    PENDING: 'pending',
    UNTRANSLATED_SCAFFOLD: 'untranslated-scaffold',
} as const)

export const PENDING_PREFIX = '? '
export const UNTRANSLATED_PREFIX = '! '

export type SourceValue = {
    kind: 'source'
    sourceText: string
    placeholderContract: string[]
}

export type TargetValue =
    | { kind: 'absent' }
    | { kind: 'untranslated-scaffold'; sourceText: string }
    | { kind: 'pending'; targetText: string; placeholderContract: string[] }
    | { kind: 'accepted'; targetText: string; placeholderContract: string[] }

export function placeholderContract(text: string): string[] {
    return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
}

function missingPlaceholders(expected: readonly string[], actual: readonly string[]): string[] {
    const remaining = [...actual]
    return expected.filter((name) => {
        const index = remaining.indexOf(name)
        if (index === -1) return true
        remaining.splice(index, 1)
        return false
    })
}

export function placeholderDifferences(expected: readonly string[], actual: readonly string[]) {
    return {
        missing: missingPlaceholders(expected, actual),
        unexpected: missingPlaceholders(actual, expected),
    }
}

export function parseSourceValue(sourceText: unknown): SourceValue {
    if (typeof sourceText !== 'string') {
        throw new TypeError('Source locale values must be strings')
    }

    return {
        kind: 'source',
        sourceText,
        placeholderContract: placeholderContract(sourceText),
    }
}

export function parseTargetValue(storedValue: unknown): TargetValue {
    if (storedValue === undefined) return { kind: TARGET_VALUE_KIND.ABSENT }
    if (typeof storedValue !== 'string') {
        throw new TypeError('Target locale values must be strings or absent')
    }

    if (storedValue.startsWith(UNTRANSLATED_PREFIX)) {
        const sourceText = storedValue.slice(UNTRANSLATED_PREFIX.length)
        if (sourceText.length === 0) {
            throw new Error('Untranslated scaffold payload must not be empty')
        }
        return { kind: TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD, sourceText }
    }

    if (storedValue.startsWith(PENDING_PREFIX)) {
        const targetText = storedValue.slice(PENDING_PREFIX.length)
        if (targetText.length === 0) {
            throw new Error('Pending target payload must not be empty')
        }
        if (targetText.startsWith(UNTRANSLATED_PREFIX) || targetText.startsWith(PENDING_PREFIX)) {
            throw new Error('Pending target payload must not begin with a workflow marker')
        }
        return {
            kind: TARGET_VALUE_KIND.PENDING,
            targetText,
            placeholderContract: placeholderContract(targetText),
        }
    }

    return {
        kind: TARGET_VALUE_KIND.ACCEPTED,
        targetText: storedValue,
        placeholderContract: placeholderContract(storedValue),
    }
}

// Absent targets have no stored form and must remain undefined.
export function formatTargetValue(value: TargetValue): string | undefined {
    if (value.kind === TARGET_VALUE_KIND.ACCEPTED) return value.targetText
    if (value.kind === TARGET_VALUE_KIND.PENDING) return `${PENDING_PREFIX}${value.targetText}`
    if (value.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
        return `${UNTRANSLATED_PREFIX}${value.sourceText}`
    }
    return undefined
}

export function usableTargetText(
    sourceValue: SourceValue,
    targetValue: TargetValue
): string | undefined {
    if (
        targetValue.kind === TARGET_VALUE_KIND.ABSENT ||
        targetValue.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD
    ) {
        return undefined
    }

    const { missing, unexpected } = placeholderDifferences(
        sourceValue.placeholderContract,
        targetValue.placeholderContract
    )
    if (missing.length > 0 || unexpected.length > 0) return undefined
    return targetValue.targetText
}

export function resolveTargetValue(sourceValue: SourceValue, targetValue: TargetValue): string {
    return usableTargetText(sourceValue, targetValue) ?? sourceValue.sourceText
}

// A tag with a region but no script names the region, so zh-CN reads "Chinese (China)" where
// people expect "Simplified Chinese". The dialect form of language-script differs from the
// standard form only when the locale data has a dedicated name for that pair. Comparing the two
// asks the data itself instead of parsing parentheses that vary between ICU versions.
function languageName(localeId: string, displayLocale: string): string {
    try {
        const dialect = new Intl.DisplayNames([displayLocale], {
            type: 'language',
            languageDisplay: 'dialect',
            fallback: 'none',
        })
        const locale = new Intl.Locale(localeId)
        let name: string | undefined
        if (locale.region && !locale.script) {
            const script = locale.maximize().script
            if (script) {
                const languageScript = `${locale.language}-${script}`
                const standard = new Intl.DisplayNames([displayLocale], {
                    type: 'language',
                    languageDisplay: 'standard',
                    fallback: 'none',
                })
                const scriptName = dialect.of(languageScript)
                if (scriptName && scriptName !== standard.of(languageScript)) name = scriptName
            }
        }
        name ??= dialect.of(localeId)
        if (!name || name === localeId) return localeId
        // A language picker shows each name as a label, but engines disagree on whether a
        // language's own name starts with a capital.
        return name.charAt(0).toLocaleUpperCase(displayLocale) + name.slice(1)
    } catch {
        // A missing name must never break a page or a command. The tag still identifies the
        // language.
        return localeId
    }
}

export function localeNativeName(localeId: string): string {
    return languageName(localeId, localeId)
}

export function localeEnglishName(localeId: string): string {
    return languageName(localeId, 'en')
}
