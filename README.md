# lexmit

Translation status for JSON locale files, reconstructed from Git history.

lexmit uses your commits to track each English key in each target language.

| State    | Meaning                                          | How it is stored                       |
| -------- | ------------------------------------------------ | -------------------------------------- |
| Accepted | Translated, and accepted for the current English | the translation                        |
| Review   | A translation exists and needs review            | `? ` before the translation after sync |
| Missing  | Not translated yet                               | absent, or `! ` and the English        |

Developers can change English without editing the other locale files. A bot writes the `!` and
`?` markers, the translator credits, a status table in your README and one status image per
language. It checks that it changed only the files it owns and preserved translated text before
it commits.

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
- Locale files as one JSON file per language, named by canonical language tag (`en.json`,
  `de.json`, `zh-CN.json`), with `en.json` as the source. Keys may nest. Every leaf value must
  be a non-empty string.
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

| Field              | What it is                                                 |
| ------------------ | ---------------------------------------------------------- |
| `historyBaseline`  | Optional. Full 40-character commit ID to start replay from |
| `localeDir`        | The folder holding `en.json` and the other languages       |
| `readme`           | The file that gets the status table                        |
| `statusAssetDir`   | Where the per-language status images are written           |
| `contributorsFile` | Where translator credits are stored, outside `localeDir`   |
| `translationGuide` | The guide the status table links translators to            |
| `maintainers`      | Optional GitHub logins treated like repository admins      |

History replay starts at a baseline commit, where each valid, unmarked translation counts as
Accepted. Without `historyBaseline`, lexmit finds the most recent commit on the branch's
first-parent history that added `lexmit.config.json`. That works after a squash merge, a merge
commit or a rebase merge. If you set `historyBaseline`, use a commit on that first-parent history.
`lexmit verify` and `lexmit status` print the baseline when they can resolve it.

To adopt lexmit, fix any locale errors before or in the commit that adds the config. That commit
becomes the baseline, so later fixes do not change the starting snapshot.

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
`statusAssetDir`. Lexmit manages the SVG files directly inside `statusAssetDir` and removes any
that no longer correspond to a locale.

```sh
mkdir -p assets/i18n/status/legend
cp node_modules/@shulha/lexmit/assets/legend/*.svg assets/i18n/status/legend/
```

For a local `lexmit presentation` run before the bot has generated contributor credits, create
the configured `contributorsFile` with `{}`.

## Commands

| Command                       | What it does                                            |
| ----------------------------- | ------------------------------------------------------- |
| `lexmit help`                 | Show the translator workflow                            |
| `lexmit status`               | Coverage for every language, from the stored markers    |
| `lexmit check [locale]`       | Validate all locales, or English and the named locale   |
| `lexmit missing <locale>`     | List missing keys with their English text               |
| `lexmit create <locale>`      | Start a new language filled with marked English         |
| `lexmit fill <locale>`        | Add, refresh or remove `! ` scaffolds for one locale    |
| `lexmit translate <locale>`   | Translate a language interactively                      |
| `lexmit review <locale>`      | Keep or edit translations that need review              |
| `lexmit sync`                 | Reconcile markers and locale structure across languages |
| `lexmit verify`               | Check translation data against Git history, for CI      |
| `lexmit verify --staged`      | The same check for staged files, for a pre-commit hook  |
| `lexmit presentation --check` | Check that the README table and images are current      |
| `lexmit presentation --write` | Write the README table and images                       |

## Terminal output

`lexmit status` prints a baseline line followed by coverage for each locale. Piped or redirected
output uses plain text. In a color terminal the bar uses up to 40 cells. If fewer than 32 cells
fit beside the longest row, lexmit omits the bars. When the terminal reports no width, lexmit uses
`COLUMNS` if it contains a positive integer with no leading zeroes. If the width is still unknown,
lexmit draws the 40-cell bar.

```sh
COLUMNS=120 lexmit status
```

`NO_COLOR`, `NODE_DISABLE_COLORS` (unless `0`), `CI` (unless empty or `0`) and `TERM=dumb`
each switch to plain output, even in a terminal.

## In your app

Locale files keep the markers in the text, so resolve each string before showing it. The runtime
helper renders a `? ` translation without the marker if its placeholders match English. It falls
back to English for missing values, `! ` scaffolds or placeholder mismatches.

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

Use these steps in your CI job. Fetch full history so lexmit can find the baseline and replay
changes from it.

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

Call the reusable workflow from your repository. The workflow tag selects the workflow itself.
The workflow installs the exact `@shulha/lexmit` version pinned as `x.y.z` in `dependencies` or
`devDependencies` in your `package.json`.

When upgrading the reusable workflow from `v0.1.0` to `v0.2.0`, remove its `lexmit-version` input
and pin `@shulha/lexmit` in `package.json`.

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
`package-json`. For a branch other than `main`, update the push trigger and pass the branch
name as `branch`. The example's push paths assume `localeDir` is `locales`.
If your branch rules stop the workflow token from pushing, you can pass a write-enabled deploy
key as the `push-key` secret if your branch rules allow that key to push.

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
