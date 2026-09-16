# AGENTS.md

Project-level instructions for working in this repository.

## Git / GitHub identity

- Repo owner on GitHub: **design-rrr** (`https://github.com/design-rrr/DesBar.git`).
- Commit authorship is pinned to **design-rrr**
  (`299130834+design-rrr@users.noreply.github.com`). Do not change
  `user.name`/`user.email` in `.git/config`.
- Enforce automatically: before every commit, verify
  `git config user.name` = `design-rrr` and
  `git config user.email` = `299130834+design-rrr@users.noreply.github.com`.
  Never commit under any other identity.
- Before any `gh` or `git push` read/write to this repo, confirm the active
  account is `design-rrr` (`gh auth status`); if not, run
  `gh auth switch --user design-rrr && gh auth setup-git`.