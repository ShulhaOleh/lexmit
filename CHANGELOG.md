# Changelog

All notable changes to lexmit are documented in this file. Each version's section becomes its
GitHub Release notes, so entries are written for someone upgrading.

## Unreleased

### Breaking

- The translation status workflow installs the exact `@shulha/lexmit` version pinned in your
  `package.json` and no longer takes a `lexmit-version` input. Remove that input, pin the package
  to an exact version, and pass `package-json` if that file is not at the repository root. From
  here on, the workflow tag only has to change when a release lists a workflow change.

### Security

- The translation status workflow pins the actions it runs to exact commits, so a moved tag in
  one of them cannot change what runs with your push key.

## 0.1.0

- First release, extracted from Modrex.
