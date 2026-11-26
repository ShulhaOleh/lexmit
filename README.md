# lexmit

Translation status for JSON locale files, reconstructed from Git history.

lexmit tracks every string of every language in one of three states, and it works them out
from your commits rather than trusting whatever a file currently says:

| State    | Meaning                                               | How it is stored                |
| -------- | ----------------------------------------------------- | ------------------------------- |
| Accepted | Translated, and accepted for the current English      | the translation                 |
| Review   | Translated, but English changed since it was accepted | `? ` before the translation     |
| Missing  | Not translated yet                                    | absent, or `! ` and the English |

Developers only ever edit the English file. A bot writes the `!` and `?` markers, the
translator credits, a status table in your README and one status image per language, then
checks that it changed nothing else before it commits.

## Used by

<p align="center">
  <a href="https://github.com/RefractMC/Refract_MC">
    <img src="https://raw.githubusercontent.com/RefractMC/Refract_MC/main/logo/refract-iris-256.png" alt="Refract" height="96" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/RefractMC/Refract_MC"><strong>Refract</strong></a>, a fast, open-source Minecraft launcher
</p>

<br/>

<p align="center">
  <a href="https://github.com/modrexio/modrex">
    <img src="https://raw.githubusercontent.com/modrexio/modrex/main/assets/icon.png" alt="Modrex" height="96" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/modrexio/modrex"><strong>Modrex</strong></a>, a mod manager that installs game mods without opening the game folder
</p>

## Requirements

- Node.js 22 or newer, or Bun
- A Git repository with full history in CI (`fetch-depth: 0`)
- Locale files as one JSON file per language, named by language tag (`en.json`, `de.json`,
  `zh-CN.json`), with English as the source. Keys may nest. Every value must be a string.
- LF line endings in checkouts, set with `* text=auto eol=lf` in `.gitattributes`, if anyone
  runs lexmit on Windows

## Install

```sh
npm install --save-dev --save-exact @shulha/lexmit
```

The command it installs is `lexmit`.

## Configure

Add `lexmit.config.json` at the root of your repository. Every path is relative to the root
and uses forward slashes.

```json
{
    "localeDir": "locales",
    "readme": "README.md",
    "statusAssetDir": "assets/i18n/status",
    "contributorsFile": "translation-contributors.generated.json",
    "translationGuide": "locales/README.md"
}
```

| Field              | What it is                                               |
| ------------------ | -------------------------------------------------------- |
| `historyBaseline`  | Optional. Full id of the commit that history starts from |
| `localeDir`        | The folder holding `en.json` and the other languages     |
| `readme`           | The file that gets the status table                      |
| `statusAssetDir`   | Where the per-language status images are written         |
| `contributorsFile` | Where translator credits are stored, outside `localeDir` |
| `translationGuide` | The guide the status table links translators to          |
| `maintainers`      | Optional GitHub logins treated like repository admins    |

History replay starts at a baseline commit, and every unmarked translation in that commit counts
as Accepted. Without `historyBaseline`, the baseline is the commit that added
`lexmit.config.json`. Git finds that commit again after a squash merge, a merge commit or a
rebase merge, so nothing needs updating once the pull request lands. Set `historyBaseline` only
to start history somewhere else. `lexmit verify` and `lexmit status` print the baseline in use.

The locale files at the baseline have to be valid. To adopt lexmit, fix any check errors and add
the config in the same pull request as the locale fixes, no earlier than the commit that fixes
them.

`maintainers` lists GitHub logins treated as maintainers in addition to repository admins, for
example a maintainer's second account. Maintainers are credited only for languages they created.
GitHub does not show which accounts belong to the same person, so lexmit cannot find these by
itself. Leave the field out if there are none.

Mark where the status table goes in your README:

```md
<!-- TRANSLATION_STATUS_START -->
<!-- TRANSLATION_STATUS_END -->
```

The table uses three legend images. Copy them once into a `legend` folder inside your
`statusAssetDir`:

```sh
mkdir -p assets/i18n/status/legend
cp node_modules/@shulha/lexmit/assets/legend/*.svg assets/i18n/status/legend/
```

