import claudeKit from "../extensions/claude-kit.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Handler = (event: never, ctx?: never) => Promise<unknown>;
function makeKit() {
	const handlers: Record<string, Handler> = {};
	const notifies: string[] = [];
	claudeKit({ on: (ev: string, fn: Handler) => { handlers[ev] = fn; } } as never);
	return { handlers, notifies };
}

const results: [string, boolean][] = [];
function check(name: string, ok: boolean) {
	results.push([name, ok]);
}

// ---- fixture: project with rules + skills, pi started in a SUBFOLDER ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-kit-test-"));
const userHome = path.join(tmp, "home");
const userRulesDir = path.join(userHome, ".claude", "rules");
fs.mkdirSync(userRulesDir, { recursive: true });
fs.writeFileSync(
	path.join(userRulesDir, "compact-markdown.md"),
	'---\npaths:\n  - "docs/**/*.md"\n---\n# Compact Markdown\n\nUser rule.',
);
process.env.HOME = userHome;
process.env.USERPROFILE = userHome;
const proj = path.join(tmp, "proj");
const rulesDir = path.join(proj, ".claude", "rules");
fs.mkdirSync(path.join(proj, "apps", "admin"), { recursive: true });
fs.mkdirSync(rulesDir, { recursive: true });
fs.mkdirSync(path.join(proj, ".claude", "skills", "s1"), { recursive: true });

fs.writeFileSync(path.join(rulesDir, "always.md"), "# Always Rule\n\nAlways-on body content.");
fs.writeFileSync(
	path.join(rulesDir, "lazy.md"),
	'---\npaths:\n  - "apps/admin/**"\n---\n# Lazy Rule\n\nLazy body content.',
);
fs.writeFileSync(
	path.join(rulesDir, "lazy-inline.md"),
	'---\npaths: [src/**/*.{ts,tsx}] # trailing comment\n---\n# Inline\n\nInline body.',
);
fs.writeFileSync(
	path.join(rulesDir, "lazy-comment.md"),
	'---\npaths:\n  - "api/**" # yaml comment\n---\n# C\n\nComment body.',
);
fs.writeFileSync(
	path.join(rulesDir, "lazy-gaps.md"),
	'---\npaths:\n  - "zz/**"\n\n  # comment between items\n  - "yy/**"\n---\n# G\n\nGaps body.',
);

// symlinked rule (Claude Code shares rules via symlinks)
let symlinkOk = true;
try {
	fs.writeFileSync(path.join(tmp, "shared.md"), "---\npaths:\n  - \"lib/**\"\n---\n# Shared\n\nShared body.");
	fs.symlinkSync(path.join(tmp, "shared.md"), path.join(rulesDir, "shared.md"), "file");
} catch {
	symlinkOk = false;
}

const sub = path.join(proj, "apps", "admin");
const { handlers, notifies } = makeKit();
const ctx = {
	cwd: sub,
	ui: { notify: (msg: string) => notifies.push(msg) },
};

// 1. skills found from subfolder (fix #5)
const disc = (await handlers["resources_discover"]({ cwd: sub } as never)) as { skillPaths?: string[] };
check("#5 skills discovered from subfolder", disc.skillPaths?.[0] === fs.realpathSync.native(path.join(proj, ".claude", "skills")));

// 2. session_start from subfolder loads project rules (fix #5) + notify gating on resume (minor)
await handlers["session_start"]({ reason: "resume" } as never, ctx as never);
check("#5 rules scanned from subfolder root", notifies.length === 0);

// 3. before_agent_start mutates sections, returns nothing (fix #1)
const event = {
	systemPrompt: "BASE",
	systemPromptOptions: { sections: {} as Record<string, string> },
};
const ret = (await handlers["before_agent_start"](event as never)) as unknown;
const section = event.systemPromptOptions.sections["claude-rules"] ?? "";
check("#1 mutates sections, no systemPrompt return", ret === undefined && section.length > 0);
check("#1 always-on content inlined", section.includes("#### .claude/rules/always.md") && section.includes("Always-on body content."));
check("user lazy rule before project lazy rules", section.indexOf("compact-markdown.md") !== -1 && section.indexOf("compact-markdown.md") < section.indexOf("lazy.md"));
check("#3 inline array with braces + comment", section.includes("src/**/*.{ts,tsx}") && !section.includes("{ts,tsx}]"));
check("#3 list item comment stripped", section.includes("`api/**`") && !section.includes("yaml comment"));
check("#7 symlinked rule listed", symlinkOk ? section.includes("shared.md") && section.includes("`lib/**`") : true);
check("lazy list uses abs paths", section.includes(fs.realpathSync.native(path.join(rulesDir, "lazy.md")).replace(/\\/g, "/")));
check("lazy auto-inject wording", section.includes("injected automatically"));

