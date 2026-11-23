import crypto from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export type LocaleBundle = { [key: string]: string | LocaleBundle }

const DEFAULT_INDENT = '    '

export function serializeLocale(locale: LocaleBundle, indent = DEFAULT_INDENT): string {
    return `${JSON.stringify(locale, null, indent)}\n`
}

export function detectIndent(text: string) {
    return /^\{\r?\n([ \t]+)"/u.exec(text)?.[1] ?? DEFAULT_INDENT
}

// A rewritten file keeps its own indentation, so a project's formatter and lexmit never undo
// each other's output. A language file that does not exist yet takes the English file's.
export function localeIndent(filePath: string) {
    const template = fs.existsSync(filePath) ? filePath : resolve(dirname(filePath), 'en.json')
    if (!fs.existsSync(template)) return DEFAULT_INDENT
    return detectIndent(fs.readFileSync(template, 'utf8'))
}

// fs and crypto are called through their module objects so files.test.mts can replace
// single methods. Named imports bind at load time and would keep the real functions.
export function writeSerializedFileAtomically(filePath: string, serialized: string): boolean {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === serialized) return false

    const temporaryPath = resolve(
        dirname(filePath),
        `.${basename(filePath)}.${crypto.randomUUID()}.tmp`
    )
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })

    try {
        fs.renameSync(temporaryPath, filePath)
    } catch (error) {
        try {
            fs.unlinkSync(temporaryPath)
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `Failed to replace '${filePath}' and remove temporary file '${temporaryPath}'`,
                { cause: cleanupError }
            )
        }
        throw new Error(`Failed to replace locale file '${filePath}'`, { cause: error })
    }
    return true
}

export function writeLocaleAtomically(filePath: string, locale: LocaleBundle): boolean {
    return writeSerializedFileAtomically(filePath, serializeLocale(locale, localeIndent(filePath)))
}
