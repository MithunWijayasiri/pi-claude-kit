/**
 * Claude Kit (global)
 *
 * Bridges Claude Code project conventions into pi:
 *   - <project>/.claude/skills/        -> pi skill discovery (resources_discover)
 *   - .claude/rules/ + ~/.claude/rules/ -> Claude Code rules loading model:
 *     no `paths:` frontmatter -> always-on (content injected into the system
 *     prompt); `paths:` globs -> lazy (auto-injected into the first
 *     read/edit/write of a matching file, once per rule per session).
 *
 * Project root is the nearest ancestor of cwd containing `.claude` or `.git`
 * (never home — `~/.claude` is user config); glob matching is relative to that
 * root.
 *
 * CLAUDE.md caveats: pi loads it natively, but only one context file per dir
 * (AGENTS.md shadows CLAUDE.md in the same dir). `~/.claude/CLAUDE.md`,
 * `.claude/CLAUDE.md`, `CLAUDE.local.md`, and `@import` directives are not
 * loaded by pi.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

interface Rule {
	displayPath: string;
	absPath: string;
	/** Empty = always-on (no `paths:` frontmatter). */
	globs: string[];
	/** File body with frontmatter stripped. */
	body: string;
}

/**
 * Recursively find all .md files in a directory. Follows symlinks (Claude Code
 * rules are shared via symlinked dirs/files); a visited set guards circular links.
 */
function findMarkdownFiles(dir: string, visited: Set<string> = new Set()): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	let real: string;
	try {
		real = fs.realpathSync(dir);
	} catch {
		return [];
	}
	if (visited.has(real)) {
		return [];
	}
	visited.add(real);

	const results: string[] = [];

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();

		if (entry.isSymbolicLink()) {
			try {
				const stat = fs.statSync(fullPath);
				isDir = stat.isDirectory();
				isFile = stat.isFile();
			} catch {
				continue;
			}
		}

		if (isDir) {
			results.push(...findMarkdownFiles(fullPath, visited));
		} else if (isFile && entry.name.endsWith(".md")) {
			results.push(fullPath);
		}
	}

	return results;
}

/**
 * Canonical path — `realpathSync.native` resolves 8.3 short names and symlinks.
 * For paths that don't exist yet (writes), canonicalizes the deepest existing
 * ancestor and re-appends the tail.
 */
function canonical(p: string): string {
	let current = path.resolve(p);
	const tail: string[] = [];

	while (true) {
		try {
			return path.join(fs.realpathSync.native(current), ...tail);
		} catch {
			// unwind to the nearest existing ancestor
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return path.resolve(p);
		}
		tail.unshift(path.basename(current));
		current = parent;
	}
}

/**
 * Project root for loading and glob matching: nearest ancestor of startDir
 * (inclusive) containing `.claude` or `.git`. Never home — `~/.claude` is user
 * config, not a project. Returns null when no root is found.
 */
