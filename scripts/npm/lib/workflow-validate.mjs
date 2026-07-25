// Structural release-workflow validation for the npm publish preflight.
// Line-presence checks cannot tell which job a control belongs to, so this
// parser reads the GitHub Actions YAML subset structurally and validates the
// effective structure of the single intended publish job. It is deliberately
// fail-closed: unsupported YAML features (anchors, aliases, tabs, duplicate
// keys) reject the workflow instead of guessing.

import fs from "node:fs";

const [workflowPath, expectedEnvironment] = process.argv.slice(2);
const REQUIRED_PUBLISH_COMMAND = "npm publish --provenance --access public";

const fail = (message) => {
	console.error(`error: workflow must ${message}`);
	process.exit(1);
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function parseWorkflow(text) {
	const entries = [];
	text.split(/\r?\n/u).forEach((raw, index) => {
		const line = index + 1;
		const indent = raw.length - raw.trimStart().length;
		if (/\t/u.test(raw.slice(0, indent))) fail(`avoid tabs (line ${line})`);
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) return;
		entries.push({ indent, text: trimmed, line });
	});

	let cursor = 0;
	const peek = () => entries[cursor];

	function parseBlock(indent) {
		const first = peek();
		if (!first || first.indent < indent) return undefined;
		if (first.text === "-" || first.text.startsWith("- ")) return parseSequence(indent);
		return parseMapping(indent);
	}

	function parseMapping(indent) {
		const result = {};
		for (;;) {
			const entry = peek();
			if (!entry || entry.indent !== indent || entry.text === "-" || entry.text.startsWith("- ")) {
				break;
			}
			const separator = entry.text.indexOf(":");
			if (separator <= 0) fail(`use "key: value" mappings (line ${entry.line})`);
			const key = entry.text.slice(0, separator).trim();
			if (!/^[A-Za-z0-9_-]+$/u.test(key)) fail(`use plain mapping keys (line ${entry.line})`);
			if (key in result) fail(`avoid duplicate key "${key}" (line ${entry.line})`);
			cursor += 1;
			result[key] = parseValue(entry, entry.text.slice(separator + 1).trim(), indent);
		}
		return result;
	}

	function parseSequence(indent) {
		const result = [];
		for (;;) {
			const entry = peek();
			if (
				!entry ||
				entry.indent !== indent ||
				!(entry.text === "-" || entry.text.startsWith("- "))
			) {
				break;
			}
			cursor += 1;
			if (entry.text === "-") {
				const child = peek();
				result.push(child && child.indent > indent ? parseBlock(child.indent) : null);
				continue;
			}
			// An inline "- key: value" item starts a mapping two columns deeper;
			// re-inject it so sibling keys at that indent join the same mapping.
			entries.splice(cursor, 0, {
				indent: indent + 2,
				text: entry.text.slice(2).trim(),
				line: entry.line,
			});
			result.push(parseBlock(indent + 2));
		}
		return result;
	}

	function parseValue(entry, value, indent) {
		if (value === "") {
			const child = peek();
			return child && child.indent > indent ? parseBlock(child.indent) : null;
		}
		if (value.startsWith("|") || value.startsWith(">")) {
			// Block scalar: keep raw lines so run scripts stay opaque text.
			const body = [];
			while (peek() && peek().indent > indent) {
				body.push(peek().text);
				cursor += 1;
			}
			return body.join("\n");
		}
		if (value.startsWith("&") || value.startsWith("*"))
			fail(`avoid anchors and aliases (line ${entry.line})`);
		if (value.startsWith("[")) {
			if (!value.endsWith("]")) fail(`close flow sequences (line ${entry.line})`);
			const inner = value.slice(1, -1).trim();
			return inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim(), entry));
		}
		if (value.startsWith("{")) {
			if (!value.endsWith("}")) fail(`close flow mappings (line ${entry.line})`);
			const inner = value.slice(1, -1).trim();
			const result = {};
			if (inner === "") return result;
			for (const pair of inner.split(",")) {
				const separator = pair.indexOf(":");
				if (separator <= 0) fail(`use "key: value" flow mappings (line ${entry.line})`);
				result[pair.slice(0, separator).trim()] = unquote(pair.slice(separator + 1).trim(), entry);
			}
			return result;
		}
		return unquote(value, entry);
	}

	function unquote(value, entry) {
		if (value.startsWith("'")) {
			if (!value.endsWith("'") || value.length < 2)
				fail(`close quoted scalars (line ${entry.line})`);
			return value.slice(1, -1).replace(/''/gu, "'");
		}
		if (value.startsWith('"')) {
			if (!value.endsWith('"') || value.length < 2)
				fail(`close quoted scalars (line ${entry.line})`);
			return value.slice(1, -1);
		}
		// Unquoted scalars end at an inline comment.
		return value.replace(/\s+#.*$/u, "").trim();
	}

	const document = parseBlock(0);
	return document === undefined ? null : document;
}

const document = parseWorkflow(fs.readFileSync(workflowPath, "utf8"));
if (!isRecord(document)) fail("be a mapping at the top level");

const triggers = document.on;
const tags = isRecord(triggers) && isRecord(triggers.push) ? triggers.push.tags : undefined;
if (!Array.isArray(tags) || tags.length === 0) fail("declare a tag trigger");

const jobs = document.jobs;
if (!isRecord(jobs) || Object.keys(jobs).length === 0) fail("define jobs");

const isPublishStep = (step) =>
	isRecord(step) && typeof step.run === "string" && /(^|\s)npm publish(?:\s|$)/u.test(step.run);
const publishJobs = Object.entries(jobs).filter(
	([, job]) => isRecord(job) && Array.isArray(job.steps) && job.steps.some(isPublishStep),
);
if (publishJobs.length !== 1) fail("define a single npm publish job");
const [, publishJob] = publishJobs[0];

const environment = isRecord(publishJob.environment)
	? publishJob.environment.name
	: publishJob.environment;
if (environment !== expectedEnvironment) fail("use the configured environment");

// Job permissions replace top-level permissions entirely, so the effective
// structure is the job's own mapping when present.
const permissions = publishJob.permissions ?? document.permissions;
if (!isRecord(permissions) || permissions["id-token"] !== "write") fail("grant id-token: write");

const publishSteps = publishJob.steps.filter(isPublishStep);
if (publishSteps.length !== 1) fail("define a single hardened npm publish step");
const [publishStep] = publishSteps;
if (publishStep.run.trim() !== REQUIRED_PUBLISH_COMMAND) {
	fail("publish with provenance and public access");
}