// 4. tool_result auto-injection (fix #2)
const readResult = (file: string, structured: unknown = { marker: 1 }) =>
	handlers["tool_result"]({
		type: "tool_result",
		toolName: "read",
		toolCallId: "t1",
		input: { path: file },
		content: [{ type: "text", text: "FILE CONTENT" }],
		structuredContent: structured,
		isError: false,
	} as never) as Promise<{ content: { type: string; text: string }[]; structuredContent: unknown } | undefined>;

const r1 = await readResult("dashboard.ts"); // rel to projectRoot: apps/admin/dashboard.ts
const text1 = r1?.content.map((c) => c.text).join("") ?? "";
check("#2 rule injected on matching read", text1.includes("Lazy body content.") && text1.includes("lazy.md"));
check("#2 non-matching rules not injected", !text1.includes("Inline body.") && !text1.includes("Always Rule"));
check("#2 structuredContent preserved", r1?.structuredContent !== undefined);

const r2 = await readResult("dashboard.ts");
check("#2 injected once per rule per session", r2 === undefined); // same rule not re-injected

const r3 = await readResult("no-match.ts"); // apps/admin/** but lazy.md already injected
check("#2 no re-inject on later matching files", r3 === undefined);

const r4 = await readResult(path.join(proj, "src", "a.tsx")); // abs path -> src/a.tsx matches inline braces glob
const text4 = r4?.content.map((c) => c.text).join("") ?? "";
check("#2 brace glob via abs path", text4.includes("Inline body."));

const r5 = await readResult(path.join(tmp, "outside.ts")); // outside project root
check("#2 files outside root ignored", r5 === undefined);

const rErr = await handlers["tool_result"]({
	toolName: "read", toolCallId: "t2", input: { path: "dashboard.ts" }, content: [], isError: true,
} as never) as unknown;
check("#2 error results skipped", rErr === undefined);

// 5. malformed rules fail fast (fix #3)
const proj2 = path.join(tmp, "proj2");
fs.mkdirSync(path.join(proj2, ".claude", "rules"), { recursive: true });
fs.writeFileSync(path.join(proj2, ".claude", "rules", "bad.md"), "---\npaths:\n---\n# Bad");
const k2 = makeKit();
let threw = false;
try {
	await k2.handlers["session_start"]({ reason: "startup" } as never, { cwd: proj2, ui: { notify: () => {} } } as never);
} catch {
	threw = true;
}
check("#3 empty paths: throws (fail fast)", threw);

// 6. notify fires on startup
const k3 = makeKit();
const n3: string[] = [];
await k3.handlers["session_start"]({ reason: "startup" } as never, { cwd: proj, ui: { notify: (m: string) => n3.push(m) } } as never);
check("notify on startup", n3.length === 1 && n3[0].includes("rule(s)"));

// 7. round 2: YAML list with blank/comment lines between items (cleanup)
check("#3-blank/comment lines between list items skipped", section.includes("`zz/**`") && section.includes("`yy/**`"));

// 8. round 2: dir under home with no project marker -> no project root (bug #1)
const noProj = fs.mkdtempSync(path.join(userHome, "ck-np-"));
const k4 = makeKit();
await k4.handlers["session_start"]({ reason: "resume" } as never, { cwd: noProj, ui: { notify: () => {} } } as never);
const ev4 = { systemPrompt: "B", systemPromptOptions: { sections: {} as Record<string, string> } };
await k4.handlers["before_agent_start"](ev4 as never);
const sec4 = ev4.systemPromptOptions.sections["claude-rules"] ?? "";
const count = (s: string, needle: string) => s.split(needle).length - 1;
check("#1 no project root under home (no dup user rules)", count(sec4, "compact-markdown.md") === 1 && !sec4.includes("Lazy Rule"));
const disc4 = (await k4.handlers["resources_discover"]({ cwd: noProj } as never)) as { skillPaths?: string[] };
check("#1 no project skills under home", disc4.skillPaths === undefined);