function findProjectRoot(startDir: string): string | null {
	const home = canonical(os.homedir());
	const isHome = (dir: string) =>
		process.platform === "win32" ? dir.toLowerCase() === home.toLowerCase() : dir === home;
	let current = canonical(startDir);

	while (true) {
		if (isHome(current)) {
			return null;
		}
		if (fs.existsSync(path.join(current, ".claude")) || fs.existsSync(path.join(current, ".git"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/** Unquote one glob and strip a trailing YAML comment. */
function cleanGlob(item: string): string {
	const quoted = /^["']([^"']*)["']/.exec(item.trim());
	if (quoted) {
		return quoted[1];
	}
	return item.trim().replace(/\s+#.*$/, "").trim();
}

/** Split an inline `[a, b]` array on commas outside quotes and `{}` groups. */
function splitInlineArray(inner: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let quote = "";
	let current = "";

	for (const ch of inner) {
		if (quote) {
			if (ch === quote) quote = "";
			current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
		} else if (ch === "{") {
			depth++;
			current += ch;
		} else if (ch === "}") {
			depth--;
			current += ch;
		} else if (ch === "," && depth === 0) {
			items.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	items.push(current);

	return items.map(cleanGlob).filter(Boolean);
}

/**
 * Parse the `paths:` value out of a frontmatter block. Only `paths:` is a
 * recognized key; everything else is ignored. Supports the YAML list form and
 * an inline `[a, b]` array. `paths:` present with zero parsed globs is a
 * malformed rule and throws. Absent `paths:` means always-on.
 */
function parsePathsGlobs(frontmatterLines: string[], absPath: string): string[] {
	for (let i = 0; i < frontmatterLines.length; i++) {
		const line = frontmatterLines[i].trim();
		if (!line.startsWith("paths:")) {
			continue;
		}

		const inline = line.slice("paths:".length).trim();
		let globs: string[];

		if (inline.startsWith("[")) {
			const close = inline.indexOf("]");
			if (close === -1) {
				throw new Error(`claude-kit: unbalanced "paths:" array in ${absPath}`);
			}
			globs = splitInlineArray(inline.slice(1, close));
		} else if (inline) {
			globs = [cleanGlob(inline)];
		} else {
			globs = [];
			for (let j = i + 1; j < frontmatterLines.length; j++) {
				const item = frontmatterLines[j].trim();
				if (!item || item.startsWith("#")) {
					continue;
				}
				if (/^[A-Za-z_-]+\s*:/.test(item)) {
					break;
				}
				if (item.startsWith("-")) {
					const glob = cleanGlob(item.slice(1));
					if (glob) globs.push(glob);
				}
			}
		}

		if (globs.length === 0) {
			throw new Error(`claude-kit: "paths:" frontmatter with no globs in ${absPath}`);
		}
		return globs;
	}

	return [];
}

function parseRule(absPath: string, rulesDir: string, displayRoot: string): Rule {
	const text = fs.readFileSync(absPath, "utf8");
	const lines = text.split(/\r?\n/);

	let globs: string[] = [];
	let body = text;

	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
		if (close === -1) {
			throw new Error(`claude-kit: unterminated frontmatter in ${absPath}`);
		}
		globs = parsePathsGlobs(lines.slice(1, close), absPath);
		body = lines.slice(close + 1).join("\n");
	}

	const relative = path.relative(rulesDir, absPath).replace(/\\/g, "/");
	return {
		displayPath: `${displayRoot}/${relative}`,
		absPath,
		globs,
		body,
	};
}

function loadRules(rulesDir: string, displayRoot: string): Rule[] {
	return findMarkdownFiles(rulesDir).map((absPath) => parseRule(absPath, rulesDir, displayRoot));
}

/** Build the "claude-rules" system prompt section once per session. */
function buildRulesSection(rules: Rule[]): string {
	if (rules.length === 0) {
		return "";
	}

	const sections: string[] = [];

	const alwaysOn = rules.filter((r) => r.globs.length === 0);
	if (alwaysOn.length > 0) {
		const blocks = alwaysOn
			.map((r) => `#### ${r.displayPath}\n\n${r.body.trim()}`)
			.join("\n\n");
		sections.push(`### Always-on rules\n\n${blocks}`);
	}

	const lazy = rules.filter((r) => r.globs.length > 0);
	if (lazy.length > 0) {
		const list = lazy
			.map((r) => `- \`${normalizeForMatch(r.absPath)}\` — ${r.globs.map((g) => `\`${g}\``).join(", ")}`)
			.join("\n");
		sections.push(
			`### Path-scoped rules (lazy)\n\nThese rules apply only to files matching their globs and are injected automatically when a matching file is read, edited, or written.\n\n${list}`,
		);
	}

	return `## Rules\n\n${sections.join("\n\n")}`;
}

function normalizeForMatch(p: string): string {
	return p.replace(/\\/g, "/");
}

export default function claudeKit(pi: ExtensionAPI) {
	let projectRoot: string | null = null;
	let sessionCwd = "";
	let rules: Rule[] = [];
	let rulesSectionText = "";
	const injectedRules = new Set<string>();

	pi.on("resources_discover", async (event) => {
		const root = findProjectRoot(event.cwd);
		const projectSkills = root ? path.join(root, ".claude", "skills") : null;
		if (projectSkills && fs.existsSync(projectSkills)) {
			return { skillPaths: [projectSkills] };
		}
		return {};
	});

	// Scan rules on session start (user rules load before project rules)
	pi.on("session_start", async (event, ctx) => {
		projectRoot = findProjectRoot(ctx.cwd);
		sessionCwd = canonical(ctx.cwd);
		injectedRules.clear();

		const userRules = loadRules(path.join(os.homedir(), ".claude", "rules"), "~/.claude/rules");
		const projectRules = projectRoot
			? loadRules(path.join(projectRoot, ".claude", "rules"), ".claude/rules")
			: [];
		rules = [...userRules, ...projectRules];
		rulesSectionText = buildRulesSection(rules);

		if (rules.length > 0 && (event.reason === "startup" || event.reason === "reload")) {
			const alwaysOn = rules.filter((r) => r.globs.length === 0).length;
			ctx.ui.notify(
				`Found ${rules.length} rule(s): ${alwaysOn} always-on, ${rules.length - alwaysOn} path-scoped`,
				"info",
			);
		}
	});

	// Always-on rules inline into the system prompt; path-scoped rules are
	// indexed with their globs (injected on first matching file touch)
	pi.on("before_agent_start", async (event) => {
		if (rulesSectionText) {
			event.systemPromptOptions.sections["claude-rules"] = rulesSectionText;
		}
	});

	// Lazy rules auto-inject into the first read/edit/write of a matching file
	const lazyHandler = async (event: ToolResultEvent) => {
		if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}
		// Nested results (codemode etc.) go to the calling tool, not the model
		if (event.parentToolCallId) {
			return;
		}
		if (event.isError || !projectRoot) {
			return;
		}
		const inputPath = event.input.path;
		if (typeof inputPath !== "string") {
			return;
		}

		const abs = canonical(path.resolve(sessionCwd, inputPath));
		const rel = normalizeForMatch(path.relative(projectRoot, abs));
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
			return;
		}

		const matches = rules.filter(
			(r) =>
				r.globs.length > 0 &&
				!injectedRules.has(r.absPath) &&
				r.globs.some((g) => path.matchesGlob(rel, g)),
		);
		if (matches.length === 0) {
			return;
		}

		for (const rule of matches) {
			injectedRules.add(rule.absPath);
		}

		const blocks = matches
			.map(
				(r) =>
					`[claude-kit] Rule ${r.displayPath} applies to \`${rel}\`. Follow it:\n\n${r.body.trim()}`,
			)
			.join("\n\n");
		const note: { type: "text"; text: string } = {
			type: "text",
			text: `\n\n---\n${blocks}\n---`,
		};

		return {
			content: [...event.content, note],
			structuredContent: event.structuredContent,
		};
	};

	pi.on("tool_result", lazyHandler);

	// Compaction or branch switches may drop injected rule text from context;
	// allow re-injection
	pi.on("session_compact", async () => {
		injectedRules.clear();
	});
	pi.on("session_tree", async () => {
		injectedRules.clear();
	});
}
