import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __test__ as finalReview } from "../extensions/final-review.ts";

const config: Parameters<typeof finalReview.parseArgs>[1] = {
	enabled: true,
	autoReview: true,
	requireTurnChanges: true,
	unchangedTurnReview: "ask",
	docsOnlyReview: "ask",
	defaultMode: "background",
	reviewers: ["codex", "glm"],
	codexModel: "openai-codex/gpt-5.3-codex:high",
	glmModel: "zai/glm-5.1:high",
	timeoutMs: 600_000,
	sendFollowUp: false,
	skipDuplicateDiff: true,
	finalChecks: {
		enabled: false,
		commands: [],
		timeoutMs: 600_000,
		continueOnFailure: false,
		sendFollowUp: true,
		childProjects: {
			enabled: false,
			run: "all",
			projects: [],
			defaults: {},
			discover: {
				enabled: false,
				configPath: ".pi/final-review.json",
				maxDepth: 3,
				exclude: [".git", ".jj", ".hg", "node_modules", ".direnv", ".devbox"],
			},
		},
	},
	commitReminder: {
		enabled: true,
	},
};

async function withTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), "final-review-"));
	try {
		return await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function restoreTimeoutEnv(value: string | undefined) {
	if (value === undefined) delete process.env.PI_FINAL_REVIEW_TIMEOUT_MS;
	else process.env.PI_FINAL_REVIEW_TIMEOUT_MS = value;
}

test("final review command parsing supports modes, reviewers, and steering", () => {
	assert.deepEqual(finalReview.parseArgs("blocking codex steer", config), {
		action: "run",
		mode: "blocking",
		reviewers: ["codex"],
		steer: true,
		force: false,
		target: undefined,
		extra: "",
	});

	assert.deepEqual(finalReview.parseArgs("background both force focus security", config), {
		action: "run",
		mode: "background",
		reviewers: ["codex", "glm"],
		steer: false,
		force: true,
		target: undefined,
		extra: "focus security",
	});
});

test("final review command parsing supports control actions", () => {
	assert.equal(finalReview.parseArgs("status", config).action, "status");
	assert.equal(finalReview.parseArgs("cancel", config).action, "cancel");
	assert.equal(finalReview.parseArgs("config", config).action, "config");
	assert.deepEqual(finalReview.parseArgs("send #7", config), {
		action: "send",
		mode: config.defaultMode,
		reviewers: config.reviewers,
		steer: false,
		force: false,
		extra: "#7",
	});
	assert.deepEqual(finalReview.parseArgs("note focus parser edge cases", config), {
		action: "note",
		mode: config.defaultMode,
		reviewers: config.reviewers,
		steer: false,
		force: false,
		extra: "focus parser edge cases",
	});
});

test("final review command parsing supports explicit review targets", () => {
	assert.equal(finalReview.parseArgs("codex rev @-", config).target, "@-");
	assert.equal(finalReview.parseArgs("both --target abc123", config).target, "abc123");
	assert.equal(finalReview.parseArgs("glm target=feature::@", config).target, "feature::@");
	assert.equal(finalReview.parseArgs("blocking glm -r @++ focus security", config).target, "@++");
	assert.equal(finalReview.parseArgs("blocking glm -r @++ focus security", config).extra, "focus security");
	assert.equal(finalReview.parseArgs("@ focus security", config).target, "@");
	assert.equal(finalReview.parseArgs("@++ focus security", config).target, "@++");
	assert.equal(finalReview.parseArgs("@- focus security", config).extra, "focus security");
	assert.equal(finalReview.parseArgs("codex @someone focus security", config).target, undefined);
	assert.equal(finalReview.parseArgs("codex @someone focus security", config).extra, "@someone focus security");
	assert.equal(finalReview.parseArgs("codex rev", config).extra, "rev");
	assert.equal(finalReview.parseArgs("codex --rev", config).extra, "--rev");
	assert.equal(finalReview.parseArgs("codex --target", config).extra, "--target");
});

test("review model parser supports provider prefixes and thinking suffixes", () => {
	assert.deepEqual(finalReview.parseReviewModelSpec("openai-codex", "openai-codex/gpt-5.3-codex:high"), {
		provider: "openai-codex",
		modelId: "gpt-5.3-codex",
		rawModelId: "openai-codex/gpt-5.3-codex",
		thinkingLevel: "high",
	});

	assert.deepEqual(finalReview.parseReviewModelSpec("zai", "glm-5.1:medium"), {
		provider: "zai",
		modelId: "glm-5.1",
		rawModelId: "glm-5.1",
		thinkingLevel: "medium",
	});
});

test("review model parser leaves provider-style model IDs available for fallback", () => {
	assert.deepEqual(finalReview.parseReviewModelSpec("openrouter", "zai/glm-5.1:high"), {
		provider: "zai",
		modelId: "glm-5.1",
		rawModelId: "zai/glm-5.1",
		thinkingLevel: "high",
	});
});

test("duration formatting uses minutes for long reviews", () => {
	assert.equal(finalReview.formatDuration(623_700), "10m 24s");
});

test("timeout defaults do not exceed timeout cap", () => {
	assert.ok(finalReview.DEFAULT_TIMEOUT_MS <= finalReview.MAX_TIMEOUT_MS);
});

test("default config is manual, background, and without automatic follow-up", async () => {
	const originalEnv = process.env.PI_FINAL_REVIEW_TIMEOUT_MS;
	await withTempDir(async (cwd) => {
		try {
			delete process.env.PI_FINAL_REVIEW_TIMEOUT_MS;
			const loaded = await finalReview.loadConfig(cwd);
			assert.equal(loaded.autoReview, false);
			assert.equal(loaded.requireTurnChanges, true);
			assert.equal(loaded.unchangedTurnReview, "ask");
			assert.equal(loaded.commitReminder.enabled, true);
			assert.equal(loaded.defaultMode, "background");
			assert.equal(loaded.sendFollowUp, false);
		} finally {
			restoreTimeoutEnv(originalEnv);
		}
	});
});

test("timeout parsing rejects invalid edge cases and caps configured values", async () => {
	assert.equal(finalReview.parseTimeoutMs(finalReview.MAX_TIMEOUT_MS * 2), finalReview.MAX_TIMEOUT_MS);
	assert.equal(finalReview.parseTimeoutMs("2500"), 2500);
	assert.equal(finalReview.parseTimeoutMs("1234.5"), 1234.5);
	for (const value of ["not-a-number", "", "   ", 0, -1, Number.NaN, Infinity, -Infinity]) {
		assert.equal(finalReview.parseTimeoutMs(value), undefined);
	}

	const originalEnv = process.env.PI_FINAL_REVIEW_TIMEOUT_MS;
	await withTempDir(async (cwd) => {
		try {
			process.env.PI_FINAL_REVIEW_TIMEOUT_MS = String(finalReview.MAX_TIMEOUT_MS * 2);
			assert.equal((await finalReview.loadConfig(cwd)).timeoutMs, finalReview.MAX_TIMEOUT_MS);

			await mkdir(join(cwd, ".pi"), { recursive: true });
			await writeFile(join(cwd, ".pi", "final-review.json"), JSON.stringify({ timeoutMs: finalReview.MAX_TIMEOUT_MS * 2 }), "utf8");
			delete process.env.PI_FINAL_REVIEW_TIMEOUT_MS;
			assert.equal((await finalReview.loadConfig(cwd)).timeoutMs, finalReview.MAX_TIMEOUT_MS);
		} finally {
			restoreTimeoutEnv(originalEnv);
		}
	});
});

test("local timeout config takes precedence over environment timeout", async () => {
	const originalEnv = process.env.PI_FINAL_REVIEW_TIMEOUT_MS;
	await withTempDir(async (cwd) => {
		try {
			process.env.PI_FINAL_REVIEW_TIMEOUT_MS = "1000";
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await writeFile(join(cwd, ".pi", "final-review.json"), JSON.stringify({ timeoutMs: 2500 }), "utf8");
			assert.equal((await finalReview.loadConfig(cwd)).timeoutMs, 2500);
		} finally {
			restoreTimeoutEnv(originalEnv);
		}
	});
});

test("child project final checks resolve with wrappers and child cwd", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(join(cwd, "repo", ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "final-review.json"), JSON.stringify({
			finalChecks: {
				childProjects: {
					projects: ["repo"],
					defaults: { commandWrapper: "devbox run -- bash -lc {command:q}" },
				},
			},
		}), "utf8");
		await writeFile(join(cwd, "repo", ".pi", "final-review.json"), JSON.stringify({
			finalChecks: {
				enabled: true,
				timeoutMs: 1234,
				commands: [{ name: "typecheck", command: "npm run typecheck", cwd: "app" }],
			},
		}), "utf8");

		const loaded = await finalReview.loadConfig(cwd);
		assert.equal(loaded.finalChecks.enabled, true);
		assert.equal(loaded.finalChecks.childProjects.enabled, true);
		const commands = await finalReview.resolveFinalCheckCommands(cwd, loaded.finalChecks, "manual");
		assert.deepEqual(commands, [{
			name: "repo: typecheck",
			command: "devbox run -- bash -lc 'npm run typecheck'",
			cwd: "repo/app",
			timeoutMs: 1234,
		}]);
	});
});

