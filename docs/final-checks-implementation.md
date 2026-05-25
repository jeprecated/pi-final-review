# Final checks implementation

## Goal

Final Review now supports a per-project command gate before automatic review. This prevents agents from declaring work complete without running required project checks such as type checks, tests, or mobile builds.

## Configuration

Project configuration remains in `.pi/final-review.json`.

```json
{
  "enabled": true,
  "autoReview": true,
  "requireTurnChanges": true,
  "unchangedTurnReview": "ask",
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
      "enabled": true,
      "run": "all",
      "defaults": {
        "commandWrapper": "devbox run -- bash -lc {command:q}"
      },
      "projects": [
        { "path": "agent-tick" }
      ]
    }
  }
}
```

`finalChecks.commands` accepts strings or objects. Objects support:

- `name`: display name in status and reports
- `command`: shell command to run
- `cwd`: optional project-relative working directory
- `timeoutMs`: optional per-command timeout

`finalChecks.timeoutMs` is the default per-command timeout. Timeouts are capped at `600000` ms and can be overridden with `PI_FINAL_REVIEW_CHECK_TIMEOUT_MS`.

`finalChecks.childProjects` lets a meta workspace aggregate checks from nested repositories. Each child project keeps its own `.pi/final-review.json`; the meta workspace loads that child's `finalChecks.commands`, prefixes report names with the child path, and runs the commands with `cwd` rooted in the child project.

Child project options:

- `enabled`: enables child aggregation.
- `run`: `all`, `changed`, or `manual` for automatic runs.
- `projects`: explicit child paths, either strings or objects with `path`, `name`, `configPath`, `commandWrapper`, `timeoutMs`, and `enabled`.
- `defaults.commandWrapper`: wrapper for child commands. `{command}` substitutes the raw command and `{command:q}` substitutes a shell-quoted command. Without a placeholder, the command is appended.
- `discover`: optional search for nested `.pi/final-review.json` files, with `enabled`, `configPath`, `maxDepth`, and `exclude`.

Example DevBox wrapper:

```json
{
  "commandWrapper": "devbox run -- bash -lc {command:q}"
}
```

A child check `npm run typecheck` then runs from the child repo as:

```sh
devbox run -- bash -lc 'npm run typecheck'
```

## Runtime behavior

On `agent_start`, the extension snapshots the same target fingerprint used for review. On `agent_end`, automatic finalization evaluates in this order:

1. Detect working-copy changes, or a very recent completed jj/git commit when the working copy is clean.
2. Build the same target bundle/fingerprint used by review.
3. If `requireTurnChanges=true` and the target fingerprint is unchanged from `agent_start`, follow `unchangedTurnReview`: ask with a yes/no prompt, skip, or run. Manual `/final-review` and `/final-review checks` commands are unaffected.
4. If the unchanged-turn gate allows the run and `finalChecks.enabled` plus root or child commands are configured, resolve the command set for the target diff. Child commands are loaded at run time from child project config files.
5. Run final checks for the target diff unless the same diff and command set already passed checks.
6. If any check fails, times out, or is cancelled, send a follow-up user message to the agent with:
   - target and diff hash
   - every command that ran
   - exit code / outcome
   - captured stdout/stderr for failing commands
   Automatic review is deferred.
7. If checks pass, remember the diff+command-set as checked and continue to automatic review if `autoReview` is enabled.

Successful check output is visible in Pi's custom report UI but is not sent to the agent as context. The agent only receives command output when there is a failure or other issue.

## Commands

- `/final-review checks` runs configured checks manually.
- `/final-review checks on` sets `finalChecks.enabled=true` in project config.
- `/final-review checks off` sets `finalChecks.enabled=false` in project config.
- `/final-review status` and `/final-review cancel` now apply to either a running review or running checks.

## Duplicate and loop prevention

The extension tracks checked diff/command-set keys in memory and persists successful keys with the custom entry type `final-review-checked-diff`. The key combines the target diff hash with the resolved command list, including child project wrappers, cwd values, and timeouts, so changing child config causes checks to run again. A failed automatic check key is also remembered for the current session so a failure follow-up does not cause an unchanged diff to loop forever. Once the agent changes the diff, checks run again.

## Review integration

Automatic review remains controlled by `autoReview`. Final checks are independently controlled by `finalChecks.enabled`. When both are enabled, checks are the gate: review runs only after checks pass for the current diff.
