import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

type ReviewMode = "background" | "blocking";
type ReviewCommandAction = "run" | "status" | "cancel" | "config" | "send" | "note" | "enable" | "disable" | "auto-on" | "auto-off" | "checks" | "checks-on" | "checks-off";
type ReviewerName = "codex" | "glm";
type ReviewOutcome = "success" | "failed" | "timeout" | "skipped" | "cancelled";

type DocsOnlyReviewMode = "ask" | "auto" | "skip";
type UnchangedTurnReviewMode = "ask" | "skip" | "run";

type FinalCheckCommand = {
	name: string;
	command: string;
	cwd?: string;
	timeoutMs?: number;
};

type ChildProjectRunMode = "all" | "changed" | "manual";

type FinalCheckChildProject = {
	path: string;
	name?: string;
	enabled: boolean;
	configPath?: string;
	commandWrapper?: string;
	timeoutMs?: number;
};

type FinalCheckChildProjectDefaults = {
	commandWrapper?: string;
	timeoutMs?: number;
};

type FinalCheckChildProjectDiscover = {
	enabled: boolean;
	configPath: string;
	maxDepth: number;
	exclude: string[];
};

type FinalCheckChildProjectsConfig = {
	enabled: boolean;
	run: ChildProjectRunMode;
	projects: FinalCheckChildProject[];
	defaults: FinalCheckChildProjectDefaults;
	discover: FinalCheckChildProjectDiscover;
};

type CommitReminderConfig = {
	enabled: boolean;
};

type CommitReminderVcsKind = "jj" | "git";

type CommitReminderVcsState = {
	kind: CommitReminderVcsKind;
	root: string;
	hasChanges: boolean;
	summary: string;
};

type FinalChecksConfig = {
	enabled: boolean;
	commands: FinalCheckCommand[];
	timeoutMs: number;
	continueOnFailure: boolean;
	sendFollowUp: boolean;
	childProjects: FinalCheckChildProjectsConfig;
};

type FinalReviewConfig = {
	enabled: boolean;
	autoReview: boolean;
	requireTurnChanges: boolean;
	unchangedTurnReview: UnchangedTurnReviewMode;
	docsOnlyReview: DocsOnlyReviewMode;
	defaultMode: ReviewMode;
	reviewers: ReviewerName[];
	codexModel: string;
	glmModel: string;
	timeoutMs: number;
	sendFollowUp: boolean;
	skipDuplicateDiff: boolean;
	finalChecks: FinalChecksConfig;
	commitReminder: CommitReminderConfig;
};

type ReviewerResult = {
	reviewer: ReviewerName;
	outcome: ReviewOutcome;
	durationMs: number;
	output: string;
	exitCode?: number;
	error?: string;
};

type FinalCheckResult = {
	name: string;
	command: string;
	cwd?: string;
	outcome: ReviewOutcome;
	durationMs: number;
	output: string;
	exitCode?: number;
	error?: string;
};

type ReviewBundle = {
	text: string;
	target: string;
	fingerprint: string;
};

type TurnStartSnapshot = {
	hash: string;
	target: string;
	capturedAt: number;
};

type AutoReviewTarget = {
	reason: "working-copy" | "recent-commit";
	changedPaths: string[];
	targetRev?: string;
	description: string;
};

type ReviewReport = {
	id: number;
	startedAt: number;
	finishedAt: number;
	mode: ReviewMode;
	reviewers: ReviewerName[];
	target: string;
	diffHash: string;
	bundleBytes: number;
	results: ReviewerResult[];
};

type FinalCheckReport = {
	id: number;
	startedAt: number;
	finishedAt: number;
	target: string;
	diffHash: string;
	commands: FinalCheckCommand[];
	results: FinalCheckResult[];
};

type LiveReviewDetails = {
	kind: "live" | "live-review";
	jobId: number;
};

type LiveCheckDetails = {
	kind: "live-checks";
	jobId: number;
};

type ReviewerProgress = {
	reviewer: ReviewerName;
	startedAt?: number;
	finishedAt?: number;
	outcome?: ReviewOutcome;
	lastText?: string;
};

type FinalCheckProgress = {
	name: string;
	command: string;
	startedAt?: number;
	finishedAt?: number;
	outcome?: ReviewOutcome;
	lastText?: string;
};

type RunningJob = {
	id: number;
	startedAt: number;
	controller: AbortController;
	promise: Promise<ReviewReport>;
	reviewers: ReviewerName[];
	mode: ReviewMode;
	target: string;
	diffHash: string;
	progress: Record<ReviewerName, ReviewerProgress>;
	notes: string[];
};

type RunningCheckJob = {
	id: number;
	startedAt: number;
	controller: AbortController;
	promise: Promise<FinalCheckReport>;
	target: string;
	diffHash: string;
	commands: FinalCheckCommand[];
	progress: FinalCheckProgress[];
};

const MESSAGE_TYPE = "final-review-report";
const REVIEWED_DIFF_ENTRY_TYPE = "final-review-reviewed-diff";
const CHECKED_DIFF_ENTRY_TYPE = "final-review-checked-diff";
const STATUS_KEY = "final-review";
const CONFIG_PATH = path.join(".pi", "final-review.json");
const DEFAULT_TIMEOUT_MS = 600_000;
const LIVE_SNIPPET_CHARS = 600;
const WIDGET_SNIPPET_CHARS = 120;
const MAX_TIMEOUT_MS = 600_000;
const RECENT_COMMIT_AUTO_REVIEW_WINDOW_MS = 60_000;
// Completed reports retain reviewer output, so keep fewer than lightweight diff-hash caches.
const MAX_COMPLETED_REPORTS = 32;
if (DEFAULT_TIMEOUT_MS > MAX_TIMEOUT_MS) throw new Error("Final review default timeout exceeds maximum timeout cap");
const DEFAULT_CONFIG: FinalReviewConfig = {
	enabled: true,
	autoReview: false,
	requireTurnChanges: true,
	unchangedTurnReview: "ask",
	docsOnlyReview: "ask",
	defaultMode: "background",
	reviewers: ["codex", "glm"],
	codexModel: "openai-codex/gpt-5.3-codex:high",
	glmModel: "zai/glm-5.1:high",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	sendFollowUp: false,
	skipDuplicateDiff: true,
	finalChecks: {
		enabled: false,
		commands: [],
		timeoutMs: DEFAULT_TIMEOUT_MS,
		continueOnFailure: false,
		sendFollowUp: true,
		childProjects: {
			enabled: false,
			run: "all",
			projects: [],
			defaults: {},
			discover: {
				enabled: false,
				configPath: CONFIG_PATH,
				maxDepth: 3,
				exclude: [".git", ".jj", ".hg", "node_modules", ".direnv", ".devbox"],
			},
		},
	},
	commitReminder: {
		enabled: true,
	},
};

function uniqReviewers(reviewers: ReviewerName[]): ReviewerName[] {
	return Array.from(new Set(reviewers));
}

function isReviewerName(value: string): value is ReviewerName {
	return value === "codex" || value === "glm";
}

function parseReviewerList(value: unknown): ReviewerName[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const reviewers = value.filter((item): item is ReviewerName => typeof item === "string" && isReviewerName(item));
	return reviewers.length > 0 ? uniqReviewers(reviewers) : undefined;
}