// 9. round 2: .git stops the walk before a .claude ABOVE the repo (bug #1)
const proj4 = path.join(tmp, "proj4");
fs.mkdirSync(path.join(proj4, ".git"), { recursive: true });
fs.mkdirSync(path.join(tmp, ".claude", "rules"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".claude", "rules", "foreign.md"), "# Foreign\n\nForeign body.");
const k5 = makeKit();
await k5.handlers["session_start"]({ reason: "resume" } as never, { cwd: proj4, ui: { notify: () => {} } } as never);
const ev5 = { systemPrompt: "B", systemPromptOptions: { sections: {} as Record<string, string> } };
await k5.handlers["before_agent_start"](ev5 as never);
const sec5 = ev5.systemPromptOptions.sections["claude-rules"] ?? "";
check("#1 .git root stops walk; .claude above repo ignored", !sec5.includes("Foreign body.") && sec5.includes("compact-markdown.md"));

// 10. round 2: toolName guard (bug #2)
const rLs = await handlers["tool_result"]({
	toolName: "ls", toolCallId: "t3", input: { path: "apps/admin" }, content: [{ type: "text", text: "listing" }], isError: false,
} as never) as unknown;
check("#2 ls result never injects", rLs === undefined);

// 11. round 2: re-inject after compaction (bug #3)
await handlers["session_compact"]({} as never);
const r6 = await readResult("dashboard.ts");
const text6 = r6?.content.map((c) => c.text).join("") ?? "";
check("#3 rule re-injects after compaction", text6.includes("Lazy body content."));

// 12. round 3: nested tool results skipped and don't consume the slot
const rNested = await handlers["tool_result"]({
	toolName: "read", toolCallId: "t4/1", parentToolCallId: "t4", input: { path: path.join(proj, "src", "b.tsx") },
	content: [{ type: "text", text: "X" }], isError: false,
} as never) as unknown;
check("#nested result skipped", rNested === undefined);
const rDirect = await readResult(path.join(proj, "src", "b.tsx"));
check("#nested result doesn't consume slot", (rDirect?.content.map((c) => c.text).join("") ?? "").includes("Inline body."));

// 13. round 3: re-inject after tree/branch navigation
await handlers["session_tree"]({} as never);
const r7 = await readResult("dashboard.ts");
check("#tree navigation re-injects", (r7?.content.map((c) => c.text).join("") ?? "").includes("Lazy body content."));

