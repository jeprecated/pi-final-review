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

`finalChecks.childProjects` lets a meta workspace aggregate checks from nested repositories. Each child project keeps its own `.pi/final-review.json`; the meta workspace loads that child's `finalChecks.commands`, prefixes report names with the child path, and runs the commands with `cwd` rooted in the child project. Automatic finalization snapshots include the root plus configured/discovered children, so child-only jj/git changes are visible even if the parent workspace has no VCS diff.

Child project options:

- `enabled`: enables child aggregation.
- `run`: `all`, `changed`, or `manual` for automatic runs. `changed` uses each child repo snapshot, with parent changed paths as a fallback for monorepos.
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

On `agent_start`, the extension snapshots an aggregate finalization fingerprint. On `agent_end`, automatic finalization evaluates in this order:

1. Snapshot the root repo and each configured/discovered child repo. Each repo prefers jj detection and falls back to git.
2. Detect working-copy changes, or a very recent completed jj/git commit when a repo working copy is clean.
3. Build an aggregate target bundle/fingerprint from the root plus child repo fingerprints. Active child repo bundles are included in automatic review input.
4. If `requireTurnChanges=true` and the aggregate fingerprint is unchanged from `agent_start`, follow `unchangedTurnReview`: ask with a yes/no prompt, skip, or run. Manual `/final-review` and `/final-review checks` commands are unaffected.
5. If the unchanged-turn gate allows the run and `finalChecks.enabled` plus root or child commands are configured, resolve the command set for the aggregate target. Child commands are loaded at run time from child project config files.
6. Run final checks for the aggregate target unless the same aggregate diff and command set already passed checks.
7. If any check fails, times out, or is cancelled, send a follow-up user message to the agent with:
   - target and diff hash
   - every command that ran
   - exit code / outcome
   - captured stdout/stderr for failing commands
   Automatic review is deferred.
8. If checks pass, remember the aggregate diff+command-set as checked and continue to automatic review if `autoReview` is enabled.

Successful check output is visible in Pi's custom report UI but is not sent to the agent as context. The agent only receives command output when there is a failure or other issue.

If `commitReminder.enabled=true`, final-review sends a commit reminder only after final checks pass and no automatic review is pending, or after automatic review completes cleanly. A failed check sends the failing command output instead of a commit reminder. Passing checks with no remaining VCS changes send nothing. The reminder is also gated by the aggregate turn-start snapshot, so pre-existing dirty changes do not trigger it unless the current turn changed the target.

Commit reminder VCS detection runs for the root and configured/discovered child repos. Each repo prefers jj (`jj root`, typically `.jj`) and falls back to git (`git rev-parse --show-toplevel`, typically `.git`). If multiple repos remain dirty, final-review sends one combined follow-up listing the repos and the matching status/diff/commit commands for each.

## Commands

- `/final-review checks` runs configured checks manually.
- `/final-review checks on` sets `finalChecks.enabled=true` in project config.
- `/final-review checks off` sets `finalChecks.enabled=false` in project config.
- `/final-review status` and `/final-review cancel` now apply to either a running review or running checks.

## Duplicate and loop prevention

The extension tracks checked diff/command-set keys in memory and persists successful keys with the custom entry type `final-review-checked-diff`. The key combines the aggregate target hash with the resolved command list, including child project wrappers, cwd values, and timeouts, so changing child config or child repo state causes checks to run again. A failed automatic check key is also remembered for the current session so a failure follow-up does not cause an unchanged aggregate diff to loop forever. Once the agent changes the root or a child repo diff, checks run again.

## Review integration

Automatic review remains controlled by `autoReview`. Final checks are independently controlled by `finalChecks.enabled`. When both are enabled, checks are the gate: review runs only after checks pass for the current aggregate diff.
