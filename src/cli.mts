#!/usr/bin/env node
import { runI18nCli } from './translate.mts'
import { runI18nEnforcement } from './verify.mts'
import { errorMessage } from './io.mts'
import { runI18nPresentationLifecycle } from './presentation.mts'
import { runI18nTreeState } from './tree-state.mts'
import { runI18nWriterGuard } from './guard.mts'
import { updateTranslationContributors } from './contributors.mts'
import { runReadmeCommand } from './readme.mts'

type Command = (args: string[]) => number | Promise<number>

// The translator commands share one parser keyed on a leading flag.
function translatorCommand(flag: string): Command {
    return (args) => runI18nCli([flag, ...args])
}

const COMMANDS: Record<string, Command> = {
    help: translatorCommand('--help'),
    status: translatorCommand('--status'),
    check: (args) => runI18nCli(args),
    missing: translatorCommand('--missing'),
    fill: translatorCommand('--fill'),
    create: translatorCommand('--create'),
    translate: translatorCommand('--translate'),
    review: translatorCommand('--review'),
    sync: translatorCommand('--sync'),
    verify: runI18nEnforcement,
    presentation: runI18nPresentationLifecycle,
    readme: runReadmeCommand,
    guard: runI18nWriterGuard,
    'tree-state': runI18nTreeState,
    contributors: async (args) => {
        if (args.length > 0) {
            process.stderr.write('Usage: lexmit contributors\n')
            return 2
        }
        await updateTranslationContributors()
        return 0
    },
}

const [name = 'help', ...args] = process.argv.slice(2)
const command = COMMANDS[name]
if (!command) {
    process.stderr.write(`lexmit: unknown command '${name}'. Run lexmit help for the list.\n`)
    process.exitCode = 2
} else {
    try {
        process.exitCode = await command(args)
    } catch (error) {
        process.stderr.write(`lexmit ${name}: ${errorMessage(error)}\n`)
        process.exitCode = 1
    }
}