// helpers for the edge-case sections below
const makeProj = (name: string, rules: Record<string, string>) => {
	const dir = path.join(tmp, name);
	for (const [file, content] of Object.entries(rules)) {
		const target = path.join(dir, ".claude", "rules", file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return dir;
};
const startKit = async (cwd: string) => {
	const kit = makeKit();
	await kit.handlers["session_start"]({ reason: "resume" } as never, { cwd, ui: { notify: () => {} } } as never);
	const ev = { systemPrompt: "B", systemPromptOptions: { sections: {} as Record<string, string> } };
	await kit.handlers["before_agent_start"](ev as never);
	return { kit, section: ev.systemPromptOptions.sections["claude-rules"] ?? "" };
};
const startError = async (cwd: string) => {
	try {
		await startKit(cwd);
		return null;
	} catch (e) {
		return (e as Error).message;
	}
};
// lazy list line for a rule file, and just its backticked globs
const lazyLine = (s: string, file: string) => s.split("\n").find((l) => l.startsWith("- ") && l.includes(file)) ?? "";
const lazyGlobs = (s: string, file: string) => lazyLine(s, file).split(" — ")[1] ?? "";
const readFrom = (kit: ReturnType<typeof makeKit>, file: string) =>
	kit.handlers["tool_result"]({
		type: "tool_result",
		toolName: "read",
		toolCallId: "t1",
		input: { path: file },
		content: [{ type: "text", text: "FILE CONTENT" }],
		isError: false,
	} as never) as Promise<{ content: { type: string; text: string }[] } | undefined>;

// 14. round 4: inline array and scalar forms of paths:
const proj5 = makeProj("proj5", {
	"mixed.md": "---\npaths: [\"a/**\", 'b/**', c/**]\n---\n# Mixed\n\nMixed body.",
	"braces.md": "---\npaths: [x/*.{ts,tsx}, y/**]\n---\n# Braces\n\nBraces body.",
	"scalar-quoted.md": '---\npaths: "docs/**"\n---\n# SQ\n\nSQ body.',
	"scalar-bare.md": "---\npaths: docs/**\n---\n# SB\n\nSB body.",
});
const { section: sec6 } = await startKit(proj5);
check("#4 inline array: mixed quoting yields three globs", lazyGlobs(sec6, "mixed.md") === "`a/**`, `b/**`, `c/**`");
check("#4 inline array: no stray quotes", !lazyLine(sec6, "mixed.md").includes('"') && !lazyLine(sec6, "mixed.md").includes("'"));
check("#4 inline array: comma inside braces not split", lazyGlobs(sec6, "braces.md") === "`x/*.{ts,tsx}`, `y/**`");
check("#4 scalar: quoted single glob", lazyGlobs(sec6, "scalar-quoted.md") === "`docs/**`");
check("#4 scalar: unquoted single glob", lazyGlobs(sec6, "scalar-bare.md") === "`docs/**`");

const proj6 = makeProj("proj6", { "empty.md": "---\npaths: []\n---\n# Empty" });
const err6 = await startError(proj6);
check("#4 empty inline array throws (fail fast)", err6 !== null && err6.includes("no globs"));

const proj7 = makeProj("proj7", { "open.md": "---\npaths: [a/**\n---\n# Open" });
const err7 = await startError(proj7);
check("#4 unbalanced inline array throws (fail fast)", err7 !== null && err7.includes("unbalanced"));

// 15. round 4: circular symlink inside the rules dir
const proj8 = makeProj("proj8", { "sub/rule.md": "# Loop Rule\n\nLoop body." });
let loopOk = true;
try {
	fs.symlinkSync(path.join(proj8, ".claude", "rules"), path.join(proj8, ".claude", "rules", "sub", "loop"), "junction");
} catch {
	loopOk = false;
}
let loopThrew = false;
let loopSection = "";
try {
	loopSection = (await startKit(proj8)).section;
} catch {
	loopThrew = true;
}
check("#7 circular symlink: session_start completes", loopOk ? !loopThrew : true);
check("#7 circular symlink: rule listed once", loopOk ? count(loopSection, "#### .claude/rules/sub/rule.md") === 1 : true);
check("#7 circular symlink: rule body inlined once", loopOk ? count(loopSection, "Loop body.") === 1 : true);

// 16. round 4: paths: mixed with other frontmatter keys
const proj9 = makeProj("proj9", {
	"meta.md":
		'---\ndescription: meta-desc-A\nalwaysApply: false\npaths:\n  - "m/**"\n  - n/**\ntags: x\n---\n# Meta\n\nMeta body.',
	"plain.md": "---\ndescription: only-desc-B\n---\n# Plain\n\nPlain body.",
});
const { kit: kit9, section: sec9 } = await startKit(proj9);
check("#4 other keys: list globs parsed, following key not a glob", lazyGlobs(sec9, "meta.md") === "`m/**`, `n/**`");
check("#4 other keys: frontmatter text not in section", !sec9.includes("meta-desc-A") && !sec9.includes("alwaysApply") && !sec9.includes("tags: x"));
const rMeta1 = await readFrom(kit9, "m/x.ts");
const textMeta1 = rMeta1?.content.map((c) => c.text).join("") ?? "";
check("#4 other keys: body injected without frontmatter", textMeta1.includes("Meta body.") && !textMeta1.includes("meta-desc-A") && !textMeta1.includes("alwaysApply") && !textMeta1.includes("tags: x") && !textMeta1.includes("paths:"));
await kit9.handlers["session_compact"]({} as never);
const rMeta2 = await readFrom(kit9, "n/y.ts");
check("#4 other keys: second list glob matches", (rMeta2?.content.map((c) => c.text).join("") ?? "").includes("Meta body."));
check("#4 non-paths frontmatter only: always-on, frontmatter stripped", sec9.includes("#### .claude/rules/plain.md\n\n# Plain\n\nPlain body.") && !sec9.includes("only-desc-B"));
check("#4 non-paths frontmatter only: not in lazy list", lazyLine(sec9, "plain.md") === "");

fs.rmSync(noProj, { recursive: true, force: true });

let failed = 0;
for (const [name, ok] of results) {
	console.log(ok ? "PASS" : "FAIL", "-", name);
	if (!ok) failed++;
}
console.log(failed === 0 ? "ALL-PASS" : `${failed} FAILED`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
