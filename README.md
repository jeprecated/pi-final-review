# pi-final-review

A [Pi](https://pi.dev/) extension that runs configurable read-only final reviews with SDK sub-agents.

It can run Codex and/or GLM reviewers against the current working copy or a specific revision, report live progress in Pi, and optionally send the final report back into the chat as a follow-up.

## Install

From git:

```sh
pi install git:github.com:ohare93/pi-final-review
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
  "skipDuplicateDiff": true
}
```

`/final-review enable` writes project config with `enabled=true` and `autoReview=true`.

## Environment variables

Model and timeout overrides:

```sh
PI_FINAL_REVIEW_CODEX_MODEL="openai-codex/gpt-5.3-codex:high" pi
PI_FINAL_REVIEW_MODEL="zai/glm-5.1:high" pi
PI_FINAL_REVIEW_TIMEOUT_MS=600000 pi
```

Timeouts are capped at 600000 ms.

## Reviewers

Supported reviewers:

- `codex`
- `glm`
- `both`

The extension creates read-only SDK sub-agent sessions for review. Reviewer availability depends on your Pi providers, model configuration, and credentials.

## Auto-review

When `autoReview` is enabled, the extension checks for changes after agent turns and can run a review automatically. Documentation-only changes are controlled by:

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