function parseTimeoutMs(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
	if (numeric === undefined || !Number.isFinite(numeric) || numeric <= 0) return undefined;
	return Math.min(numeric, MAX_TIMEOUT_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultCheckName(command: string): string {
	const compact = command.replace(/\s+/g, " ").trim();
	return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}

function parseFinalCheckCommand(value: unknown): FinalCheckCommand | undefined {
	if (typeof value === "string") {
		const command = value.trim();
		return command ? { name: defaultCheckName(command), command } : undefined;
	}
	if (!isRecord(value)) return undefined;
	const command = typeof value.command === "string" ? value.command.trim() : "";
	if (!command) return undefined;
	const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : defaultCheckName(command);
	const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined;
	const timeoutMs = parseTimeoutMs(value.timeoutMs);
	return timeoutMs === undefined ? { name, command, cwd } : { name, command, cwd, timeoutMs };
}

function parseFinalCheckCommands(value: unknown): FinalCheckCommand[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const commands = value.flatMap((item) => {
		const command = parseFinalCheckCommand(item);
		return command ? [command] : [];
	});
	return commands.length > 0 ? commands : undefined;
}

function parseChildProjectRunMode(value: unknown): ChildProjectRunMode | undefined {
	return value === "all" || value === "changed" || value === "manual" ? value : undefined;
}

function parseChildProject(value: unknown): FinalCheckChildProject | undefined {
	if (typeof value === "string") {
		const projectPath = value.trim();
		return projectPath ? { path: projectPath, enabled: true } : undefined;
	}
	if (!isRecord(value)) return undefined;
	const projectPath = typeof value.path === "string" ? value.path.trim() : "";
	if (!projectPath) return undefined;
	const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined;
	const configPath = typeof value.configPath === "string" && value.configPath.trim() ? value.configPath.trim() : undefined;
	const commandWrapper = typeof value.commandWrapper === "string" && value.commandWrapper.trim() ? value.commandWrapper.trim() : undefined;
	const timeoutMs = parseTimeoutMs(value.timeoutMs);
	const enabled = typeof value.enabled === "boolean" ? value.enabled : true;
	return { path: projectPath, name, enabled, configPath, commandWrapper, timeoutMs };
}

function parseChildProjects(value: unknown): FinalCheckChildProject[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const projects = value.flatMap((item) => {
		const project = parseChildProject(item);
		return project ? [project] : [];
	});
	return projects.length > 0 ? projects : undefined;
}

function parseChildProjectDefaults(value: unknown): FinalCheckChildProjectDefaults {
	if (!isRecord(value)) return {};
	const commandWrapper = typeof value.commandWrapper === "string" && value.commandWrapper.trim() ? value.commandWrapper.trim() : undefined;
	const timeoutMs = parseTimeoutMs(value.timeoutMs);
	return { commandWrapper, timeoutMs };
}

function parseChildProjectDiscover(value: unknown): FinalCheckChildProjectDiscover {
	const base = DEFAULT_CONFIG.finalChecks.childProjects.discover;
	if (typeof value === "boolean") return { ...base, enabled: value };
	if (!isRecord(value)) return { ...base };
	const enabled = typeof value.enabled === "boolean" ? value.enabled : true;
	const configPath = typeof value.configPath === "string" && value.configPath.trim() ? value.configPath.trim() : base.configPath;
	const maxDepth = typeof value.maxDepth === "number" && Number.isFinite(value.maxDepth) && value.maxDepth > 0 ? Math.min(Math.floor(value.maxDepth), 16) : base.maxDepth;
	const exclude = Array.isArray(value.exclude) ? value.exclude.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : base.exclude;
	return { enabled, configPath, maxDepth, exclude };
}

function parseFinalCheckChildProjectsConfig(value: unknown): FinalCheckChildProjectsConfig {
	const base = DEFAULT_CONFIG.finalChecks.childProjects;
	if (typeof value === "boolean") return { ...base, enabled: value, defaults: { ...base.defaults }, discover: { ...base.discover } };
	if (Array.isArray(value)) {
		const projects = parseChildProjects(value) ?? [];
		return { ...base, enabled: projects.length > 0, projects, defaults: { ...base.defaults }, discover: { ...base.discover } };
	}
	if (!isRecord(value)) return { ...base, defaults: { ...base.defaults }, discover: { ...base.discover } };

	const projects = parseChildProjects(value.projects) ?? base.projects;
	const defaults = parseChildProjectDefaults(value.defaults);
	const discover = parseChildProjectDiscover(value.discover);
	const run = parseChildProjectRunMode(value.run) ?? base.run;
	const hasConfiguredProjects = projects.length > 0 || discover.enabled;
	const enabled = typeof value.enabled === "boolean" ? value.enabled : hasConfiguredProjects;
	return { enabled, run, projects, defaults, discover };
}

function parseCommitReminderConfig(value: unknown): CommitReminderConfig {
	const base = DEFAULT_CONFIG.commitReminder;
	if (typeof value === "boolean") return { enabled: value };
	if (!isRecord(value)) return { ...base };
	const enabled = typeof value.enabled === "boolean" ? value.enabled : base.enabled;
	return { enabled };
}

function parseFinalChecksConfig(value: unknown): FinalChecksConfig {
	const base = DEFAULT_CONFIG.finalChecks;
	const envTimeoutMs = parseTimeoutMs(process.env.PI_FINAL_REVIEW_CHECK_TIMEOUT_MS);
	if (typeof value === "boolean") return { ...base, enabled: value, timeoutMs: envTimeoutMs ?? base.timeoutMs, childProjects: { ...base.childProjects, defaults: { ...base.childProjects.defaults }, discover: { ...base.childProjects.discover } } };
	if (Array.isArray(value)) {
		const commands = parseFinalCheckCommands(value) ?? [];
		return { ...base, enabled: commands.length > 0, commands, timeoutMs: envTimeoutMs ?? base.timeoutMs, childProjects: { ...base.childProjects, defaults: { ...base.childProjects.defaults }, discover: { ...base.childProjects.discover } } };
	}
	if (!isRecord(value)) return { ...base, timeoutMs: envTimeoutMs ?? base.timeoutMs, childProjects: { ...base.childProjects, defaults: { ...base.childProjects.defaults }, discover: { ...base.childProjects.discover } } };

	const commands = parseFinalCheckCommands(value.commands) ?? base.commands;
	const childProjects = parseFinalCheckChildProjectsConfig(value.childProjects);
	const hasCommands = Object.prototype.hasOwnProperty.call(value, "commands");
	const hasChildProjects = Object.prototype.hasOwnProperty.call(value, "childProjects");
	const enabled = typeof value.enabled === "boolean" ? value.enabled : (hasCommands && commands.length > 0) || (hasChildProjects && childProjects.enabled) ? true : base.enabled;
	const timeoutMs = parseTimeoutMs(value.timeoutMs) ?? envTimeoutMs ?? base.timeoutMs;
	const continueOnFailure = typeof value.continueOnFailure === "boolean" ? value.continueOnFailure : base.continueOnFailure;
	const sendFollowUp = typeof value.sendFollowUp === "boolean" ? value.sendFollowUp : base.sendFollowUp;
	return { enabled, commands, timeoutMs, continueOnFailure, sendFollowUp, childProjects };
}

async function loadLocalConfig(cwd: string, configPath = CONFIG_PATH): Promise<Record<string, unknown>> {
	const resolvedConfigPath = path.resolve(cwd, configPath);
	try {
		const raw = await fs.readFile(resolvedConfigPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${configPath} must contain a JSON object`);
		return parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {};
	}
}

async function writeLocalConfigPatch(cwd: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
	const configPath = path.resolve(cwd, CONFIG_PATH);
	const local = await loadLocalConfig(cwd);
	const next = { ...local, ...patch };
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
	return next;
}

async function loadConfig(cwd: string, configPath = CONFIG_PATH): Promise<FinalReviewConfig> {
	const local = await loadLocalConfig(cwd, configPath);

	const enabled = typeof local.enabled === "boolean" ? local.enabled : DEFAULT_CONFIG.enabled;
	const autoReview = typeof local.autoReview === "boolean" ? local.autoReview : DEFAULT_CONFIG.autoReview;
	const requireTurnChanges = typeof local.requireTurnChanges === "boolean" ? local.requireTurnChanges : DEFAULT_CONFIG.requireTurnChanges;
	const unchangedTurnReview = local.unchangedTurnReview === "ask" || local.unchangedTurnReview === "skip" || local.unchangedTurnReview === "run" ? local.unchangedTurnReview : DEFAULT_CONFIG.unchangedTurnReview;
	const docsOnlyReview = local.docsOnlyReview === "ask" || local.docsOnlyReview === "auto" || local.docsOnlyReview === "skip" ? local.docsOnlyReview : DEFAULT_CONFIG.docsOnlyReview;
	const defaultMode = local.defaultMode === "blocking" || local.defaultMode === "background" ? local.defaultMode : DEFAULT_CONFIG.defaultMode;
	const reviewers = parseReviewerList(local.reviewers) ?? DEFAULT_CONFIG.reviewers;
	const codexModel = typeof local.codexModel === "string" && local.codexModel.trim() ? local.codexModel.trim() : (process.env.PI_FINAL_REVIEW_CODEX_MODEL ?? DEFAULT_CONFIG.codexModel);
	const glmModel = typeof local.glmModel === "string" && local.glmModel.trim() ? local.glmModel.trim() : (process.env.PI_FINAL_REVIEW_MODEL ?? DEFAULT_CONFIG.glmModel);
	const timeoutMs = parseTimeoutMs(local.timeoutMs) ?? parseTimeoutMs(process.env.PI_FINAL_REVIEW_TIMEOUT_MS) ?? DEFAULT_CONFIG.timeoutMs;
	const sendFollowUp = typeof local.sendFollowUp === "boolean" ? local.sendFollowUp : DEFAULT_CONFIG.sendFollowUp;
	const skipDuplicateDiff = typeof local.skipDuplicateDiff === "boolean" ? local.skipDuplicateDiff : DEFAULT_CONFIG.skipDuplicateDiff;
	const finalChecks = parseFinalChecksConfig(local.finalChecks);
	const commitReminder = parseCommitReminderConfig(local.commitReminder);

	return { enabled, autoReview, requireTurnChanges, unchangedTurnReview, docsOnlyReview, defaultMode, reviewers, codexModel, glmModel, timeoutMs, sendFollowUp, skipDuplicateDiff, finalChecks, commitReminder };
}

async function execText(pi: ExtensionAPI, command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; text: string }> {
	const result = await pi.exec(command, args, { cwd, signal, timeout: 30_000 });
	return { code: result.code, text: [result.stdout, result.stderr].filter(Boolean).join("") };
}

function commitReminderPrompt(kind: CommitReminderVcsKind): string {
	if (kind === "jj") {
		return `final-review reminder: this agent turn left uncommitted jj working-copy changes.

Before you finish, inspect \`jj status --no-pager\` and \`jj diff --summary --no-pager\`. If the changes are complete and in scope for this task, run relevant validation and commit them with \`jj commit -m "<conventional commit message>"\`. If the changes are unrelated, incomplete, or should not be committed, say so explicitly and ask the user what to do. After committing, verify with \`jj status --no-pager\`.`;
	}

	return `final-review reminder: this agent turn left uncommitted git working-tree changes.

Before you finish, inspect \`git status --short\` and \`git diff --stat\` (and \`git diff\` when needed). If the changes are complete and in scope for this task, run relevant validation and commit them with \`git add -A && git commit -m "<conventional commit message>"\`. If the changes are unrelated, incomplete, or should not be committed, say so explicitly and ask the user what to do. After committing, verify with \`git status --short\`.`;
}

async function commitReminderVcsState(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<CommitReminderVcsState | undefined> {
	const jjRoot = await execText(pi, "jj", ["root"], cwd, signal).catch(() => undefined);
	if (jjRoot && jjRoot.code === 0 && jjRoot.text.trim()) {
		const summary = await execText(pi, "jj", ["diff", "--summary", "--no-pager"], cwd, signal).catch(() => undefined);
		const text = summary && summary.code === 0 ? summary.text.trim() : "";
		return { kind: "jj", root: jjRoot.text.trim(), hasChanges: text.length > 0, summary: text };
	}

	const gitRoot = await execText(pi, "git", ["rev-parse", "--show-toplevel"], cwd, signal).catch(() => undefined);
	if (gitRoot && gitRoot.code === 0 && gitRoot.text.trim()) {
		const status = await execText(pi, "git", ["status", "--short"], cwd, signal).catch(() => undefined);
		const text = status && status.code === 0 ? status.text.trim() : "";
		return { kind: "git", root: gitRoot.text.trim(), hasChanges: text.length > 0, summary: text };
	}

	return undefined;
}

function shellInvocation(command: string): { command: string; args: string[] } {
	return process.platform === "win32" ? { command: "cmd", args: ["/d", "/s", "/c", command] } : { command: "bash", args: ["-lc", command] };
}

function resolveFinalCheckCwd(root: string, check: FinalCheckCommand): { cwd: string; displayCwd?: string } {
	if (!check.cwd) return { cwd: root };
	return { cwd: path.resolve(root, check.cwd), displayCwd: check.cwd };
}

function normalizePathForConfig(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function expandHome(filePath: string): string {
	if (filePath === "~") return process.env.HOME ?? filePath;
	if (filePath.startsWith("~/")) return path.join(process.env.HOME ?? "~", filePath.slice(2));
	return filePath;
}

function resolveProjectPath(root: string, projectPath: string): string {
	const expanded = expandHome(projectPath);
	return path.resolve(root, expanded);
}

function childProjectDisplayPath(root: string, projectPath: string): string {
	const absolute = resolveProjectPath(root, projectPath);
	const relative = path.relative(root, absolute);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return normalizePathForConfig(projectPath);
	return normalizePathForConfig(relative);
}

function joinConfigPaths(...parts: Array<string | undefined>): string | undefined {
	const present = parts.filter((part): part is string => Boolean(part && part.trim()));
	if (present.length === 0) return undefined;
	return normalizePathForConfig(path.join(...present));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function applyCommandWrapper(wrapper: string | undefined, command: string, context: { projectRoot?: string; cwd?: string } = {}): string {
	if (!wrapper?.trim()) return command;
	let wrapped = wrapper.trim();
	const hadCommandPlaceholder = /\{command(?::q)?\}/.test(wrapped);
	const replacements: Record<string, string | undefined> = {
		command,
		project: context.projectRoot,
		cwd: context.cwd,
	};
	for (const [key, value] of Object.entries(replacements)) {
		if (value === undefined) continue;
		wrapped = wrapped.replaceAll(`{${key}:q}`, shellQuote(value));
		wrapped = wrapped.replaceAll(`{${key}}`, value);
	}
	return hadCommandPlaceholder ? wrapped : `${wrapped} ${command}`;
}

function changedPathsAffectProject(root: string, projectPath: string, changedPaths: string[]): boolean {
	if (changedPaths.length === 0) return false;
	const displayPath = childProjectDisplayPath(root, projectPath);
	if (!displayPath || displayPath.startsWith("..")) return false;
	return changedPaths.some((changedPath) => {
		const normalized = normalizePathForConfig(changedPath);
		return normalized === displayPath || normalized.startsWith(`${displayPath}/`);
	});
}

function shouldRunChildProject(source: "auto" | "manual", runMode: ChildProjectRunMode, root: string, projectPath: string, changedPaths: string[]): boolean {
	if (source === "manual") return true;
	if (runMode === "manual") return false;
	if (runMode === "changed") return changedPathsAffectProject(root, projectPath, changedPaths);
	return true;
}

function shouldExcludeDiscoveryPath(relativePath: string, exclude: string[]): boolean {
	const normalized = normalizePathForConfig(relativePath);
	const segments = normalized.split("/").filter(Boolean);
	return exclude.some((entry) => {
		const normalizedEntry = normalizePathForConfig(entry);
		return segments.includes(normalizedEntry) || normalized === normalizedEntry || normalized.startsWith(`${normalizedEntry}/`);
	});
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function discoverChildProjects(root: string, discover: FinalCheckChildProjectDiscover): Promise<FinalCheckChildProject[]> {
	if (!discover.enabled) return [];
	const projects: FinalCheckChildProject[] = [];
	const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let entries: Array<{ isDirectory(): boolean; name: string }>;
		try {
			entries = await fs.readdir(path.resolve(root, current.relativePath), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const childRelative = normalizePathForConfig(path.join(current.relativePath, entry.name));
			const childDepth = current.depth + 1;
			if (childDepth > discover.maxDepth || shouldExcludeDiscoveryPath(childRelative, discover.exclude)) continue;
			const configFile = path.resolve(root, childRelative, discover.configPath);
			if (await pathExists(configFile)) {
				projects.push({ path: childRelative, enabled: true, configPath: discover.configPath });
				continue;
			}
			queue.push({ relativePath: childRelative, depth: childDepth });
		}
	}
	return projects;
}

async function resolveFinalCheckCommands(root: string, checksConfig: FinalChecksConfig, source: "auto" | "manual", changedPaths: string[] = []): Promise<FinalCheckCommand[]> {
	const commands: FinalCheckCommand[] = [...checksConfig.commands];
	const childProjectsConfig = checksConfig.childProjects;
	if (!childProjectsConfig.enabled) return commands;

	const explicitProjects = childProjectsConfig.projects;
	const discoveredProjects = await discoverChildProjects(root, childProjectsConfig.discover);
	const projects = new Map<string, FinalCheckChildProject>();
	for (const project of explicitProjects) projects.set(childProjectDisplayPath(root, project.path), project);
	for (const project of discoveredProjects) {
		const key = childProjectDisplayPath(root, project.path);
		if (!projects.has(key)) projects.set(key, project);
	}

	for (const project of projects.values()) {
		if (!project.enabled) continue;
		if (!shouldRunChildProject(source, childProjectsConfig.run, root, project.path, changedPaths)) continue;
		const childRoot = resolveProjectPath(root, project.path);
		const displayPath = childProjectDisplayPath(root, project.path);
		const childConfig = await loadConfig(childRoot, project.configPath ?? childProjectsConfig.discover.configPath);
		if (!childConfig.enabled || !childConfig.finalChecks.enabled) continue;
		for (const childCommand of childConfig.finalChecks.commands) {
			const commandCwd = path.resolve(childRoot, childCommand.cwd ?? ".");
			const wrapper = project.commandWrapper ?? childProjectsConfig.defaults.commandWrapper;
			const command = applyCommandWrapper(wrapper, childCommand.command, { projectRoot: childRoot, cwd: commandCwd });
			commands.push({
				name: `${project.name ?? displayPath}: ${childCommand.name}`,
				command,
				cwd: joinConfigPaths(displayPath, childCommand.cwd),
				timeoutMs: childCommand.timeoutMs ?? project.timeoutMs ?? childProjectsConfig.defaults.timeoutMs ?? childConfig.finalChecks.timeoutMs,
			});
		}
	}
	return commands;
}

async function runFinalCheckCommand(pi: ExtensionAPI, root: string, check: FinalCheckCommand, defaultTimeoutMs: number, signal?: AbortSignal): Promise<FinalCheckResult> {
	const startedAt = Date.now();
	const timeoutMs = check.timeoutMs ?? defaultTimeoutMs;
	const { cwd, displayCwd } = resolveFinalCheckCwd(root, check);
	const invocation = shellInvocation(check.command);
	const base = { name: check.name, command: check.command, cwd: displayCwd, durationMs: 0, output: "" };
	try {
		const result = await pi.exec(invocation.command, invocation.args, { cwd, signal, timeout: timeoutMs });
		const output = shortOutput([result.stdout, result.stderr].filter(Boolean).join(""));
		const durationMs = Date.now() - startedAt;
		const outcome: ReviewOutcome = result.code === 0 && !result.killed ? "success" : result.killed && signal?.aborted ? "cancelled" : result.killed ? "timeout" : "failed";
		const error = outcome === "success" ? undefined : outcome === "timeout" ? `timed out after ${timeoutMs}ms` : outcome === "cancelled" ? "cancelled" : undefined;
		return { ...base, durationMs, outcome, output, exitCode: result.code, error };
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const message = errorMessage(error);
		const outcome: ReviewOutcome = signal?.aborted ? "cancelled" : /timed?\s*out|timeout/i.test(message) ? "timeout" : "failed";
		return { ...base, durationMs, outcome, output: shortOutput(message), error: message };
	}
}

async function getChangedPaths(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string[]> {
	const jjRoot = await execText(pi, "jj", ["root"], cwd, signal).catch(() => undefined);
	if (jjRoot && jjRoot.code === 0) {
		// Auto-review first reacts to current working-copy changes. If the working
		// copy is clean, maybeAutoReview() separately checks for a very recent
		// completed commit and reviews that commit instead.
		const result = await execText(pi, "jj", ["diff", "--name-only", "--no-pager"], cwd, signal);
		return parseChangedPaths(result.text);
	}

	const gitRoot = await execText(pi, "git", ["rev-parse", "--show-toplevel"], cwd, signal).catch(() => undefined);
	if (gitRoot && gitRoot.code === 0) {
		const result = await execText(pi, "git", ["status", "--short"], cwd, signal);
		return parseGitStatusPaths(result.text);
	}

	return [];
}

function parseTimestampMs(value: string): number | undefined {
	const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
	if (!firstLine) return undefined;
	const timestampMs = Date.parse(firstLine);
	return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

async function getRecentCommitAutoReviewTarget(pi: ExtensionAPI, cwd: string, signal?: AbortSignal, now = Date.now()): Promise<AutoReviewTarget | undefined> {
	const cutoff = now - RECENT_COMMIT_AUTO_REVIEW_WINDOW_MS;
	const jjRoot = await execText(pi, "jj", ["root"], cwd, signal).catch(() => undefined);
	if (jjRoot && jjRoot.code === 0) {
		const timestamp = await execText(pi, "jj", ["log", "-r", "@-", "--no-graph", "--no-pager", "--template", "committer.timestamp().utc().format(\"%+\") ++ \"\\n\""], cwd, signal).catch(() => undefined);
		const timestampMs = timestamp && timestamp.code === 0 ? parseTimestampMs(timestamp.text) : undefined;
		if (timestampMs === undefined || timestampMs < cutoff) return undefined;
		const paths = await execText(pi, "jj", ["diff", "-r", "@-", "--name-only", "--no-pager"], cwd, signal).catch(() => undefined);
		const changedPaths = paths && paths.code === 0 ? parseChangedPaths(paths.text) : [];
		if (changedPaths.length === 0) return undefined;
		return {
			reason: "recent-commit",
			changedPaths,
			targetRev: "@-",
			description: `recent jj parent commit @- (${formatDuration(Math.max(0, now - timestampMs))} ago)`,
		};
	}

	const gitRoot = await execText(pi, "git", ["rev-parse", "--show-toplevel"], cwd, signal).catch(() => undefined);
	if (gitRoot && gitRoot.code === 0) {
		const timestamp = await execText(pi, "git", ["log", "-1", "--format=%cI"], cwd, signal).catch(() => undefined);
		const timestampMs = timestamp && timestamp.code === 0 ? parseTimestampMs(timestamp.text) : undefined;
		if (timestampMs === undefined || timestampMs < cutoff) return undefined;
		const paths = await execText(pi, "git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"], cwd, signal).catch(() => undefined);
		const changedPaths = paths && paths.code === 0 ? parseChangedPaths(paths.text) : [];
		if (changedPaths.length === 0) return undefined;
		return {
			reason: "recent-commit",
			changedPaths,
			targetRev: "HEAD",
			description: `recent git HEAD commit (${formatDuration(Math.max(0, now - timestampMs))} ago)`,
		};
	}

	return undefined;
}

function parseChangedPaths(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function unquoteGitPath(filePath: string): string {
	if (!filePath.startsWith('"') || !filePath.endsWith('"')) return filePath;
	try {
		return JSON.parse(filePath) as string;
	} catch {
		return filePath.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
}

function parseGitStatusPaths(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const pathPart = line.slice(2).trim();
			const renameParts = pathPart.split(/\s+->\s+/);
			const parsedPath = unquoteGitPath(renameParts[renameParts.length - 1] ?? "");
			return parsedPath ? [parsedPath] : [];
		});
}

function isDocumentationPath(filePath: string): boolean {
	const normalized = filePath.toLowerCase();
	const basename = path.basename(normalized);
	if (["readme", "readme.md", "changelog", "changelog.md", "license", "license.md", "copying", "notice"].includes(basename)) return true;
	if (normalized.startsWith("docs/") || normalized.startsWith("doc/") || normalized.startsWith("documentation/")) return true;
	return /\.(?:md|mdx|txt|rst|adoc|org|html|css|svg|png|jpe?g|gif|webp)$/.test(normalized);
}

function allDocumentationPaths(paths: string[]): boolean {
	return paths.length > 0 && paths.every(isDocumentationPath);
}

function requireSuccessfulCommand(result: { code: number; text: string }, label: string): string {
	if (result.code !== 0) throw new Error(`${label} failed:\n${result.text.trimEnd()}`);
	return result.text;
}

async function buildReviewBundle(pi: ExtensionAPI, cwd: string, signal?: AbortSignal, targetRev?: string): Promise<ReviewBundle> {
	const sections: string[] = [`Repository: ${cwd}`];
	const jjRoot = await execText(pi, "jj", ["root"], cwd, signal).catch(() => undefined);
	if (jjRoot && jjRoot.code === 0) {
		const status = await execText(pi, "jj", ["status", "--no-pager"], cwd, signal);
		if (targetRev) {
			const target = `explicit jj revision ${targetRev}`;
			const show = requireSuccessfulCommand(await execText(pi, "jj", ["show", targetRev, "--stat", "--no-pager"], cwd, signal), `jj show ${targetRev}`);
			const stat = requireSuccessfulCommand(await execText(pi, "jj", ["diff", "-r", targetRev, "--stat", "--no-pager"], cwd, signal), `jj diff -r ${targetRev} --stat`);
			const diff = requireSuccessfulCommand(await execText(pi, "jj", ["diff", "-r", targetRev, "--no-pager"], cwd, signal), `jj diff -r ${targetRev}`);
			sections.push("Review target: " + target);
			sections.push("Status (jj status --no-pager):\n" + status.text.trimEnd());
			sections.push(`Target commit (jj show ${targetRev} --stat --no-pager):\n` + show.trimEnd());
			sections.push(`Diff stat (jj diff -r ${targetRev} --stat --no-pager):\n` + stat.trimEnd());
			sections.push(`Diff (jj diff -r ${targetRev} --no-pager):\n` + diff.trimEnd());
			return { target, fingerprint: `jj-rev\n${targetRev}\n${diff.trimEnd()}`, text: sections.join("\n\n") + "\n" };
		}

		const stat = await execText(pi, "jj", ["diff", "--stat", "--no-pager"], cwd, signal);
		const diff = await execText(pi, "jj", ["diff", "--no-pager"], cwd, signal);
		if (diff.text.trim()) {
			const target = "working copy changes (@ vs @-)";
			sections.push("Review target: " + target);
			sections.push("Status (jj status --no-pager):\n" + status.text.trimEnd());
			sections.push("Diff stat (jj diff --stat --no-pager):\n" + stat.text.trimEnd());
			sections.push("Diff (jj diff --no-pager):\n" + diff.text.trimEnd());
			return { target, fingerprint: `jj-working\n${diff.text.trimEnd()}`, text: sections.join("\n\n") + "\n" };
		}

		const parentSummary = await execText(pi, "jj", ["diff", "-r", "@-", "--summary", "--no-pager"], cwd, signal).catch(() => undefined);
		if (parentSummary && parentSummary.code === 0 && parentSummary.text.trim()) {
			const target = "parent commit (@-) because the working copy is empty";
			const parentStat = await execText(pi, "jj", ["diff", "-r", "@-", "--stat", "--no-pager"], cwd, signal);
			const parentDiff = await execText(pi, "jj", ["diff", "-r", "@-", "--no-pager"], cwd, signal);
			const parentShow = await execText(pi, "jj", ["show", "@-", "--stat", "--no-pager"], cwd, signal).catch(() => undefined);
			sections.push("Review target: " + target);
			sections.push("Current working copy status, not the review target (jj status --no-pager):\n" + status.text.trimEnd());
			if (parentShow && parentShow.code === 0) sections.push("Target commit (jj show @- --stat --no-pager):\n" + parentShow.text.trimEnd());
			sections.push("Diff stat (jj diff -r @- --stat --no-pager):\n" + parentStat.text.trimEnd());
			sections.push("Diff (jj diff -r @- --no-pager):\n" + parentDiff.text.trimEnd());
			return { target, fingerprint: `jj-parent\n${parentDiff.text.trimEnd()}`, text: sections.join("\n\n") + "\n" };
		}

		const target = "working copy changes (@ vs @-)";
		sections.push("Review target: " + target);
		sections.push("Status (jj status --no-pager):\n" + status.text.trimEnd());
		sections.push("Diff stat (jj diff --stat --no-pager):\n" + stat.text.trimEnd());
		sections.push("Diff (jj diff --no-pager):\n" + diff.text.trimEnd());
		return { target, fingerprint: `jj-working\n${diff.text.trimEnd()}`, text: sections.join("\n\n") + "\n" };
	}

	const gitRoot = await execText(pi, "git", ["rev-parse", "--show-toplevel"], cwd, signal).catch(() => undefined);
	if (gitRoot && gitRoot.code === 0) {
		const status = await execText(pi, "git", ["status", "--short"], cwd, signal);
		if (targetRev) {
			const target = `explicit git revision ${targetRev}`;
			const show = requireSuccessfulCommand(await execText(pi, "git", ["show", "--stat", "--no-ext-diff", "--format=fuller", targetRev], cwd, signal), `git show ${targetRev} --stat`);
			const diff = requireSuccessfulCommand(await execText(pi, "git", ["show", "--no-ext-diff", "--format=fuller", targetRev], cwd, signal), `git show ${targetRev}`);
			sections.push("Review target: " + target);
			sections.push("Current working tree status, not necessarily the review target (git status --short):\n" + status.text.trimEnd());
			sections.push(`Target commit (git show --stat --no-ext-diff --format=fuller ${targetRev}):\n` + show.trimEnd());
			sections.push(`Diff (git show --no-ext-diff --format=fuller ${targetRev}):\n` + diff.trimEnd());
			return { target, fingerprint: `git-rev\n${targetRev}\n${diff.trimEnd()}`, text: sections.join("\n\n") + "\n" };
		}

		const target = "git working tree and index changes";
		const diffStat = await execText(pi, "git", ["diff", "--stat"], cwd, signal);
		const diff = await execText(pi, "git", ["diff", "--no-ext-diff"], cwd, signal);
		const stagedStat = await execText(pi, "git", ["diff", "--cached", "--stat"], cwd, signal);
		const stagedDiff = await execText(pi, "git", ["diff", "--cached", "--no-ext-diff"], cwd, signal);
		sections.push("Review target: " + target);
		sections.push("Status (git status --short):\n" + status.text.trimEnd());
		sections.push("Unstaged diff stat (git diff --stat):\n" + diffStat.text.trimEnd());
		sections.push("Unstaged diff (git diff --no-ext-diff):\n" + diff.text.trimEnd());
		sections.push("Staged diff stat (git diff --cached --stat):\n" + stagedStat.text.trimEnd());
		sections.push("Staged diff (git diff --cached --no-ext-diff):\n" + stagedDiff.text.trimEnd());
		return { target, fingerprint: `git\n${status.text.trimEnd()}\n--unstaged--\n${diff.text.trimEnd()}\n--staged--\n${stagedDiff.text.trimEnd()}`, text: sections.join("\n\n") + "\n" };
	}

	const target = "workspace files (no jj or git repository detected)";
	sections.push("Review target: " + target);
	sections.push("No jj or git repository detected. Reviewers may need to inspect files directly.");
	return { target, fingerprint: "no-vcs", text: sections.join("\n\n") + "\n" };
}

function reviewBundleHash(bundle: ReviewBundle): string {
	return hashText(bundle.fingerprint);
}

function finalChecksCommandsHash(commands: FinalCheckCommand[], defaultTimeoutMs = DEFAULT_TIMEOUT_MS): string {
	return hashText(JSON.stringify(commands.map((command) => ({ name: command.name, command: command.command, cwd: command.cwd, timeoutMs: command.timeoutMs ?? defaultTimeoutMs }))));
}

function finalCheckRunKey(diffHash: string, commands: FinalCheckCommand[], defaultTimeoutMs = DEFAULT_TIMEOUT_MS): string {
	return `${diffHash}:${finalChecksCommandsHash(commands, defaultTimeoutMs)}`;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function rememberDiffHash(set: Set<string>, hash: string, maxEntries = 128) {
	set.add(hash);
	while (set.size > maxEntries) {
		const oldest = set.values().next().value as string | undefined;
		if (!oldest) break;
		set.delete(oldest);
	}
}

function rememberMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries = 128) {
	map.set(key, value);
	while (map.size > maxEntries) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}

function baseReviewPrompt(extra = ""): string {
	const text = `Review the provided change set adversarially.

Focus on:
- bugs and behavioral regressions
- security issues
- missing or weak tests
- incorrect assumptions
- unnecessary complexity

Use the repository status and diff provided as the primary change set. Read relevant files for context when needed, but do not make edits.

Start your response with exactly one of these verdict lines:
- Verdict: findings — when there are actionable findings or required fixes
- Verdict: clean — when you found no actionable issues
- Verdict: inconclusive — when the change cannot be reviewed confidently

Then report findings first, ordered by severity, with file and line references when possible. If you find no issues, keep the clean response brief and mention residual risks or validation gaps.`;
	return extra.trim() ? `${text}\n\nAdditional instructions:\n${extra.trim()}` : text;
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		bytes += charBytes;
		result += char;
	}
	return result;
}

function shortOutput(output: string, maxBytes = 24_000): string {
	if (Buffer.byteLength(output, "utf8") <= maxBytes) return output.trimEnd();
	return truncateUtf8ByBytes(output, maxBytes).trimEnd() + `\n\n[final-review output truncated to ${maxBytes} bytes]`;
}

type ReviewThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];
type ReviewModelRegistry = ExtensionContext["modelRegistry"];
type ReviewModel = NonNullable<ReturnType<ReviewModelRegistry["find"]>>;

type ParsedReviewModelSpec = {
	provider: string;
	modelId: string;
	rawModelId: string;
	thinkingLevel?: ReviewThinkingLevel;
};

const THINKING_LEVELS = new Set<ReviewThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isThinkingLevel(value: string): value is ReviewThinkingLevel {
	return THINKING_LEVELS.has(value as ReviewThinkingLevel);
}

function parseReviewModelSpec(defaultProvider: string, spec: string): ParsedReviewModelSpec {
	const trimmed = spec.trim();
	let modelPart = trimmed;
	let thinkingLevel: ReviewThinkingLevel | undefined;
	const colon = modelPart.lastIndexOf(":");
	if (colon > 0) {
		const suffix = modelPart.slice(colon + 1);
		if (isThinkingLevel(suffix)) {
			thinkingLevel = suffix;
			modelPart = modelPart.slice(0, colon);
		}
	}

	const slash = modelPart.indexOf("/");
	if (slash > 0) {
		return {
			provider: modelPart.slice(0, slash),
			modelId: modelPart.slice(slash + 1),
			rawModelId: modelPart,
			thinkingLevel,
		};
	}

	return { provider: defaultProvider, modelId: modelPart, rawModelId: modelPart, thinkingLevel };
}

function resolveReviewModel(modelRegistry: ReviewModelRegistry, defaultProvider: string, spec: string): { model: ReviewModel; thinkingLevel?: ReviewThinkingLevel } {
	const parsed = parseReviewModelSpec(defaultProvider, spec);
	const model = modelRegistry.find(parsed.provider, parsed.modelId) ?? (parsed.provider === defaultProvider ? undefined : modelRegistry.find(defaultProvider, parsed.rawModelId));
	if (!model) {
		const fallback = parsed.provider === defaultProvider ? "" : ` or ${defaultProvider}/${parsed.rawModelId}`;
		throw new Error(`Review model not found: ${parsed.provider}/${parsed.modelId}${fallback}`);
	}
	return { model, thinkingLevel: parsed.thinkingLevel };
}

type ReviewAssistantMessage = {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
};

function textFromMessageContent(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type?: string; text: string } => {
			if (!part || typeof part !== "object") return false;
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.filter((part) => part.trim())
		.join("\n");
	return text || undefined;
}

function latestAssistantMessage(session: AgentSession): ReviewAssistantMessage | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i] as ReviewAssistantMessage;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function reviewerOutputFromSession(session: AgentSession): string {
	const text = session.getLastAssistantText() ?? textFromMessageContent(latestAssistantMessage(session)?.content);
	return text?.trim() || "(no assistant output)";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function friendlyErrorMessage(error: unknown, maxBytes = 1_200): string {
	const message = errorMessage(error).trim() || "unknown error";
	return shortOutput(message, maxBytes);
}

async function promptWithTimeout(session: AgentSession, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<{ outcome: ReviewOutcome; error?: string }> {
	if (signal?.aborted) {
		await session.abort().catch(() => undefined);
		return { outcome: "cancelled", error: "cancelled" };
	}

	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	const abortSession = async () => {
		await session.abort().catch(() => undefined);
	};

	const promptPromise = session
		.prompt(prompt)
		.then((): { outcome: ReviewOutcome; error?: string } => ({ outcome: "success" }))
		.catch((error): { outcome: ReviewOutcome; error?: string } => ({ outcome: "failed", error: errorMessage(error) }));

	const timeoutPromise = new Promise<{ outcome: ReviewOutcome; error?: string }>((resolve) => {
		timeout = setTimeout(() => {
			void abortSession();
			resolve({ outcome: "timeout", error: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		timeout.unref();
	});

	const abortPromise = signal
		? new Promise<{ outcome: ReviewOutcome; error?: string }>((resolve) => {
			abortHandler = () => {
				void abortSession();
				resolve({ outcome: "cancelled", error: "cancelled" });
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		})
		: new Promise<{ outcome: ReviewOutcome; error?: string }>(() => undefined);

	try {
		return await Promise.race([promptPromise, timeoutPromise, abortPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}

async function runSdkReview(
	reviewer: ReviewerName,
	cwd: string,
	bundle: string,
	prompt: string,
	defaultProvider: string,
	modelSpec: string,
	modelRegistry: ReviewModelRegistry,
	timeoutMs: number,
	signal?: AbortSignal,
	onText?: (text: string) => void,
): Promise<ReviewerResult> {
	const startedAt = Date.now();
	let session: AgentSession | undefined;
	try {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();

		const resolved = resolveReviewModel(modelRegistry, defaultProvider, modelSpec);
		const created = await createAgentSession({
			cwd,
			agentDir,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			modelRegistry,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			tools: ["read", "grep", "find", "ls"],
		});
		session = created.session;
		let streamedText = "";
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				streamedText += event.assistantMessageEvent.delta;
				onText?.(streamedText);
			}
		});

		const result = await promptWithTimeout(session, `${prompt}\n\nReview bundle:\n${bundle}`, timeoutMs, signal);
		unsubscribe();
		const lastAssistant = latestAssistantMessage(session);
		const sessionOutput = reviewerOutputFromSession(session);
		const output = shortOutput(result.error && sessionOutput === "(no assistant output)" ? result.error : sessionOutput);
		if (result.outcome !== "success") {
			return { reviewer, outcome: result.outcome, durationMs: Date.now() - startedAt, output, error: result.error };
		}
		if (lastAssistant?.stopReason === "error") {
			const error = lastAssistant.errorMessage || output || "reviewer returned an error";
			return { reviewer, outcome: "failed", durationMs: Date.now() - startedAt, output: output || error, error };
		}
		return { reviewer, outcome: "success", durationMs: Date.now() - startedAt, output };
	} catch (error) {
		const message = errorMessage(error);
		return { reviewer, outcome: "failed", durationMs: Date.now() - startedAt, output: message, error: message };
	} finally {
		session?.dispose();
	}
}

async function runCodexReview(cwd: string, bundle: string, prompt: string, model: string, modelRegistry: ReviewModelRegistry, timeoutMs: number, signal?: AbortSignal, onText?: (text: string) => void): Promise<ReviewerResult> {
	return runSdkReview("codex", cwd, bundle, prompt, "openai-codex", model, modelRegistry, timeoutMs, signal, onText);
}

async function runGlmReview(cwd: string, bundle: string, prompt: string, model: string, modelRegistry: ReviewModelRegistry, timeoutMs: number, signal?: AbortSignal, onText?: (text: string) => void): Promise<ReviewerResult> {
	return runSdkReview("glm", cwd, bundle, prompt, "zai", model, modelRegistry, timeoutMs, signal, onText);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function reviewerIcon(outcome: ReviewOutcome): string {
	switch (outcome) {
		case "success":
			return "✓";
		case "skipped":
			return "-";
		case "timeout":
			return "⏱";
		case "cancelled":
			return "·";
		case "failed":
			return "✗";
	}
}

function formatReport(report: ReviewReport): string {
	const lines: string[] = [];
	lines.push(`# Final review #${report.id}`);
	lines.push(`Mode: ${report.mode}`);
	lines.push(`Target: ${report.target}`);
	lines.push(`Diff hash: ${report.diffHash}`);
	lines.push(`Duration: ${formatDuration(report.finishedAt - report.startedAt)}`);
	lines.push(`Reviewers: ${report.reviewers.join(", ")}`);
	lines.push("");
	for (const result of report.results) {
		lines.push(`## ${resultDisplayIcon(result)} ${result.reviewer} — ${resultDisplayLabel(result)} (${formatDuration(result.durationMs)})`);
		if (result.outcome === "success") lines.push(`Run status: completed`);
		if (result.exitCode !== undefined) lines.push(`Exit code: ${result.exitCode}`);
		if (result.error) lines.push(`Error: ${result.error}`);
		lines.push("");
		lines.push(result.output || "(no output)");
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function finalCheckResultNeedsAttention(result: FinalCheckResult): boolean {
	return result.outcome !== "success" && result.outcome !== "skipped";
}

function finalCheckReportPassed(report: FinalCheckReport): boolean {
	return report.results.length === report.commands.length && report.results.length > 0 && report.results.every((result) => result.outcome === "success");
}

function finalCheckReportNeedsAttention(report: FinalCheckReport): boolean {
	return !finalCheckReportPassed(report) || report.results.some(finalCheckResultNeedsAttention);
}

function finalCheckDisplayIcon(result: FinalCheckResult): string {
	return reviewerIcon(result.outcome);
}

function finalCheckDisplayLabel(result: FinalCheckResult): string {
	return result.outcome === "success" ? "passed" : result.outcome;
}

function formatFinalCheckReport(report: FinalCheckReport, options: { includePassingOutput?: boolean } = {}): string {
	const lines: string[] = [];
	lines.push(`# Final checks #${report.id}`);
	lines.push(`Target: ${report.target}`);
	lines.push(`Diff hash: ${report.diffHash}`);
	lines.push(`Duration: ${formatDuration(report.finishedAt - report.startedAt)}`);
	lines.push(`Commands: ${report.commands.length}`);
	lines.push("");
	for (const result of report.results) {
		lines.push(`## ${finalCheckDisplayIcon(result)} ${result.name} — ${finalCheckDisplayLabel(result)} (${formatDuration(result.durationMs)})`);
		lines.push(`Command: ${result.command}`);
		lines.push(`Working directory: ${result.cwd ?? "."}`);
		if (result.exitCode !== undefined) lines.push(`Exit code: ${result.exitCode}`);
		if (result.error) lines.push(`Error: ${result.error}`);
		if (result.outcome !== "success" || options.includePassingOutput) {
			lines.push("");
			lines.push(result.output || "(no output)");
		}
		lines.push("");
	}
	for (const command of report.commands.slice(report.results.length)) {
		lines.push(`## - ${command.name} — not run (0ms)`);
		lines.push(`Command: ${command.command}`);
		lines.push(`Working directory: ${command.cwd ?? "."}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function summarizeFinalCheckReport(report: FinalCheckReport): string {
	const failed = report.results.filter(finalCheckResultNeedsAttention).length;
	const skipped = report.results.filter((result) => result.outcome === "skipped").length;
	const notRun = Math.max(0, report.commands.length - report.results.length);
	if (finalCheckReportPassed(report)) return `Final checks #${report.id}: ✓ ${report.results.length}/${report.commands.length} passed`;
	const bits = report.results.map((result) => `${finalCheckDisplayIcon(result)} ${result.name} ${finalCheckDisplayLabel(result)} ${formatDuration(result.durationMs)}`);
	return `Final checks #${report.id}: ${failed} failed${skipped ? `, ${skipped} skipped` : ""}${notRun ? `, ${notRun} not run` : ""}; ${bits.join("; ")}`;
}

function finalChecksFollowUpMessage(report: FinalCheckReport): string {
	return `Final checks #${report.id} did not pass. The final-review extension ran the configured project commands after your turn. Continue fixing the project until these checks pass; do not claim the work is done yet. If automatic review is enabled, it is deferred until the checks pass.\n\n${formatFinalCheckReport(report)}`;
}

function summarizeReport(report: ReviewReport): string {
	const bits = report.results.map((result) => `${resultDisplayIcon(result)} ${result.reviewer} ${resultDisplayLabel(result)} ${formatDuration(result.durationMs)}`);
	return `Final review #${report.id}: ${bits.join("; ")}`;
}

function finalReportSendCommand(report: ReviewReport): string {
	return `/final-review send #${report.id}`;
}

function finalReportSendHint(report: ReviewReport): string {
	return `Run ${finalReportSendCommand(report)} to send these results into the chat.`;
}

function finalReportMessage(report: ReviewReport, options: { sendHint?: boolean } = {}) {
	return {
		customType: MESSAGE_TYPE,
		content: options.sendHint ? `${summarizeReport(report)} · ${finalReportSendHint(report)}` : summarizeReport(report),
		display: true,
		details: report,
	};
}

function finalReportFollowUpMessage(report: ReviewReport): string {
	return `Final review #${report.id} results are available. Reconcile them before continuing.\n\n${formatReport(report)}`;
}

function parseReviewerVerdict(output: string): "clean" | "findings" | "inconclusive" | undefined {
	const match = output.match(/^\s*(?:\*\*)?\s*['"]?Verdict\s*:\s*(clean|no findings|none|findings?|issues?|issues-found|inconclusive)\b/im);
	if (!match) return undefined;
	const value = match[1]!.toLowerCase();
	if (value === "clean" || value === "no findings" || value === "none") return "clean";
	if (value === "inconclusive") return "inconclusive";
	return "findings";
}

function reviewerOutputNeedsFollowUp(output: string): boolean {
	const normalized = output.toLowerCase();
	if (!normalized.trim()) return true;

	const verdict = parseReviewerVerdict(output);
	if (verdict === "clean") return false;
	if (verdict === "findings" || verdict === "inconclusive") return true;

	const contrastFindingPatterns = [
		/\b(?:but|however|except|although|though)\b[\s\S]{0,240}\b(?:issue|finding|bug|problem|regression|risk|fix|incorrect|missing|fails?|broken|security)\b/,
		/\bno critical issues\b[\s\S]{0,240}\b(?:medium|low|minor|but|however|finding|bug|issue)\b/,
	];
	if (contrastFindingPatterns.some((pattern) => pattern.test(normalized))) return true;

	const explicitFindingPatterns = [
		/^\s*(?:#{1,6}\s*)?(?:findings?|issues?)\s*:\s*(?!none\b|no findings\b|no actionable\b|n\/a\b|-?\s*$)/im,
		/^\s*(?:[-*]|\d+[.)])\s*(?:\[[^\]]+\]\s*)?(?:critical|high|medium|low)\b/im,
		/\b(?:severity|impact)\s*:\s*(?:critical|high|medium|low)\b/i,
		/\b(?:critical|high|medium|low)\s+severity\b/i,
		/^\s*(?:[-*]|\d+[.)])\s+.*\b(?:bug|regression|vulnerab|crash|data loss|incorrect|broken|failing|missing test|security)\b/im,
	];
	if (explicitFindingPatterns.some((pattern) => pattern.test(output))) return true;

	const noActionPatterns = [
		/\bno (?:critical |actionable |material |required )?(?:issues|findings|bugs|problems|regressions)(?: found| detected)?\b/,
		/\bno (?:required|actionable) changes\b/,
		/\bnothing (?:to fix|actionable)\b/,
		/\bfindings?:\s*(?:none|no findings|no actionable findings)\b/,
		/\bclean[, .]/,
	];
	if (noActionPatterns.some((pattern) => pattern.test(normalized))) return false;
	return true;
}

function resultNeedsFollowUp(result: ReviewerResult): boolean {
	if (result.outcome === "cancelled" || result.outcome === "skipped") return false;
	if (result.outcome !== "success") return true;
	return reviewerOutputNeedsFollowUp(result.output);
}

function resultDisplayIcon(result: ReviewerResult): string {
	if (result.outcome === "success") return reviewerOutputNeedsFollowUp(result.output) ? "!" : "✓";
	return reviewerIcon(result.outcome);
}

function resultDisplayLabel(result: ReviewerResult): string {
	if (result.outcome === "success") return reviewerOutputNeedsFollowUp(result.output) ? "findings" : "clean";
	return result.outcome;
}

function reportNeedsFollowUp(report: ReviewReport): boolean {
	return report.results.some(resultNeedsFollowUp);
}

function resultNeedsAttention(result: ReviewerResult): boolean {
	if (result.outcome === "skipped") return false;
	if (result.outcome !== "success") return true;
	return reviewerOutputNeedsFollowUp(result.output);
}

function reportNeedsAttention(report: ReviewReport): boolean {
	return report.results.some(resultNeedsAttention);
}

function shouldSendFollowUp(report: ReviewReport, steer: boolean): boolean {
	return steer && reportNeedsFollowUp(report);
}

function shouldAutoReviewSteer(config: Pick<FinalReviewConfig, "autoReview">): boolean {
	return config.autoReview;
}

function reviewedDiffHashesFromEntries(entries: unknown[]): string[] {
	return entries
		.filter((entry): entry is { type: string; customType?: string; data?: { hash?: unknown } } => Boolean(entry) && typeof entry === "object" && (entry as { type?: unknown }).type === "custom" && (entry as { customType?: unknown }).customType === REVIEWED_DIFF_ENTRY_TYPE)
		.map((entry) => entry.data?.hash)
		.filter((hash): hash is string => typeof hash === "string" && hash.length > 0);
}

function isReviewerResult(value: unknown): value is ReviewerResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<ReviewerResult>;
	return isReviewerName(String(result.reviewer)) && typeof result.outcome === "string" && ["success", "failed", "timeout", "skipped", "cancelled"].includes(result.outcome) && typeof result.durationMs === "number" && typeof result.output === "string";
}

function isReviewReport(value: unknown): value is ReviewReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Partial<ReviewReport>;
	return typeof report.id === "number" && typeof report.startedAt === "number" && typeof report.finishedAt === "number" && (report.mode === "background" || report.mode === "blocking") && Array.isArray(report.reviewers) && report.reviewers.every((reviewer) => typeof reviewer === "string" && isReviewerName(reviewer)) && typeof report.target === "string" && typeof report.diffHash === "string" && typeof report.bundleBytes === "number" && Array.isArray(report.results) && report.results.every(isReviewerResult);
}

function isFinalCheckCommand(value: unknown): value is FinalCheckCommand {
	if (!value || typeof value !== "object") return false;
	const command = value as Partial<FinalCheckCommand>;
	return typeof command.name === "string" && typeof command.command === "string" && (command.cwd === undefined || typeof command.cwd === "string") && (command.timeoutMs === undefined || typeof command.timeoutMs === "number");
}

function isFinalCheckResult(value: unknown): value is FinalCheckResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<FinalCheckResult>;
	return typeof result.name === "string" && typeof result.command === "string" && typeof result.outcome === "string" && ["success", "failed", "timeout", "skipped", "cancelled"].includes(result.outcome) && typeof result.durationMs === "number" && typeof result.output === "string" && (result.cwd === undefined || typeof result.cwd === "string");
}

function isFinalCheckReport(value: unknown): value is FinalCheckReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Partial<FinalCheckReport>;
	return typeof report.id === "number" && typeof report.startedAt === "number" && typeof report.finishedAt === "number" && typeof report.target === "string" && typeof report.diffHash === "string" && Array.isArray(report.commands) && report.commands.every(isFinalCheckCommand) && Array.isArray(report.results) && report.results.every(isFinalCheckResult);
}

function reviewReportsFromEntries(entries: unknown[]): ReviewReport[] {
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const topLevel = entry as { customType?: unknown; details?: unknown; message?: unknown };
		if (topLevel.customType === MESSAGE_TYPE && isReviewReport(topLevel.details)) return [topLevel.details];
		const message = topLevel.message;
		if (message && typeof message === "object") {
			const customMessage = message as { customType?: unknown; details?: unknown };
			if (customMessage.customType === MESSAGE_TYPE && isReviewReport(customMessage.details)) return [customMessage.details];
		}
		return [];
	});
}

function checkedDiffHashesFromEntries(entries: unknown[]): string[] {
	return entries
		.filter((entry): entry is { type: string; customType?: string; data?: { hash?: unknown } } => Boolean(entry) && typeof entry === "object" && (entry as { type?: unknown }).type === "custom" && (entry as { customType?: unknown }).customType === CHECKED_DIFF_ENTRY_TYPE)
		.map((entry) => entry.data?.hash)
		.filter((hash): hash is string => typeof hash === "string" && hash.length > 0);
}

function finalCheckReportsFromEntries(entries: unknown[]): FinalCheckReport[] {
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const topLevel = entry as { customType?: unknown; details?: unknown; message?: unknown };
		if (topLevel.customType === MESSAGE_TYPE && isFinalCheckReport(topLevel.details)) return [topLevel.details];
		const message = topLevel.message;
		if (message && typeof message === "object") {
			const customMessage = message as { customType?: unknown; details?: unknown };
			if (customMessage.customType === MESSAGE_TYPE && isFinalCheckReport(customMessage.details)) return [customMessage.details];
		}
		return [];
	});
}

type ReportReference = "latest" | number;

function parseReportReference(args: string): ReportReference | undefined {
	const trimmed = args.trim();
	if (!trimmed || /^(?:latest|last)$/i.test(trimmed)) return "latest";
	const match = trimmed.match(/^(?:(?:review|report)\s*)?#?(\d+)$/i);
	if (!match) return undefined;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function latestCompletedReport(reports: Iterable<ReviewReport>): ReviewReport | undefined {
	let latest: ReviewReport | undefined;
	for (const report of reports) {
		if (!latest || report.id > latest.id) latest = report;
	}
	return latest;
}

function completedReportForReference(reports: Map<number, ReviewReport>, reference: ReportReference): ReviewReport | undefined {
	return reference === "latest" ? latestCompletedReport(reports.values()) : reports.get(reference);
}

function formatAvailableReportIds(reports: Map<number, ReviewReport>): string {
	const ids = [...reports.keys()].sort((a, b) => a - b).map((id) => `#${id}`);
	return ids.length > 0 ? ` Completed reports: ${ids.join(", ")}.` : "";
}

function truncateChars(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`;
}

function compactLiveSnippet(text: string, maxChars = LIVE_SNIPPET_CHARS): string {
	const trimmed = text.trim().replace(/\r/g, "");
	return trimmed ? truncateChars(trimmed, maxChars) : "";
}

function compactLiveOneLine(text: string, maxChars = WIDGET_SNIPPET_CHARS): string {
	const snippet = compactLiveSnippet(text, maxChars);
	const line = snippet.split(/\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
	return truncateChars(line, maxChars);
}

function indentLines(text: string, prefix = "  "): string {
	return text.split(/\n/).map((line) => `${prefix}${line}`).join("\n");
}

function progressDuration(progress: ReviewerProgress): string {
	if (progress.finishedAt && progress.startedAt) return formatDuration(progress.finishedAt - progress.startedAt);
	if (progress.startedAt) return formatDuration(Date.now() - progress.startedAt);
	return "pending";
}

function progressLabel(progress: ReviewerProgress): string {
	return progress.outcome ?? (progress.startedAt ? "running" : "pending");
}

function progressLine(reviewer: ReviewerName, progress: ReviewerProgress): string {
	const icon = progress.outcome ? reviewerIcon(progress.outcome) : "◐";
	return `${icon} ${reviewer}: ${progressLabel(progress)} (${progressDuration(progress)})`;
}

function finalCheckProgressDuration(progress: FinalCheckProgress): string {
	if (progress.finishedAt && progress.startedAt) return formatDuration(progress.finishedAt - progress.startedAt);
	if (progress.startedAt) return formatDuration(Date.now() - progress.startedAt);
	return "pending";
}

function finalCheckProgressLabel(progress: FinalCheckProgress): string {
	return progress.outcome === "success" ? "passed" : progress.outcome ?? (progress.startedAt ? "running" : "pending");
}

function finalCheckProgressLine(progress: FinalCheckProgress): string {
	const icon = progress.outcome ? reviewerIcon(progress.outcome) : "◐";
	return `${icon} ${progress.name}: ${finalCheckProgressLabel(progress)} (${finalCheckProgressDuration(progress)})`;
}

function formatLiveJobDetails(job: RunningJob): string {
	const lines = [`Target: ${job.target}`, `Diff hash: ${job.diffHash}`, `Mode: ${job.mode}`, "", "Reviewers:"];
	for (const reviewer of job.reviewers) {
		const progress = job.progress[reviewer];
		lines.push(progressLine(reviewer, progress));
		const snippet = compactLiveSnippet(progress.lastText ?? "");
		if (snippet) lines.push(indentLines(snippet));
	}
	if (job.notes.length > 0) {
		lines.push("", "Notes:");
		for (const note of job.notes.slice(-5)) lines.push(`- ${note}`);
	}
	return lines.join("\n");
}

function liveJobWidgetLines(job: RunningJob): string[] {
	const lines = [`Final review #${job.id} (${job.mode}) · ${truncateChars(job.target, 100)}`];
	for (const reviewer of job.reviewers) {
		const progress = job.progress[reviewer];
		const snippet = compactLiveOneLine(progress.lastText ?? "");
		lines.push(`${progressLine(reviewer, progress)}${snippet ? ` — ${snippet}` : ""}`);
	}
	const lastNote = job.notes.at(-1);
	if (lastNote) lines.push(`Note: ${truncateChars(lastNote, 140)}`);
	return lines;
}

function formatLiveCheckJobDetails(job: RunningCheckJob): string {
	const lines = [`Target: ${job.target}`, `Diff hash: ${job.diffHash}`, "", "Commands:"];
	for (const progress of job.progress) {
		lines.push(finalCheckProgressLine(progress));
		lines.push(`  ${progress.command}`);
		const snippet = compactLiveSnippet(progress.lastText ?? "");
		if (snippet) lines.push(indentLines(snippet));
	}
	return lines.join("\n");
}

function liveCheckJobWidgetLines(job: RunningCheckJob): string[] {
	const lines = [`Final checks #${job.id} · ${truncateChars(job.target, 100)}`];
	for (const progress of job.progress) {
		const snippet = compactLiveOneLine(progress.lastText ?? "");
		lines.push(`${finalCheckProgressLine(progress)}${snippet ? ` — ${snippet}` : ""}`);
	}
	return lines;
}

function summarizeCheckJob(job: RunningCheckJob): string {
	const bits = job.progress.map((progress) => `${progress.outcome ? reviewerIcon(progress.outcome) : "◐"} ${progress.name} ${finalCheckProgressLabel(progress)} ${finalCheckProgressDuration(progress)}`);
	return `Final checks #${job.id}: ${bits.join("; ")}`;
}

function summarizeJob(job: RunningJob): string {
	const bits = job.reviewers.map((reviewer) => {
		const progress = job.progress[reviewer];
		const icon = progress.outcome ? reviewerIcon(progress.outcome) : "◐";
		const label = progress.outcome ?? "running";
		const duration = progress.finishedAt && progress.startedAt ? progress.finishedAt - progress.startedAt : progress.startedAt ? Date.now() - progress.startedAt : 0;
		return `${icon} ${reviewer} ${label} ${duration > 0 ? formatDuration(duration) : "pending"}`;
	});
	return `Final review #${job.id}: ${bits.join("; ")}`;
}

function isLiveReviewDetails(details: unknown): details is LiveReviewDetails {
	return Boolean(details) && typeof details === "object" && ((details as { kind?: unknown }).kind === "live" || (details as { kind?: unknown }).kind === "live-review") && typeof (details as { jobId?: unknown }).jobId === "number";
}

function isLiveCheckDetails(details: unknown): details is LiveCheckDetails {
	return Boolean(details) && typeof details === "object" && (details as { kind?: unknown }).kind === "live-checks" && typeof (details as { jobId?: unknown }).jobId === "number";
}

type ParsedFinalReviewArgs = {
	action: ReviewCommandAction;
	mode: ReviewMode;
	reviewers: ReviewerName[];
	steer: boolean;
	force: boolean;
	target?: string;
	extra: string;
};

function parseTargetAssignment(token: string): string | undefined {
	for (const prefix of ["--rev=", "rev=", "--target=", "target="]) {
		if (token.startsWith(prefix)) return token.slice(prefix.length);
	}
	return undefined;
}

function looksLikeImplicitTarget(token: string): boolean {
	return token === "@" || /^@[+-]+$/.test(token) || token.includes("::");
}

function parseArgs(args: string, config: FinalReviewConfig): ParsedFinalReviewArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	if (tokens[0] === "status") return { action: "status", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "cancel") return { action: "cancel", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "config") return { action: "config", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "enable" || tokens[0] === "on") return { action: "enable", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "disable" || tokens[0] === "off") return { action: "disable", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "enable-auto" || (tokens[0] === "auto" && ["on", "enable", "enabled", "true"].includes(tokens[1] ?? ""))) return { action: "auto-on", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "disable-auto" || (tokens[0] === "auto" && ["off", "disable", "disabled", "false"].includes(tokens[1] ?? ""))) return { action: "auto-off", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: "" };
	if (tokens[0] === "send" || tokens[0] === "follow-up") return { action: "send", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: tokens.slice(1).join(" ") };
	if (tokens[0] === "note") return { action: "note", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: tokens.slice(1).join(" ") };
	if (tokens[0] === "checks" || tokens[0] === "check") {
		const rest = tokens.slice(1);
		if (["on", "enable", "enabled", "true"].includes(rest[0] ?? "")) return { action: "checks-on", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: rest.slice(1).join(" ") };
		if (["off", "disable", "disabled", "false"].includes(rest[0] ?? "")) return { action: "checks-off", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force: false, extra: rest.slice(1).join(" ") };
		const force = rest.includes("force") || rest.includes("again") || rest.includes("--force");
		return { action: "checks", mode: config.defaultMode, reviewers: config.reviewers, steer: false, force, extra: rest.filter((token) => !["run", "force", "again", "--force"].includes(token)).join(" ") };
	}

	let mode = config.defaultMode;
	let reviewers = config.reviewers;
	let steer = config.sendFollowUp;
	let force = false;
	let target: string | undefined;
	const extraTokens: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const assignedTarget = parseTargetAssignment(token);
		if (assignedTarget !== undefined) target = assignedTarget;
		else if (token === "rev" || token === "target" || token === "--rev" || token === "--target" || token === "-r") {
			const next = tokens[i + 1];
			if (next) {
				target = next;
				i++;
			} else {
				extraTokens.push(token);
			}
		} else if (!target && looksLikeImplicitTarget(token)) target = token;
		else if (token === "background" || token === "bg") mode = "background";
		else if (token === "blocking" || token === "block") mode = "blocking";
		else if (token === "both") reviewers = ["codex", "glm"];
		else if (isReviewerName(token)) reviewers = [token];
		else if (token === "steer" || token === "follow-up") steer = true;
		else if (token === "force" || token === "again" || token === "--force") force = true;
		else extraTokens.push(token);
	}
	return { action: "run", mode, reviewers: uniqReviewers(reviewers), steer, force, target, extra: extraTokens.join(" ") };
}

export default function finalReviewExtension(pi: ExtensionAPI) {
	let currentJob: RunningJob | undefined;
	let currentCheckJob: RunningCheckJob | undefined;
	let nextJobId = 1;
	let nextCheckJobId = 1;
	const liveJobs = new Map<number, RunningJob>();
	const liveCheckJobs = new Map<number, RunningCheckJob>();
	const completedReports = new Map<number, ReviewReport>();
	const completedCheckReports = new Map<number, FinalCheckReport>();
	const reviewedDiffs = new Set<string>();
	const checkedDiffs = new Set<string>();
	const autoAttemptedDiffs = new Set<string>();
	const autoCheckAttemptedDiffs = new Set<string>();
	const commitReminderDiffs = new Set<string>();
	let turnStartSnapshot: TurnStartSnapshot | undefined;

	function setStatus(ctx: ExtensionContext) {
		if (currentJob) {
			const summary = currentJob.reviewers
				.map((reviewer) => {
					const progress = currentJob!.progress[reviewer];
					const icon = progress.outcome ? reviewerIcon(progress.outcome) : "◐";
					return `${icon}${reviewer}:${progressDuration(progress)}`;
				})
				.join(" ");
			ctx.ui.setStatus(STATUS_KEY, `review #${currentJob.id} ${summary}`);
			ctx.ui.setWidget(STATUS_KEY, liveJobWidgetLines(currentJob));
		} else if (currentCheckJob) {
			const summary = currentCheckJob.progress.map((progress) => `${progress.outcome ? reviewerIcon(progress.outcome) : "◐"}${progress.name}:${finalCheckProgressDuration(progress)}`).join(" ");
			ctx.ui.setStatus(STATUS_KEY, `checks #${currentCheckJob.id} ${summary}`);
			ctx.ui.setWidget(STATUS_KEY, liveCheckJobWidgetLines(currentCheckJob));
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
		}
	}

	function sendReport(report: ReviewReport, steer: boolean): boolean {
		const sendFollowUp = shouldSendFollowUp(report, steer);
		pi.sendMessage(finalReportMessage(report, { sendHint: !sendFollowUp }), { triggerTurn: false });
		if (sendFollowUp) {
			pi.sendUserMessage(finalReportFollowUpMessage(report), { deliverAs: "followUp" });
		}
		return sendFollowUp;
	}

	function sendFinalCheckReport(report: FinalCheckReport, checksConfig: FinalChecksConfig): boolean {
		const needsAttention = finalCheckReportNeedsAttention(report);
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: summarizeFinalCheckReport(report),
				display: true,
				details: report,
			},
			{ triggerTurn: false },
		);
		if (needsAttention && checksConfig.sendFollowUp) {
			pi.sendUserMessage(finalChecksFollowUpMessage(report), { deliverAs: "followUp" });
			return true;
		}
		return false;
	}

	function finalChecksConfigured(config: FinalChecksConfig): boolean {
		return config.enabled && (config.commands.length > 0 || config.childProjects.enabled);
	}

	function autoFinalizationConfigured(config: FinalReviewConfig): boolean {
		return config.enabled && (config.autoReview || finalChecksConfigured(config.finalChecks));
	}

	async function captureTurnStartSnapshot(ctx: ExtensionContext): Promise<TurnStartSnapshot | undefined> {
		const bundle = await buildReviewBundle(pi, ctx.cwd, ctx.signal);
		return { hash: reviewBundleHash(bundle), target: bundle.target, capturedAt: Date.now() };
	}

	function unchangedSinceTurnStart(currentHash: string): boolean {
		return Boolean(turnStartSnapshot && turnStartSnapshot.hash === currentHash);
	}

	async function shouldProceedForUnchangedTurn(ctx: ExtensionContext, config: FinalReviewConfig, bundle: ReviewBundle, diffHash: string): Promise<boolean> {
		if (!config.requireTurnChanges || !unchangedSinceTurnStart(diffHash)) return true;
		if (config.unchangedTurnReview === "run") return true;
		if (config.unchangedTurnReview === "skip" || !ctx.hasUI) return false;
		return ctx.ui.confirm(
			"Run final checks/review for unchanged repo?",
			`This agent turn did not change the review target. Existing changes are still present.\n\nTarget: ${bundle.target}\nDiff hash: ${diffHash}\n\nRun configured final checks/review anyway?`,
		);
	}

	function hasPendingMessages(ctx: ExtensionContext): boolean {
		try {
			return ctx.hasPendingMessages();
		} catch {
			return false;
		}
	}

	async function maybeSendCommitReminder(ctx: ExtensionContext, config: FinalReviewConfig, autoTarget: AutoReviewTarget, bundle: ReviewBundle, diffHash: string, options: { checksPassed: boolean }): Promise<boolean> {
		if (!config.commitReminder.enabled) return false;
		if (finalChecksConfigured(config.finalChecks) && !options.checksPassed) return false;
		if (autoTarget.reason !== "working-copy") return false;
		if (!turnStartSnapshot || unchangedSinceTurnStart(diffHash)) return false;
		if (hasPendingMessages(ctx)) return false;

		const vcsState = await commitReminderVcsState(pi, ctx.cwd, ctx.signal).catch(() => undefined);
		if (!vcsState) return false;
		if (!vcsState.hasChanges) {
			commitReminderDiffs.clear();
			return false;
		}

		const reminderKey = `${vcsState.kind}\0${vcsState.root}\0${diffHash}`;
		if (commitReminderDiffs.has(reminderKey)) return false;
		rememberDiffHash(commitReminderDiffs, reminderKey);
		ctx.ui.notify(`${vcsState.kind} changes remain; reminding agent to commit.`, "info");
		pi.sendUserMessage(commitReminderPrompt(vcsState.kind), { deliverAs: "followUp" });
		return true;
	}

	async function runReview(ctx: ExtensionContext, mode: ReviewMode, reviewers: ReviewerName[], extra: string, steer: boolean, targetRev?: string, force = false, afterCleanReview?: (report: ReviewReport) => Promise<void>): Promise<ReviewReport | undefined> {
		if (currentJob) {
			ctx.ui.notify(`Final review #${currentJob.id} is already running. Use /final-review status or /final-review cancel.`, "warning");
			return undefined;
		}
		if (currentCheckJob) {
			ctx.ui.notify(`Final checks #${currentCheckJob.id} are already running. Use /final-review status or /final-review cancel.`, "warning");
			return undefined;
		}

		let config: FinalReviewConfig;
		try {
			config = await loadConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`Final review config error in ${CONFIG_PATH}: ${friendlyErrorMessage(error)}`, "error");
			return undefined;
		}
		if (!config.enabled) {
			ctx.ui.notify(`Final review is disabled by ${CONFIG_PATH}.`, "info");
			return undefined;
		}
		let bundle: ReviewBundle;
		try {
			bundle = await buildReviewBundle(pi, ctx.cwd, ctx.signal, targetRev);
		} catch (error) {
			const target = targetRev ? ` for ${targetRev}` : "";
			ctx.ui.notify(`Final review could not build review target${target}: ${friendlyErrorMessage(error)}`, "error");
			return undefined;
		}
		const diffHash = reviewBundleHash(bundle);
		if (!force && config.skipDuplicateDiff && reviewedDiffs.has(diffHash)) {
			ctx.ui.notify(`Final review skipped: diff ${diffHash} was already reviewed in this session. Use /final-review force to run it again.`, "info");
			return undefined;
		}

		const id = nextJobId++;
		const controller = new AbortController();
		const contextSignal = ctx.signal;
		const abortFromContext = () => controller.abort();
		if (contextSignal?.aborted) abortFromContext();
		else contextSignal?.addEventListener("abort", abortFromContext, { once: true });
		const prompt = baseReviewPrompt(extra);
		const startedAt = Date.now();
		const progress = Object.fromEntries(reviewers.map((reviewer) => [reviewer, { reviewer }])) as Record<ReviewerName, ReviewerProgress>;
		let promise!: Promise<ReviewReport>;
		currentJob = { id, startedAt, controller, promise: undefined as unknown as Promise<ReviewReport>, reviewers, mode, target: bundle.target, diffHash, progress, notes: [] };
		liveJobs.set(id, currentJob);
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: summarizeJob(currentJob),
				display: true,
				details: { kind: "live", jobId: id } satisfies LiveReviewDetails,
			},
			{ triggerTurn: false },
		);

		const runOne = async (reviewer: ReviewerName): Promise<ReviewerResult> => {
			progress[reviewer].startedAt = Date.now();
			setStatus(ctx);
			let lastProgressUpdate = 0;
			const onText = (text: string) => {
				const now = Date.now();
				if (now - lastProgressUpdate < 750) return;
				lastProgressUpdate = now;
				progress[reviewer].lastText = text;
				setStatus(ctx);
			};
			const result = reviewer === "codex"
				? await runCodexReview(ctx.cwd, bundle.text, prompt, config.codexModel, ctx.modelRegistry, config.timeoutMs, controller.signal, onText)
				: await runGlmReview(ctx.cwd, bundle.text, prompt, config.glmModel, ctx.modelRegistry, config.timeoutMs, controller.signal, onText);
			progress[reviewer].finishedAt = Date.now();
			progress[reviewer].outcome = result.outcome;
			progress[reviewer].lastText = result.output;
			setStatus(ctx);
			return result;
		};

		promise = Promise.all(reviewers.map(runOne)).then((results): ReviewReport => ({
			id,
			startedAt,
			finishedAt: Date.now(),
			mode,
			reviewers,
			target: bundle.target,
			diffHash,
			bundleBytes: Buffer.byteLength(bundle.text, "utf8"),
			results,
		}));
		currentJob.promise = promise;
		const ticker = setInterval(() => setStatus(ctx), 1000);
		ticker.unref();
		setStatus(ctx);
		if (mode === "background") ctx.ui.notify(`Started final review #${id} (${mode}; ${reviewers.join(", ")}; target: ${bundle.target}).`, "info");

		const complete = async () => {
			let liveJobRemoved = false;
			const removeLiveJob = () => {
				if (liveJobRemoved) return;
				liveJobs.delete(id);
				liveJobRemoved = true;
			};
			try {
				const report = await promise;
				if (report.results.some((result) => result.outcome === "success")) {
					rememberDiffHash(reviewedDiffs, report.diffHash);
					pi.appendEntry(REVIEWED_DIFF_ENTRY_TYPE, { hash: report.diffHash, target: report.target, finishedAt: report.finishedAt });
				}
				rememberMapEntry(completedReports, report.id, report, MAX_COMPLETED_REPORTS);
				removeLiveJob();
				const sentFollowUp = sendReport(report, steer);
				const needsAttention = reportNeedsAttention(report);
				const summary = sentFollowUp ? summarizeReport(report) : `${summarizeReport(report)}. ${finalReportSendHint(report)}`;
				ctx.ui.notify(summary, needsAttention ? "warning" : "info");
				if (!needsAttention) await afterCleanReview?.(report);
				return report;
			} finally {
				clearInterval(ticker);
				contextSignal?.removeEventListener("abort", abortFromContext);
				removeLiveJob();
				if (currentJob?.id === id) currentJob = undefined;
				setStatus(ctx);
			}
		};

		if (mode === "blocking") return complete();
		void complete();
		return undefined;
	}

	async function runFinalChecksForBundle(ctx: ExtensionContext, bundle: ReviewBundle, checksConfig: FinalChecksConfig, source: "auto" | "manual", options: { changedPaths?: string[]; commands?: FinalCheckCommand[] } = {}): Promise<FinalCheckReport | undefined> {
		if (currentJob) {
			ctx.ui.notify(`Final review #${currentJob.id} is already running. Use /final-review status or /final-review cancel.`, "warning");
			return undefined;
		}
		if (currentCheckJob) {
			ctx.ui.notify(`Final checks #${currentCheckJob.id} are already running. Use /final-review status or /final-review cancel.`, "warning");
			return undefined;
		}
		if (!checksConfig.enabled) {
			if (source === "manual") ctx.ui.notify(`Final checks are disabled in ${CONFIG_PATH}. Use /final-review checks on after adding commands.`, "info");
			return undefined;
		}
		const commands = options.commands ?? await resolveFinalCheckCommands(ctx.cwd, checksConfig, source, options.changedPaths ?? []);
		if (commands.length === 0) {
			if (source === "manual") ctx.ui.notify(`No final check commands are configured in ${CONFIG_PATH}.`, "warning");
			return undefined;
		}

		const diffHash = reviewBundleHash(bundle);
		const checkKey = finalCheckRunKey(diffHash, commands, checksConfig.timeoutMs);
		const id = nextCheckJobId++;
		const controller = new AbortController();
		const contextSignal = ctx.signal;
		const abortFromContext = () => controller.abort();
		if (contextSignal?.aborted) abortFromContext();
		else contextSignal?.addEventListener("abort", abortFromContext, { once: true });
		const startedAt = Date.now();
		const progress: FinalCheckProgress[] = commands.map((command) => ({ name: command.name, command: command.command }));
		let promise!: Promise<FinalCheckReport>;
		currentCheckJob = { id, startedAt, controller, promise: undefined as unknown as Promise<FinalCheckReport>, target: bundle.target, diffHash, commands, progress };
		liveCheckJobs.set(id, currentCheckJob);
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: summarizeCheckJob(currentCheckJob),
				display: true,
				details: { kind: "live-checks", jobId: id } satisfies LiveCheckDetails,
			},
			{ triggerTurn: false },
		);

		promise = (async (): Promise<FinalCheckReport> => {
			const results: FinalCheckResult[] = [];
			for (let i = 0; i < commands.length; i++) {
				const command = commands[i]!;
				const item = progress[i]!;
				item.startedAt = Date.now();
				setStatus(ctx);
				const result = await runFinalCheckCommand(pi, ctx.cwd, command, checksConfig.timeoutMs, controller.signal);
				item.finishedAt = Date.now();
				item.outcome = result.outcome;
				item.lastText = result.output;
				results.push(result);
				setStatus(ctx);
				if (finalCheckResultNeedsAttention(result) && !checksConfig.continueOnFailure) {
					for (let j = i + 1; j < commands.length; j++) {
						const skipped = commands[j]!;
						const skippedProgress = progress[j]!;
						const skippedAt = Date.now();
						skippedProgress.startedAt = skippedAt;
						skippedProgress.finishedAt = skippedAt;
						skippedProgress.outcome = "skipped";
						skippedProgress.lastText = "Skipped because a previous final check failed.";
						results.push({
							name: skipped.name,
							command: skipped.command,
							cwd: skipped.cwd,
							outcome: "skipped",
							durationMs: 0,
							output: "Skipped because a previous final check failed and continueOnFailure=false.",
						});
					}
					setStatus(ctx);
					break;
				}
				if (controller.signal.aborted) break;
			}
			return {
				id,
				startedAt,
				finishedAt: Date.now(),
				target: bundle.target,
				diffHash,
				commands,
				results,
			};
		})();
		currentCheckJob.promise = promise;
		const ticker = setInterval(() => setStatus(ctx), 1000);
		ticker.unref();
		setStatus(ctx);
		ctx.ui.notify(`Started final checks #${id} (${commands.length} command${commands.length === 1 ? "" : "s"}; target: ${bundle.target}).`, "info");

		let liveJobRemoved = false;
		const removeLiveJob = () => {
			if (liveJobRemoved) return;
			liveCheckJobs.delete(id);
			liveJobRemoved = true;
		};
		try {
			const report = await promise;
			if (finalCheckReportPassed(report)) {
				rememberDiffHash(checkedDiffs, checkKey);
				pi.appendEntry(CHECKED_DIFF_ENTRY_TYPE, { hash: checkKey, diffHash: report.diffHash, target: report.target, finishedAt: report.finishedAt });
			}
			rememberMapEntry(completedCheckReports, report.id, report, MAX_COMPLETED_REPORTS);
			removeLiveJob();
			const sentFollowUp = sendFinalCheckReport(report, checksConfig);
			ctx.ui.notify(summarizeFinalCheckReport(report), finalCheckReportNeedsAttention(report) || sentFollowUp ? "warning" : "info");
			return report;
		} finally {
			clearInterval(ticker);
			contextSignal?.removeEventListener("abort", abortFromContext);
			removeLiveJob();
			if (currentCheckJob?.id === id) currentCheckJob = undefined;
			setStatus(ctx);
		}
	}

	async function maybeAutoReview(ctx: ExtensionContext) {
		if (currentJob || currentCheckJob) return;
		const config = await loadConfig(ctx.cwd).catch((error) => {
			ctx.ui.notify(`Final review auto-run skipped: failed to read ${CONFIG_PATH}: ${friendlyErrorMessage(error)}`, "warning");
			return undefined;
		});
		if (!config?.enabled) return;
		const shouldRunChecks = finalChecksConfigured(config.finalChecks);
		if (!config.autoReview && !shouldRunChecks) return;

		const changedPaths = await getChangedPaths(pi, ctx.cwd, ctx.signal).catch(() => []);
		const autoTarget: AutoReviewTarget | undefined = changedPaths.length > 0
			? { reason: "working-copy", changedPaths, description: "working-copy changes" }
			: await getRecentCommitAutoReviewTarget(pi, ctx.cwd, ctx.signal).catch(() => undefined);
		if (!autoTarget) return;

		const bundle = await buildReviewBundle(pi, ctx.cwd, ctx.signal, autoTarget.targetRev).catch((error) => {
			ctx.ui.notify(`Final review auto-run skipped: could not build review target: ${friendlyErrorMessage(error)}`, "warning");
			return undefined;
		});
		if (!bundle) return;
		const diffHash = reviewBundleHash(bundle);
		if (!await shouldProceedForUnchangedTurn(ctx, config, bundle, diffHash)) return;
		const docsOnly = allDocumentationPaths(autoTarget.changedPaths);
		let finalChecksPassedForDiff = !shouldRunChecks;

		if (shouldRunChecks) {
			const commands = await resolveFinalCheckCommands(ctx.cwd, config.finalChecks, "auto", autoTarget.changedPaths).catch((error) => {
				ctx.ui.notify(`Final checks auto-run skipped: failed to resolve child project checks: ${friendlyErrorMessage(error)}`, "warning");
				return undefined;
			});
			if (!commands) return;
			if (commands.length === 0) finalChecksPassedForDiff = true;
			if (commands.length > 0) {
				const checkKey = finalCheckRunKey(diffHash, commands, config.finalChecks.timeoutMs);
				if (checkedDiffs.has(checkKey)) {
					// Checks already passed for this exact diff and command set.
					finalChecksPassedForDiff = true;
				} else if (autoCheckAttemptedDiffs.has(checkKey)) return;
				else {
					rememberDiffHash(autoCheckAttemptedDiffs, checkKey);
					const checkReport = await runFinalChecksForBundle(ctx, bundle, config.finalChecks, "auto", { changedPaths: autoTarget.changedPaths, commands }).catch((error) => {
						ctx.ui.notify(`Final checks auto-run failed: ${friendlyErrorMessage(error)}`, "warning");
						return undefined;
					});
					if (!checkReport || !finalCheckReportPassed(checkReport)) return;
					finalChecksPassedForDiff = true;
				}
			}
		}

		const remindToCommit = () => maybeSendCommitReminder(ctx, config, autoTarget, bundle, diffHash, { checksPassed: finalChecksPassedForDiff });
		if (!config.autoReview) {
			await remindToCommit();
			return;
		}
		if (docsOnly && config.docsOnlyReview === "skip") {
			await remindToCommit();
			return;
		}
		if (reviewedDiffs.has(diffHash) || autoAttemptedDiffs.has(diffHash)) {
			await remindToCommit();
			return;
		}

		if (docsOnly && config.docsOnlyReview === "ask") {
			if (!ctx.hasUI) return;
			const preview = autoTarget.changedPaths.slice(0, 8).join("\n");
			const suffix = autoTarget.changedPaths.length > 8 ? `\n... +${autoTarget.changedPaths.length - 8} more` : "";
			const prompt = finalChecksPassedForDiff ? "Final checks passed. Run final review now?" : "Run final review now?";
			const ok = await ctx.ui.confirm("Review documentation-only changes?", `${autoTarget.description}:\n\n${preview}${suffix}\n\n${prompt}`);
			rememberDiffHash(autoAttemptedDiffs, diffHash);
			if (!ok) {
				await remindToCommit();
				return;
			}
		} else {
			rememberDiffHash(autoAttemptedDiffs, diffHash);
		}

		await runReview(ctx, config.defaultMode, config.reviewers, `Automatic review after ${autoTarget.description}.`, shouldAutoReviewSteer(config), autoTarget.targetRev, false, async () => {
			await remindToCommit();
		}).catch((error) => {
			ctx.ui.notify(`Final review auto-run failed: ${friendlyErrorMessage(error)}`, "warning");
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (const hash of reviewedDiffHashesFromEntries(entries)) rememberDiffHash(reviewedDiffs, hash);
		for (const hash of checkedDiffHashesFromEntries(entries)) rememberDiffHash(checkedDiffs, hash);
		for (const report of reviewReportsFromEntries(entries)) {
			rememberMapEntry(completedReports, report.id, report, MAX_COMPLETED_REPORTS);
			nextJobId = Math.max(nextJobId, report.id + 1);
		}
		for (const report of finalCheckReportsFromEntries(entries)) {
			rememberMapEntry(completedCheckReports, report.id, report, MAX_COMPLETED_REPORTS);
			nextCheckJobId = Math.max(nextCheckJobId, report.id + 1);
		}
		setStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnStartSnapshot = undefined;
		const config = await loadConfig(ctx.cwd).catch(() => undefined);
		if (!config || !autoFinalizationConfigured(config)) return;
		turnStartSnapshot = await captureTurnStartSnapshot(ctx).catch(() => undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		try {
			await maybeAutoReview(ctx);
		} finally {
			turnStartSnapshot = undefined;
		}
	});

	async function handleCommand(args: string, ctx: ExtensionContext) {
		let config: FinalReviewConfig;
		try {
			config = await loadConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`Final review config error in ${CONFIG_PATH}: ${friendlyErrorMessage(error)}`, "error");
			return;
		}
		const parsed = parseArgs(args, config);
		if (parsed.action === "status") {
			if (currentJob) {
				ctx.ui.notify(`Final review #${currentJob.id} running for ${formatDuration(Date.now() - currentJob.startedAt)} (${currentJob.mode}; ${currentJob.reviewers.join(", ")}; target ${currentJob.target}; diff ${currentJob.diffHash}).`, "info");
				return;
			}
			if (currentCheckJob) {
				ctx.ui.notify(`Final checks #${currentCheckJob.id} running for ${formatDuration(Date.now() - currentCheckJob.startedAt)} (${currentCheckJob.commands.length} command${currentCheckJob.commands.length === 1 ? "" : "s"}; target ${currentCheckJob.target}; diff ${currentCheckJob.diffHash}).`, "info");
				return;
			}
			ctx.ui.notify("No final review or final checks are running.", "info");
			setStatus(ctx);
			return;
		}
		if (parsed.action === "cancel") {
			if (currentJob) {
				currentJob.controller.abort();
				ctx.ui.notify(`Cancelling final review #${currentJob.id}.`, "warning");
				return;
			}
			if (currentCheckJob) {
				currentCheckJob.controller.abort();
				ctx.ui.notify(`Cancelling final checks #${currentCheckJob.id}.`, "warning");
				return;
			}
			ctx.ui.notify("No final review or final checks are running.", "info");
			return;
		}
		if (parsed.action === "config") {
			ctx.ui.notify(
				`Final review config (${CONFIG_PATH} optional):\n` +
					JSON.stringify(config, null, 2) +
					`\n\nCommand examples:\n/final-review enable\n/final-review auto on\n/final-review auto off\n/final-review checks\n/final-review checks on\n/final-review checks off\n/final-review both\n/final-review blocking both\n/final-review codex rev @-\n/final-review background glm --target abc123 steer\n/final-review force both\n/final-review send [latest|#id]\n/final-review note focus parser edge cases\n\nModel overrides: codexModel or PI_FINAL_REVIEW_CODEX_MODEL for openai-codex, glmModel or PI_FINAL_REVIEW_MODEL for ZAI.\nTimeouts: timeoutMs, finalChecks.timeoutMs, PI_FINAL_REVIEW_TIMEOUT_MS, and PI_FINAL_REVIEW_CHECK_TIMEOUT_MS are capped at ${MAX_TIMEOUT_MS}ms.\n\nAuto-review: /final-review enable writes ${CONFIG_PATH} with enabled=true and autoReview=true for this project. Auto-review runs after working-copy changes, or after a clean working copy if the previous jj commit / git HEAD was committed in the last ${Math.round(RECENT_COMMIT_AUTO_REVIEW_WINDOW_MS / 1000)}s. docsOnlyReview=ask|auto|skip controls documentation-only review.\n\nFinal checks: set finalChecks.enabled=true and finalChecks.commands=[\"npm run typecheck\", {\"name\":\"build\",\"command\":\"npm run build\"}] to run project commands after agent turns. Meta workspaces can set finalChecks.childProjects={enabled:true, projects:[{path:\"agent-tick\"}], defaults:{commandWrapper:\"devbox run -- bash -lc {command:q}\"}} to aggregate child repo checks. commitReminder.enabled=true sends a jj commit reminder after successful checks/clean review, but only when this turn changed the target. Failing checks are sent back to the agent as a follow-up and automatic review is deferred until checks pass. sendFollowUp only forwards actionable review results; /final-review send forwards any completed review report on demand.`,
				"info",
			);
			return;
		}
		if (parsed.action === "enable" || parsed.action === "auto-on" || parsed.action === "disable" || parsed.action === "auto-off") {
			try {
				const patch = parsed.action === "disable" ? { enabled: false } : parsed.action === "auto-off" ? { autoReview: false } : { enabled: true, autoReview: true };
				const next = await writeLocalConfigPatch(ctx.cwd, patch);
				const summary = JSON.stringify({ enabled: next.enabled, autoReview: next.autoReview }, null, 2);
				const verb = parsed.action === "disable" ? "Disabled final review" : parsed.action === "auto-off" ? "Disabled final review auto-review" : "Enabled final review auto-review";
				ctx.ui.notify(`${verb} for this project in ${CONFIG_PATH}.\n${summary}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to update ${CONFIG_PATH}: ${friendlyErrorMessage(error)}`, "error");
			}
			return;
		}
		if (parsed.action === "checks-on" || parsed.action === "checks-off") {
			try {
				const local = await loadLocalConfig(ctx.cwd);
				const existing = isRecord(local.finalChecks) ? local.finalChecks : Array.isArray(local.finalChecks) ? { commands: local.finalChecks } : {};
				const enabled = parsed.action === "checks-on";
				const next = await writeLocalConfigPatch(ctx.cwd, { finalChecks: { ...existing, enabled } });
				const nextChecks = isRecord(next.finalChecks) ? next.finalChecks : {};
				ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} final checks for this project in ${CONFIG_PATH}.\n${JSON.stringify({ finalChecks: nextChecks }, null, 2)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to update ${CONFIG_PATH}: ${friendlyErrorMessage(error)}`, "error");
			}
			return;
		}
		if (parsed.action === "checks") {
			if (!config.enabled) {
				ctx.ui.notify(`Final review is disabled by ${CONFIG_PATH}.`, "info");
				return;
			}
			const bundle = await buildReviewBundle(pi, ctx.cwd, ctx.signal).catch((error) => {
				ctx.ui.notify(`Final checks could not build review target: ${friendlyErrorMessage(error)}`, "error");
				return undefined;
			});
			if (!bundle) return;
			await runFinalChecksForBundle(ctx, bundle, config.finalChecks, "manual").catch((error) => {
				ctx.ui.notify(`Final checks failed: ${friendlyErrorMessage(error)}`, "error");
			});
			return;
		}
		if (parsed.action === "send") {
			const reference = parseReportReference(parsed.extra);
			if (reference === undefined) {
				ctx.ui.notify("Usage: /final-review send [latest|#id]", "warning");
				return;
			}
			const report = completedReportForReference(completedReports, reference);
			if (!report) {
				const requested = reference === "latest" ? "completed final review" : `final review #${reference}`;
				const stillRunning = reference !== "latest" && (currentJob?.id === reference || liveJobs.has(reference)) ? " It is still running." : reference === "latest" && currentJob ? ` Final review #${currentJob.id} is still running.` : "";
				ctx.ui.notify(`No ${requested} is available.${stillRunning}${formatAvailableReportIds(completedReports)}`, "warning");
				return;
			}
			pi.sendUserMessage(finalReportFollowUpMessage(report), { deliverAs: "followUp" });
			ctx.ui.notify(`Sent final review #${report.id} to chat.`, reportNeedsAttention(report) ? "warning" : "info");
			return;
		}
		if (parsed.action === "note") {
			if (!currentJob) {
				ctx.ui.notify("No final review is running.", "info");
				return;
			}
			const note = parsed.extra.trim();
			if (!note) {
				ctx.ui.notify("Usage: /final-review note <message>", "warning");
				return;
			}
			currentJob.notes.push(note);
			setStatus(ctx);
			ctx.ui.notify("Added display-only note to the running final review. Live reviewer steering is not supported while SDK sub-agents are in-flight.", "info");
			return;
		}

		await runReview(ctx, parsed.mode, parsed.reviewers, parsed.extra, parsed.steer, parsed.target, parsed.force).catch((error) => {
			ctx.ui.notify(`Final review failed: ${friendlyErrorMessage(error)}`, "error");
		});
	}

	pi.registerCommand("final-review", {
		description: "Run final checks and read-only SDK sub-agent final review. Usage: /final-review enable|auto on|auto off|checks [on|off]|[background|blocking] [both|codex|glm] [rev <rev>] [steer] [force]; /final-review send [latest|#id]|status|cancel|note <text>|config",
		handler: handleCommand,
	});

	pi.registerCommand("review", {
		description: "Alias for /final-review.",
		handler: handleCommand,
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		const report = isReviewReport(details) ? details : undefined;
		const checkReport = isFinalCheckReport(details) ? details : undefined;
		const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") : "Final review";
		if (isLiveReviewDetails(details)) {
			const liveJob = liveJobs.get(details.jobId);
			const completed = completedReports.get(details.jobId);
			if (liveJob) {
				const liveContent = summarizeJob(liveJob);
				let text = `${theme.fg("accent", "◐")} ${theme.bold("Final Review")} ${theme.fg("dim", "·")} ${liveContent}`;
				if (expanded) text += `\n${theme.fg("dim", formatLiveJobDetails(liveJob))}`;
				else text += ` ${theme.fg("dim", "(expand for live progress)")}`;
				const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
				box.addChild(new Text(text, 0, 0));
				return box;
			}
			if (completed) {
				const attention = reportNeedsAttention(completed);
				const color = attention ? "warning" : "success";
				let text = `${theme.fg(color, attention ? "!" : "✓")} ${theme.bold("Final Review")} ${theme.fg("dim", "·")} ${summarizeReport(completed)} ${theme.fg("dim", "(final report posted separately)")}`;
				if (expanded) text += `\n${theme.fg("dim", `Target: ${completed.target}`)}`;
				const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
				box.addChild(new Text(text, 0, 0));
				return box;
			}
		}
		if (isLiveCheckDetails(details)) {
			const liveJob = liveCheckJobs.get(details.jobId);
			const completed = completedCheckReports.get(details.jobId);
			if (liveJob) {
				const liveContent = summarizeCheckJob(liveJob);
				let text = `${theme.fg("accent", "◐")} ${theme.bold("Final Checks")} ${theme.fg("dim", "·")} ${liveContent}`;
				if (expanded) text += `\n${theme.fg("dim", formatLiveCheckJobDetails(liveJob))}`;
				else text += ` ${theme.fg("dim", "(expand for live progress)")}`;
				const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
				box.addChild(new Text(text, 0, 0));
				return box;
			}
			if (completed) {
				const attention = finalCheckReportNeedsAttention(completed);
				const color = attention ? "warning" : "success";
				let text = `${theme.fg(color, attention ? "!" : "✓")} ${theme.bold("Final Checks")} ${theme.fg("dim", "·")} ${summarizeFinalCheckReport(completed)} ${theme.fg("dim", "(final report posted separately)")}`;
				if (expanded) text += `\n${theme.fg("dim", `Target: ${completed.target}`)}`;
				const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
				box.addChild(new Text(text, 0, 0));
				return box;
			}
		}
		if (checkReport) {
			const attention = finalCheckReportNeedsAttention(checkReport);
			const color = attention ? "warning" : "success";
			let text = `${theme.fg(color, attention ? "!" : "✓")} ${theme.bold("Final Checks")} ${theme.fg("dim", "·")} ${content}`;
			if (expanded) text += `\n${theme.fg("dim", formatFinalCheckReport(checkReport, { includePassingOutput: true }))}`;
			else text += ` ${theme.fg("dim", attention ? "(expand for failing output)" : "(expand for command summary)")}`;
			const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
			box.addChild(new Text(text, 0, 0));
			return box;
		}
		let text = `${theme.fg("accent", "◐")} ${theme.bold("Final Review")} ${theme.fg("dim", "·")} ${content}`;
		if (report) {
			const attention = reportNeedsAttention(report);
			const color = attention ? "warning" : "success";
			text = `${theme.fg(color, attention ? "!" : "✓")} ${theme.bold("Final Review")} ${theme.fg("dim", "·")} ${content}`;
			if (expanded) text += `\n${theme.fg("dim", formatReport(report))}`;
			else text += ` ${theme.fg("dim", attention ? "(expand for findings)" : "(expand for reviewer output)")}`;
		}
		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(new Text(text, 0, 0));
		return box;
	});
}

export const __test__ = {
	allDocumentationPaths,
	baseReviewPrompt,
	DEFAULT_TIMEOUT_MS,
	finalReportMessage,
	finalReportFollowUpMessage,
	finalReportSendCommand,
	finalReportSendHint,
	formatDuration,
	formatFinalCheckReport,
	formatReport,
	getChangedPaths,
	getRecentCommitAutoReviewTarget,
	hashText,
	isDocumentationPath,
	parseArgs,
	commitReminderPrompt,
	commitReminderVcsState,
	parseChangedPaths,
	parseCommitReminderConfig,
	parseReportReference,
	parseTimestampMs,
	isLiveCheckDetails,
	isLiveReviewDetails,
	loadConfig,
	loadLocalConfig,
	MAX_COMPLETED_REPORTS,
	MAX_TIMEOUT_MS,
	RECENT_COMMIT_AUTO_REVIEW_WINDOW_MS,
	parseGitStatusPaths,
	applyCommandWrapper,
	discoverChildProjects,
	parseFinalCheckChildProjectsConfig,
	parseFinalCheckCommands,
	parseFinalChecksConfig,
	parseReviewerList,
	parseReviewerVerdict,
	parseReviewModelSpec,
	parseTimeoutMs,
	reviewBundleHash,
	checkedDiffHashesFromEntries,
	finalCheckReportNeedsAttention,
	finalCheckReportPassed,
	finalCheckReportsFromEntries,
	finalCheckRunKey,
	finalChecksCommandsHash,
	finalChecksFollowUpMessage,
	resolveFinalCheckCommands,
	reviewedDiffHashesFromEntries,
	rememberDiffHash,
	rememberMapEntry,
	unquoteGitPath,
	shortOutput,
	reportNeedsAttention,
	reportNeedsFollowUp,
	resultDisplayIcon,
	resultDisplayLabel,
	resultNeedsAttention,
	resultNeedsFollowUp,
	reviewerOutputNeedsFollowUp,
	reviewReportsFromEntries,
	shouldSendFollowUp,
	shouldAutoReviewSteer,
	summarizeFinalCheckReport,
	completedReportForReference,
	latestCompletedReport,
	writeLocalConfigPatch,
};
