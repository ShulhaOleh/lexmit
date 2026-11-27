# Translation ownership

lexmit reconstructs translation state from Git history. This page says who is allowed to
change what, and which check enforces which half of that.

## The three states

Every key, in every non-English locale, is in exactly one state. The state is derived from
history, not read off whichever marker the file currently holds.

| State    | Meaning                                                           | Stored form                                              |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Accepted | Acceptance is proven for this target and current English          | the translation, unmarked                                |
| Review   | A target exists, but acceptance for current English is not proven | `? <translation>`, or still unmarked before the bot runs |
| Missing  | There is no usable target                                         | absent, or `! <English>`                                 |

When an English edit leaves an existing translation without acceptance for the new wording, the
translation is in Review as soon as the English commit lands. Developers can edit English on its
own and let the bot write the `? ` marker in a later commit.
`summarizeHistory` in `src/history.mts` exposes this as `effectiveState`, and it is the one
interpretation the validators, the synchronizer, the review command and the CLI summaries all
read.

Missing is not Review. An English scaffold is not an accepted translation. A translation that
happens to match some historical value is not evidence that anyone reviewed the current meaning.

## Who owns what

| Actor                | Owns                                                                            | Must not do                                                   |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Product contributor  | English source strings                                                          | Translate or backfill other locales as incidental work        |
| Language contributor | Translated text, and explicit Keep/Edit review decisions                        | Be required to regenerate status images to pass CI            |
| CI                   | Whether the tree is valid translation data                                      | Reject a tree only because derived output is stale            |
| Bot                  | `!` and `?` markers, contributor attribution, the README block, the status SVGs | Invent translations, change payloads, or accept a new meaning |

## Which check asks which question

Two different questions, deliberately separated. Conflating them would force a contributor to
commit the bot's future output.

| Question                                      | Command                        | Who runs it         |
| --------------------------------------------- | ------------------------------ | ------------------- |
| Is this valid translation data?               | `lexmit verify`                | CI, on every push   |
| Same, restricted to the staged files          | `lexmit verify --staged`       | the pre-commit hook |
| Structural validation plus effective coverage | `lexmit check`                 | CI and contributors |
| Have the locale markers caught up?            | `lexmit verify --synchronized` | the bot only        |
| Have the README and SVGs caught up?           | `lexmit presentation --check`  | the bot only        |

The validity checks pass for a new English key with no translation, for changed English over an
unchanged translation, and for a scaffold quoting superseded English. They fail for a translation
whose `{placeholders}` disagree with English that has not changed, an unknown key holding real
translated text, invalid marker syntax, empty values, and unsafe Unicode.

`lexmit verify` fails when it cannot replay the required history. `lexmit check` can still pass
with an “Effective state unverified” message if the file checks pass and there are no findings
that require history to resolve. `lexmit fill` works in a shallow clone because it only updates
English scaffolds and locale structure.

## Acceptance has to exist in Git

`lexmit review` lists entries that are effectively Review, including those whose `?` the bot has
yet to write. Keep and Edit compare the proposed unmarked value with the committed value.
Either action needs a change that Git can record, such as removing a committed `? ` marker or
changing the translated text.

If the translation text is unchanged, removing an uncommitted marker leaves an empty diff.
To keep that translation, run `lexmit sync`, commit the marker, then review it again. To use new
text, choose Edit and commit the result.

A Review whose placeholders no longer match English can still be reviewed. Only Keep is
unavailable there, because keeping text the runtime already replaces with English would accept a
translation nobody can see.

## Why history replay tolerates stale scaffolds

Between an English commit and the bot's next run, locale files may still contain scaffolds that
quote superseded English. History replay follows first-parent revisions that touch the locale
directory, so it has to tolerate that drift in earlier commits.
`analyzeCommittedHistory` therefore does not check scaffold freshness. Malformed markers,
a `? ` marker without accepted lineage, and a missing or non-ancestor baseline still fail closed.
The baseline is the commit that added `lexmit.config.json`, unless `historyBaseline` names
another.

## Unreadable historical evidence

Intermediate JSON or UTF-8 corruption is recorded as a scoped evidence gap. Readable English
and other locales still replay. A corrupt source affects every dependent target, while a
corrupt target affects only that locale. Baseline, latest and candidate revisions must be
readable within the command's scope.

A gap never creates acceptance or an automatic review-marker request. Acceptance proven
before the gap still stands. A present target with unproven acceptance is Review,
with incomplete evidence reported separately. History-dependent validation and marker planning
fail before writing when a usable target still depends on that evidence. Absence and scaffolds
remain Missing.

Malformed historical files are never repaired in code. Once a fix lands, `historyBaseline` may
name the fixing commit if replay from there yields the same effective state for every entry.
Otherwise the affected targets stay Review until they are accepted again.

An observable Edit against readable English or removal of a committed explicit review marker can
prove fresh acceptance. Identical text on both sides of the gap, or English returning to an
earlier wording, does not close it on its own. Review can offer an Edit, but keeping already
committed plain text records no decision. An explicit review marker must be committed before
Keep can remove it.

`lexmit check <locale>` applies the same semantic rules as the default check to English and
the selected locale. Unrelated corrupt locales do not block it. `lexmit status` counts stored
markers without replaying history. It looks up the baseline separately and still prints coverage
if the lookup fails.

## What the writer checks before it commits

A push made with `GITHUB_TOKEN` does not trigger push workflows. A push made with `push-key` can
trigger workflows whose filters match. The reusable `.github/workflows/translation-status.yml`
runs its own checks before the push. See [GitHub's workflow trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

1. the source commit is valid on its own, before anything is written
2. synchronize markers, regenerate contributors, README and SVGs
3. strict marker and presentation freshness against the regenerated tree
4. rerun marker synchronization and presentation generation, then compare the results
5. `lexmit guard` proves only allowed paths changed and no translated text was
   created, rewritten or deleted
6. stage the owned paths by name, commit, and push without force

After a rejected push, the bot fetches the branch again and regenerates its changes. It makes up
to three attempts and uses normal pushes throughout.

## Runtime is unaffected

`resolveTargetValue`, exported from `@shulha/lexmit/runtime`, is the whole runtime rule:

- absent or `! ` target: render current English
- Accepted or `? ` target whose placeholders match English: render the target, without the marker
- either, with placeholders that do not match: render current English

Review does not mean "display English". An app that bundles its locales at build time has no Git
on the user's machine, so nothing in this document reaches the running app: a build made before
the bot synchronizes renders exactly what a build made after it renders.
