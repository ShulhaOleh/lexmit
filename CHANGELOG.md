# Changelog

All notable changes to lexmit are documented in this file. Each version's section becomes its
GitHub Release notes, so entries are written for someone upgrading.

## Unreleased

### Breaking

- The status workflow installs the exact version pinned in package.json instead of taking a lexmit-version input.

### Added

- Added localeNativeName and localeEnglishName to the runtime.
- Added a maintainers setting for a maintainer's other accounts.
- Added the baseline commit to verify and status output.

### Changed

- historyBaseline is now optional and defaults to the commit that added the config.
- Region tags are now named by script, so zh-CN reads Simplified Chinese.
- Translator credits no longer count values copied from English.

### Fixed

- Fixed missing coverage bars when the terminal reports no width.
- Fixed contributors failing on history from before adopting lexmit.

### Security

- The status workflow pins its actions to exact commits.

## 0.1.0

- First release, extracted from Modrex.