## Commands

| Command                       | What it does                                           |
| ----------------------------- | ------------------------------------------------------ |
| `lexmit help`                 | Show the translator workflow                           |
| `lexmit status`               | Coverage for every language, from the stored markers   |
| `lexmit check [locale]`       | Validate English or one language                       |
| `lexmit missing <locale>`     | List missing keys with their English text              |
| `lexmit create <locale>`      | Start a new language filled with marked English        |
| `lexmit fill <locale>`        | Add marked English for keys a language is missing      |
| `lexmit translate <locale>`   | Translate a language interactively                     |
| `lexmit review <locale>`      | Keep or edit translations whose English changed        |
| `lexmit sync`                 | Write the `!` and `?` markers                          |
| `lexmit verify`               | Check translation data against Git history, for CI     |
| `lexmit verify --staged`      | The same check for staged files, for a pre-commit hook |
| `lexmit presentation --check` | Check that the README table and images are current     |
| `lexmit presentation --write` | Write the README table and images                      |

## Terminal output

`lexmit status` draws a coverage bar for each language only when it writes to a terminal. Piped or
redirected output is one plain line per language. The bar shrinks from 40 cells to 32 to fit the
terminal, and a terminal too narrow for a 32-cell bar gets rows without bars. When the terminal does
not report its width, lexmit reads `COLUMNS`, and when that is not set either, it draws the 40-cell
bar. Set `COLUMNS` to pass the width yourself:

```sh
COLUMNS=120 lexmit status
```

`NO_COLOR`, `CI` (unless empty or `0`) and `TERM=dumb` each switch to the plain output, even in a
terminal.

## In your app

Locale files keep the markers in the text, so resolve each string before showing it. The runtime
helper falls back to English for anything missing, marked or with mismatched placeholders:

```ts
import { parseSourceValue, parseTargetValue, resolveTargetValue } from '@shulha/lexmit/runtime'

const text = resolveTargetValue(parseSourceValue(englishText), parseTargetValue(translatedText))
```

`translatedText` may be `undefined` for a key the language does not have yet.

Use the same entry point for the labels in a language picker:

```ts
import { localeEnglishName, localeNativeName } from '@shulha/lexmit/runtime'

localeNativeName('zh-CN') // '简体中文'
localeEnglishName('zh-CN') // 'Simplified Chinese'
```

Both return the tag unchanged when the platform has no name for it.

## In CI

Check every push with full history. lexmit also finds the baseline in that history, so in a
shallow clone it stops rather than pick the wrong commit:

```yaml
- uses: actions/checkout@v7
  with:
      fetch-depth: 0
- uses: actions/setup-node@v4
  with:
      node-version: 22
- run: npm ci
- run: npx lexmit verify
```

## The translation status bot

Call the reusable workflow from your repository, at the tag of the version you installed. It
runs the exact `@shulha/lexmit` version your `package.json` pins, so the bot and your local
commands always agree. A version range is refused. Because the version comes from
`package.json`, the tag only has to change when the [changelog](CHANGELOG.md) lists a change to
the workflow.

```yaml
name: Translation status

on:
    push:
        branches: [main]
        paths: ['locales/*.json', 'lexmit.config.json']
    schedule:
        - cron: '17 4 * * 1'
    workflow_dispatch:

jobs:
    status:
        uses: ShulhaOleh/lexmit/.github/workflows/translation-status.yml@v0.2.0
        permissions:
            contents: write
```

If the `package.json` that pins lexmit is not at the repository root, pass its path as
`package-json`. If your branch rules stop the workflow token from pushing, add a deploy key with
write access as a secret and pass it as `push-key`.

## How it works

[docs/ownership.md](docs/ownership.md) explains who may change what, which check answers which
question, and why acceptance has to be recorded in Git.

## Changes

Each version's changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Origin

lexmit was extracted from [Modrex](https://github.com/modrexio/modrex), where it manages the app's
translations.

## License

lexmit is open source under the [MIT License](LICENSE).
