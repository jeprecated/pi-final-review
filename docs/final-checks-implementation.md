# Final checks implementation

## Goal

Final Review now supports a per-project command gate before automatic review. This prevents agents from declaring work complete without running required project checks such as type checks, tests, or mobile builds.

## Configuration

Project configuration remains in `.pi/final-review.json`.

```json
{
  "enabled": true,
  "autoReview": true,
  "finalChecks": {
    "enabled": true,
    "commands": [
      "npm run typecheck",
      { "name": "build", "command": "npm run build", "timeoutMs": 600000 }
    ],
    "timeoutMs": 600000,
    "continueOnFailure": false,
    "sendFollowUp": true
  }
}
```

`finalChecks.commands` accepts strings or objects. Objects support:

- `name`: display name in status and reports
- `command`: shell command to run
- `cwd`: optional project-relative working directory
- `timeoutMs`: optional per-command timeout

`finalChecks.timeoutMs` is the default per-command timeout. Timeouts are capped at `600000` ms and can be overridden with `PI_FINAL_REVIEW_CHECK_TIMEOUT_MS`.

## Runtime behavior

On `agent_end`, the extension now evaluates automatic finalization in this order:

1. Detect working-copy changes, or a very recent completed jj/git commit when the working copy is clean.
2. Build the same target bundle/fingerprint used by review.
3. If `finalChecks.enabled` and commands are configured, run final checks for the target diff unless the same diff already passed checks.
4. If any check fails, times out, or is cancelled, send a follow-up user message to the agent with:
   - target and diff hash
   - every command that ran
   - exit code / outcome
   - captured stdout/stderr for failing commands
   Automatic review is deferred.
5. If checks pass, remember the diff as checked and continue to automatic review if `autoReview` is enabled.

Successful check output is visible in Pi's custom report UI but is not sent to the agent as context. The agent only receives command output when there is a failure or other issue.

## Commands

- `/final-review checks` runs configured checks manually.
- `/final-review checks on` sets `finalChecks.enabled=true` in project config.
- `/final-review checks off` sets `finalChecks.enabled=false` in project config.
- `/final-review status` and `/final-review cancel` now apply to either a running review or running checks.

## Duplicate and loop prevention

The extension tracks checked diff/command-set keys in memory and persists successful keys with the custom entry type `final-review-checked-diff`. The key combines the target diff hash with the configured command list, so changing the checks causes them to run again. A failed automatic check key is also remembered for the current session so a failure follow-up does not cause an unchanged diff to loop forever. Once the agent changes the diff, checks run again.

## Review integration

Automatic review remains controlled by `autoReview`. Final checks are independently controlled by `finalChecks.enabled`. When both are enabled, checks are the gate: review runs only after checks pass for the current diff.