test("child project final checks can filter to changed children", async () => {
	await withTempDir(async (cwd) => {
		for (const repo of ["repo-a", "repo-b"]) {
			await mkdir(join(cwd, repo, ".pi"), { recursive: true });
			await writeFile(join(cwd, repo, ".pi", "final-review.json"), JSON.stringify({ finalChecks: { enabled: true, commands: ["npm run typecheck"] } }), "utf8");
		}
		const checks = finalReview.parseFinalChecksConfig({
			enabled: true,
			childProjects: {
				run: "changed",
				projects: ["repo-a", "repo-b"],
			},
		});
		const commands = await finalReview.resolveFinalCheckCommands(cwd, checks, "auto", ["repo-b/src/index.ts"]);
		assert.deepEqual(commands.map((command) => command.name), ["repo-b: npm run typecheck"]);
	});
});

test("child project final checks can discover nested final-review configs", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(join(cwd, "apps", "mobile", ".pi"), { recursive: true });
		await mkdir(join(cwd, "node_modules", "ignored", ".pi"), { recursive: true });
		await writeFile(join(cwd, "apps", "mobile", ".pi", "final-review.json"), JSON.stringify({ finalChecks: { enabled: true, commands: ["npm run build"] } }), "utf8");
		await writeFile(join(cwd, "node_modules", "ignored", ".pi", "final-review.json"), JSON.stringify({ finalChecks: { enabled: true, commands: ["npm run ignored"] } }), "utf8");
		const checks = finalReview.parseFinalChecksConfig({
			enabled: true,
			childProjects: {
				discover: { maxDepth: 3 },
			},
		});
		const projects = await finalReview.discoverChildProjects(cwd, checks.childProjects.discover);
		assert.deepEqual(projects.map((project) => project.path), ["apps/mobile"]);
		const commands = await finalReview.resolveFinalCheckCommands(cwd, checks, "manual");
		assert.deepEqual(commands.map((command) => command.name), ["apps/mobile: npm run build"]);
	});
});

