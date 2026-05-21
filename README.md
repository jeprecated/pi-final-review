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
  "docsOnlyReview": "ask",
  "defaultMode": "background",
  "reviewers": ["codex", "glm"],
  "codexModel": "openai-codex/gpt-5.3-codex:high",
  "glmModel": "zai/glm-5.1:high",
  "timeoutMs": 600000,
  "sendFollowUp": false,
  "skipDuplicateDiff": true,
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

`finalChecks` runs project commands after agent turns. If a command fails, times out, or is cancelled, the extension sends the command, exit status, and captured output back to the agent as a follow-up and defers automatic review until checks pass. Successful check output is kept in the UI report but is not sent to the agent.

Command entries can be strings or objects with:

- `name` — display name
- `command` — shell command run with `bash -lc` (or `cmd /c` on Windows)
- `cwd` — optional project-relative working directory
- `timeoutMs` — optional per-command timeout, capped at 600000 ms

### Child project checks

Meta workspaces can run checks from nested repos by adding `finalChecks.childProjects`. Each child keeps its own `.pi/final-review.json`; the meta workspace reads the child's `finalChecks.commands`, runs them from that child path, and reports failures in one combined final-check report.

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
- `changed` — run only child projects touched by the current diff.
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

When `autoReview` is enabled, the extension checks for changes after agent turns and can run a review automatically. If `finalChecks.enabled` has commands configured, those checks run first and must pass before automatic review starts. Documentation-only changes are controlled by:

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
