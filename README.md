# pi-final-review

A [Pi](https://pi.dev/) extension that runs configurable final checks and read-only final reviews with SDK sub-agents.

It can run project commands (type checks, builds, tests) after agent turns, feed failures back to the agent automatically, then run Codex and/or GLM reviewers against the current working copy or a specific revision.

## Install

From git:

```sh
pi install git:github.com:jeprecated/pi-final-review
```

For local development:

```sh
pi -e /home/jmo/Development/projects/pi-final-review
```

Or add it to Pi settings:

```json
{
  "packages": [
    "/home/jmo/Development/projects/pi-final-review"
  ]
}
```

## Commands

```text
/final-review [background|blocking] [both|codex|glm] [rev <rev>] [steer] [force]
/final-review status
/final-review cancel
/final-review config
/final-review enable
/final-review disable
/final-review auto on
/final-review auto off
/final-review checks
/final-review checks on
/final-review checks off
/final-review send [latest|#id]
/final-review note <message>
```

Alias:

```text
/review
```

Examples:

```text
/final-review both
/final-review blocking both
/final-review codex rev @-
/final-review background glm --target abc123 steer
/final-review force both
/final-review checks
/final-review send #1
```

## Configuration

Project config lives at:

```text
.pi/final-review.json
```

Example:

```json
{
  "enabled": true,
  "autoReview": false,
  "requireTurnChanges": true,
  "unchangedTurnReview": "ask",
  "requireAgentMutation": true,
  "readOnlyTurnFinalization": "skip",
  "docsOnlyReview": "ask",
  "defaultMode": "background",
  "reviewers": ["codex", "glm"],
  "codexModel": "openai-codex/gpt-5.3-codex:high",
  "glmModel": "zai/glm-5.1:high",
  "timeoutMs": 600000,
  "sendFollowUp": false,
  "skipDuplicateDiff": true,
  "commitReminder": {
    "enabled": true
  },
  "finalChecks": {
    "enabled": true,
    "commands": [
      "npm run typecheck",
      { "name": "build", "command": "npm run build", "timeoutMs": 600000 }
    ],
    "timeoutMs": 600000,
    "continueOnFailure": false,
    "sendFollowUp": true,
    "childProjects": {
      "enabled": false,
      "run": "all",
      "defaults": {
        "commandWrapper": "devbox run -- bash -lc {command:q}"
      },
      "projects": [
        { "path": "apps/mobile" },
        { "path": "services/api", "commandWrapper": "devbox run -- bash -lc {command:q}" }
      ]
    }
  }
}
```

`/final-review enable` writes project config with `enabled=true` and `autoReview=true`.

Running final reviews/checks can be cancelled with Escape in interactive mode or `/final-review cancel`.

Commit reminders can be muted or re-enabled for the current Pi session with `Alt+M`. The footer shows the current session state as `commit:on`, `commit:off`, `commit:cfg-off`, or `commit:disabled`.

`finalChecks` runs project commands after agent turns. If a command fails, times out, or is cancelled, the extension sends the command, exit status, and captured output back to the agent as a follow-up and defers automatic review until checks pass. Successful check output is kept in the UI report but is not sent to the agent.

Command entries can be strings or objects with:

- `name` — display name
- `command` — shell command run with `bash -lc` (or `cmd /c` on Windows)
- `cwd` — optional project-relative working directory
- `timeoutMs` — optional per-command timeout, capped at 600000 ms

### Child project checks

Meta workspaces can run checks from nested repos by adding `finalChecks.childProjects`. Each child keeps its own `.pi/final-review.json`; the meta workspace reads the child's `finalChecks.commands`, runs them from that child path, and reports failures in one combined final-check report. Automatic finalization snapshots include the root plus configured/discovered child repos, so child-only jj/git changes can trigger checks even when the parent workspace has no diff.

```json
{
  "finalChecks": {
    "enabled": true,
    "childProjects": {
      "enabled": true,
      "run": "all",
      "defaults": {
        "commandWrapper": "devbox run -- bash -lc {command:q}"
      },
      "projects": [
        { "path": "agent-tick" }
      ],
      "discover": {
        "enabled": false,
        "configPath": ".pi/final-review.json",
        "maxDepth": 3
      }
    }
  }
}
```

`run` controls automatic checks:

- `all` — run every configured/discovered child project.
- `changed` — run only child projects whose own child repo snapshot changed, or that are touched by parent changed paths.
- `manual` — only run child project checks via `/final-review checks`.

`commandWrapper` is applied only to child commands. Use `{command}` for raw substitution or `{command:q}` for shell-quoted substitution. If no placeholder is present, the original command is appended, so `"devbox run --"` becomes `devbox run -- npm run typecheck`.

## Environment variables

Model and timeout overrides:

```sh
PI_FINAL_REVIEW_CODEX_MODEL="openai-codex/gpt-5.3-codex:high" pi
PI_FINAL_REVIEW_MODEL="zai/glm-5.1:high" pi
PI_FINAL_REVIEW_TIMEOUT_MS=600000 pi
PI_FINAL_REVIEW_CHECK_TIMEOUT_MS=600000 pi
```

Timeouts are capped at 600000 ms.

## Reviewers

Supported reviewers:

- `codex`
- `glm`
- `both`

The extension creates read-only SDK sub-agent sessions for review. Reviewer availability depends on your Pi providers, model configuration, and credentials.

## Auto-review

When `autoReview` or `finalChecks` automation is enabled, the extension snapshots an aggregate finalization target at agent turn start. The aggregate includes the root repo and each configured/discovered child repo. Each repo snapshot prefers jj (`jj root`) and falls back to git (`git rev-parse --show-toplevel`).

By default, `requireAgentMutation=true` skips automatic finalization for read-only agent turns. A turn is read-only when it used no tools, or only read-only tools/commands such as `read`, search tools, `rg`, `ls`, `jj status`, `jj diff`, `git status`, and `git diff`. Mutating tools (`edit`, `write`) and non-allowlisted shell commands/scripts (`npm test`, `devbox run`, `jj commit`, unknown custom tools) allow finalization to proceed. `readOnlyTurnFinalization` controls read-only turns:

- `skip` — silently skip automatic checks/review/reminders (default).
- `ask` — offer a yes/no prompt to run checks/review anyway; a yes answer bypasses the unchanged-turn prompt.
- `run` — run anyway, bypassing the unchanged-turn prompt.

If the aggregate target is unchanged at turn end, `unchangedTurnReview` controls what happens:

- `ask` — offer a yes/no prompt to run checks/review anyway (default).
- `skip` — silently skip automatic checks/review.
- `run` — run anyway.

This prevents a fresh session from running checks just because the repo was already dirty, while still letting you opt in from the prompt. Set `requireTurnChanges=false` to restore the old always-run behavior.

`commitReminder.enabled=true` adds a commit reminder step only after configured checks have passed (and after clean automatic review, when review is enabled). If checks fail, the agent gets the failing check output instead. If checks pass and VCS changes remain, the agent gets a commit reminder. If checks pass and there is nothing to commit, nothing is sent. The reminder is gated to turns that changed the aggregate target.

Commit reminders prefer jj when a jj repo is detected (`.jj` / `jj root`), and fall back to git when only git is detected (`.git` / `git rev-parse --show-toplevel`). The follow-up uses the matching commands (`jj status --no-pager` / `jj diff --summary --no-pager` / `jj commit`, or `git status --short` / `git diff --stat` / `git add -A && git commit`).

Automatic finalization flow:

```text
agent_start
  |
  v
snapshot aggregate hash
  (root + configured/discovered children)
  |
  v
agent_end
  |
  v
used mutating tools/scripts this turn?
  |-- no --> readOnlyTurnFinalization
  |            |-- ask --> user chooses yes/no
  |            |-- skip --> stop
  |            '-- run --> continue
  |
  v
same aggregate target as snapshot?
  |-- yes --> unchangedTurnReview
  |             |-- ask --> user chooses yes/no
  |             |-- skip --> stop
  |             '-- run --> continue
  |
  v
resolve finalChecks commands
  (root + child projects; run=changed uses child hashes)
  |
  v
commands configured?
  |-- no --> continue
  |
  v
run checks
  |-- fail/timeout/cancel --> send failing check output to agent; stop
  '-- pass ------------.
                       |
                       v
autoReview enabled?
  |-- yes --> run review
  |           |-- findings/failure --> send review output to agent; stop
  |           '-- clean ------------.
  |                                |
  '-- no --------------------------'
                       |
                       v
commitReminder enabled and this turn changed the aggregate target?
  |-- no --> stop
  |
  v
any root/child repo dirty?
  |-- jj dirty  --> include repo in jj reminder
  |-- git dirty --> include repo in git reminder
  '-- all clean -> stop
  |
  v
send one combined commit reminder
```

When `autoReview` is enabled, the extension checks for aggregate root/child changes after agent turns and can run a review automatically. If child repos are active, their change bundles are included in the review input. If `finalChecks.enabled` has commands configured, those checks run first and must pass before automatic review starts. Documentation-only changes are controlled by:

```json
{
  "docsOnlyReview": "ask"
}
```

Valid values:

- `ask`
- `auto`
- `skip`

## Development

```sh
npm install
npm run typecheck
npm test
pi -e ./
```

## Package manifest

This repository is a Pi package. `package.json` declares:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

## License

MIT