test("commit reminder prompts support jj and git", () => {
	assert.match(finalReview.commitReminderPrompt("jj"), /jj status --no-pager/);
	assert.match(finalReview.commitReminderPrompt("jj"), /jj commit -m/);
	assert.match(finalReview.commitReminderPrompt("git"), /git status --short/);
	assert.match(finalReview.commitReminderPrompt("git"), /git add -A && git commit -m/);
});

test("commit reminder VCS detection prefers jj and falls back to git", async () => {
	const jjPi = {
		exec: async (command: string, args: string[]) => {
			const key = [command, ...args].join(" ");
			if (key === "jj root") return { code: 0, stdout: "/repo\n", stderr: "" };
			if (key === "jj diff --summary --no-pager") return { code: 0, stdout: "M src/index.ts\n", stderr: "" };
			throw new Error(`unexpected command: ${key}`);
		},
	} as unknown as Parameters<typeof finalReview.commitReminderVcsState>[0];
	assert.deepEqual(await finalReview.commitReminderVcsState(jjPi, "/repo"), { kind: "jj", root: "/repo", hasChanges: true, summary: "M src/index.ts" });

	const gitPi = {
		exec: async (command: string, args: string[]) => {
			const key = [command, ...args].join(" ");
			if (key === "jj root") return { code: 1, stdout: "", stderr: "not jj" };
			if (key === "git rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
			if (key === "git status --short") return { code: 0, stdout: " M src/index.ts\n?? new.ts\n", stderr: "" };
			throw new Error(`unexpected command: ${key}`);
		},
	} as unknown as Parameters<typeof finalReview.commitReminderVcsState>[0];
	assert.deepEqual(await finalReview.commitReminderVcsState(gitPi, "/repo"), { kind: "git", root: "/repo", hasChanges: true, summary: "M src/index.ts\n?? new.ts" });
});

test("auto-review mode auto-steers actionable findings even when manual follow-up is off", () => {
	assert.equal(finalReview.shouldAutoReviewSteer({ autoReview: true }), true);
	assert.equal(finalReview.shouldAutoReviewSteer({ autoReview: false }), false);
});

test("final report message is built for single-reviewer reports", () => {
	const report: Parameters<typeof finalReview.finalReportMessage>[0] = {
		id: 1,
		startedAt: 0,
		finishedAt: 1000,
		mode: "blocking",
		reviewers: ["codex"],
		target: "test target",
		diffHash: "abc123",
		bundleBytes: 42,
		results: [{ reviewer: "codex", outcome: "success", durationMs: 1000, output: "No issues." }],
	};
	const message = finalReview.finalReportMessage(report);
	assert.equal(message.customType, "final-review-report");
	assert.equal(message.display, true);
	assert.equal(message.details, report);
	assert.match(message.content, /Final review #1: ✓ codex clean 1\.0s/);
	assert.equal(finalReview.finalReportSendCommand(report), "/final-review send #1");
	assert.equal(finalReview.finalReportSendHint(report), "Run /final-review send #1 to send these results into the chat.");
	assert.match(finalReview.finalReportMessage(report, { sendHint: true }).content, /Run \/final-review send #1 to send these results into the chat\./);
	assert.match(finalReview.finalReportFollowUpMessage(report), /Final review #1 results are available/);
	assert.match(finalReview.finalReportFollowUpMessage(report), /# Final review #1/);
	assert.equal(finalReview.shouldSendFollowUp(report, true), false);
	assert.equal(finalReview.shouldSendFollowUp(report, false), false);

	const actionable: typeof report = { ...report, results: [{ reviewer: "codex", outcome: "success", durationMs: 1000, output: "Verdict: findings\nFinding: src/foo.ts has a bug." }] };
	assert.equal(finalReview.shouldSendFollowUp(actionable, true), true);
	assert.match(finalReview.finalReportMessage(actionable).content, /Final review #1: ! codex findings 1\.0s/);

	const failed: typeof report = { ...report, results: [{ reviewer: "codex", outcome: "failed", durationMs: 100, output: "model failed" }] };
	assert.equal(finalReview.shouldSendFollowUp(failed, true), true);

	const cancelled: typeof report = { ...report, results: [{ reviewer: "codex", outcome: "cancelled", durationMs: 100, output: "cancelled" }] };
	assert.equal(finalReview.shouldSendFollowUp(cancelled, true), false);
	assert.equal(finalReview.reportNeedsAttention(cancelled), true);
});

test("follow-up detection handles structured verdicts and qualified clean phrases", () => {
	assert.equal(finalReview.parseReviewerVerdict("Verdict: clean\nNo issues."), "clean");
	assert.equal(finalReview.reviewerOutputNeedsFollowUp("Verdict: clean\nNo issues."), false);
	assert.equal(finalReview.reviewerOutputNeedsFollowUp("Verdict: findings\nMedium: src/foo.ts has a bug."), true);
	assert.equal(finalReview.reviewerOutputNeedsFollowUp("No critical issues, but there is a medium bug in src/foo.ts."), true);
	assert.equal(finalReview.reviewerOutputNeedsFollowUp("No issues found. Residual risk: tests not run."), false);
});

test("review bundle hash ignores presentation-only bundle text changes", () => {
	const first = finalReview.reviewBundleHash({ target: "parent", fingerprint: "jj-parent\ndiff --git a/src.ts b/src.ts", text: "Target commit (10 minutes ago)" });
	const second = finalReview.reviewBundleHash({ target: "parent", fingerprint: "jj-parent\ndiff --git a/src.ts b/src.ts", text: "Target commit (11 minutes ago)" });
	const different = finalReview.reviewBundleHash({ target: "parent", fingerprint: "jj-parent\ndiff --git a/other.ts b/other.ts", text: "Target commit (11 minutes ago)" });
	assert.equal(first, second);
	assert.notEqual(first, different);
});

test("reviewed diff hashes restore from persisted session entries", () => {
	assert.deepEqual(finalReview.reviewedDiffHashesFromEntries([
		{ type: "custom", customType: "final-review-reviewed-diff", data: { hash: "abc123" } },
		{ type: "custom", customType: "other", data: { hash: "ignored" } },
		{ type: "message", data: { hash: "ignored" } },
		{ type: "custom", customType: "final-review-reviewed-diff", data: { hash: 42 } },
	]), ["abc123"]);
});

test("completed review reports restore from custom message entries", () => {
	const report: Parameters<typeof finalReview.finalReportMessage>[0] = {
		id: 7,
		startedAt: 0,
		finishedAt: 1000,
		mode: "background",
		reviewers: ["codex"],
		target: "target",
		diffHash: "abc123",
		bundleBytes: 42,
		results: [{ reviewer: "codex", outcome: "success", durationMs: 1000, output: "No issues." }],
	};
	assert.deepEqual(finalReview.reviewReportsFromEntries([
		{ type: "custom_message", customType: "final-review-report", details: report },
		{ type: "message", message: { role: "custom", customType: "final-review-report", details: report } },
		{ type: "custom_message", customType: "final-review-report", details: { kind: "live", jobId: 7 } },
	]), [report, report]);
});

test("completed report lookup supports latest and explicit send references", () => {
	const first: Parameters<typeof finalReview.finalReportMessage>[0] = {
		id: 1,
		startedAt: 0,
		finishedAt: 1000,
		mode: "background",
		reviewers: ["codex"],
		target: "target one",
		diffHash: "abc123",
		bundleBytes: 42,
		results: [{ reviewer: "codex", outcome: "success", durationMs: 1000, output: "No issues." }],
	};
	const second: typeof first = { ...first, id: 2, target: "target two", diffHash: "def456" };
	const reports = new Map([[first.id, first], [second.id, second]]);

	assert.equal(finalReview.parseReportReference(""), "latest");
	assert.equal(finalReview.parseReportReference("latest"), "latest");
	assert.equal(finalReview.parseReportReference("#1"), 1);
	assert.equal(finalReview.parseReportReference("report #2"), 2);
	assert.equal(finalReview.parseReportReference("nope"), undefined);
	assert.equal(finalReview.parseReportReference("0"), undefined);
	assert.equal(finalReview.latestCompletedReport(reports.values()), second);
	assert.equal(finalReview.completedReportForReference(reports, "latest"), second);
	assert.equal(finalReview.completedReportForReference(reports, 1), first);
	assert.equal(finalReview.completedReportForReference(reports, 3), undefined);
});

test("short output truncates large reviewer output", () => {
	const output = finalReview.shortOutput("x".repeat(100), 10);
	assert.match(output, /truncated/);
	assert.ok(output.length < 100);
});

test("short output does not split multibyte characters", () => {
	const output = finalReview.shortOutput("🙂🙂🙂", 5);
	assert.equal(output, "🙂\n\n[final-review output truncated to 5 bytes]");
});

test("rememberDiffHash evicts oldest entries", () => {
	const hashes = new Set<string>();
	finalReview.rememberDiffHash(hashes, "a", 2);
	finalReview.rememberDiffHash(hashes, "b", 2);
	finalReview.rememberDiffHash(hashes, "c", 2);
	assert.deepEqual([...hashes], ["b", "c"]);
});

test("rememberMapEntry evicts oldest entries", () => {
	const reports = new Map<number, string>();
	finalReview.rememberMapEntry(reports, 1, "a", 2);
	finalReview.rememberMapEntry(reports, 2, "b", 2);
	finalReview.rememberMapEntry(reports, 3, "c", 2);
	assert.deepEqual([...reports.entries()], [[2, "b"], [3, "c"]]);
});

test("live review details guard requires live kind and numeric job id", () => {
	assert.equal(finalReview.isLiveReviewDetails({ kind: "live", jobId: 1 }), true);
	assert.equal(finalReview.isLiveReviewDetails({ kind: "live", jobId: "1" }), false);
	assert.equal(finalReview.isLiveReviewDetails({ jobId: 1 }), false);
});

test("changed path detection ignores parent diff when jj working copy is clean", async () => {
	const commands: string[] = [];
	const pi = {
		exec: async (command: string, args: string[]) => {
			const key = [command, ...args].join(" ");
			commands.push(key);
			if (key === "jj root") return { code: 0, stdout: "/repo\n", stderr: "" };
			if (key === "jj diff --name-only --no-pager") return { code: 0, stdout: "", stderr: "" };
			if (key === "jj diff -r @- --name-only --no-pager") return { code: 0, stdout: "src/parent-change.ts\n", stderr: "" };
			return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
		},
	} as unknown as Parameters<typeof finalReview.getChangedPaths>[0];

	assert.deepEqual(await finalReview.getChangedPaths(pi, "/repo"), []);
	assert.deepEqual(commands, ["jj root", "jj diff --name-only --no-pager"]);
});

test("documentation path detection distinguishes docs-only changes", () => {
	assert.equal(finalReview.allDocumentationPaths(["README.md", "docs/guide.md", "assets/logo.svg"]), true);
	assert.equal(finalReview.allDocumentationPaths(["README.md", "src/index.ts"]), false);
	assert.equal(finalReview.allDocumentationPaths([]), false);
});

test("changed path parsers extract jj and git paths", () => {
	assert.deepEqual(finalReview.parseChangedPaths("README.md\nsrc/index.ts\n"), ["README.md", "src/index.ts"]);
	assert.deepEqual(finalReview.parseGitStatusPaths(" M README.md\nR  old.md -> docs/new.md\n?? src/new.ts\n"), ["README.md", "docs/new.md", "src/new.ts"]);
	assert.deepEqual(finalReview.parseGitStatusPaths(' M "docs/user guide.md"\n'), ["docs/user guide.md"]);
});

test("git path unquoting handles c-style quoted paths", () => {
	assert.equal(finalReview.unquoteGitPath('"docs/user guide.md"'), "docs/user guide.md");
	assert.equal(finalReview.unquoteGitPath('"docs/quote\\\"guide.md"'), 'docs/quote"guide.md');
});
