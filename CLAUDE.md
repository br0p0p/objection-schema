@AGENTS.md

## Claude Code setup

- `.claude/settings.json` allows the project's test, lint and format commands without prompting
  and runs `.claude/hooks/format-and-lint.js` after every Edit/Write. The hook runs `eslint --fix` on
  the file, which formats it and applies the other fixes (sorted imports, `node:` protocol, …),
  and returns the remaining errors as feedback. Fix them before moving on. It runs eslint in editor mode,
  so an import you haven't used yet is reported, not deleted. Files change under you after an
  edit, so re-read before editing the same region again.
- Mutation runs take minutes: start them with `run_in_background` and keep working.
