// Structural release-workflow validation for the npm publish preflight.
// Parsing stays fail-closed because release authority must not depend on YAML
// syntax forms that hide or merge controls during review.

import fs from "node:fs";

import { isScalar, parseDocument, visit } from "yaml";

const [workflowPath, expectedEnvironment] = process.argv.slice(2);
const REQUIRED_PUBLISH_COMMAND = "npm publish --provenance --access public";

const fail = (message) => {
	console.error(`error: workflow must ${message}`);
	process.exit(1);
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function parseWorkflow(text) {
	const parsed = parseDocument(text, { uniqueKeys: true });
	const error = parsed.errors[0];
	if (error?.code === "DUPLICATE_KEY") fail("avoid duplicate keys");
	if (error?.code === "MULTIPLE_DOCS") fail("contain a single YAML document");
	if (error) fail("contain valid YAML syntax");
	if (parsed.warnings.length > 0) fail("contain no YAML warnings");

	visit(parsed, {
		Alias() {
			fail("avoid anchors and aliases");
		},
		Node(_key, node) {
			if (node.anchor) fail("avoid anchors and aliases");
			if (node.tag) fail("avoid explicit tags");
		},
		Pair(_key, pair) {
			if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
				fail("use string mapping keys");
			}
		},
	});
	return parsed.toJS({ maxAliasCount: 0 });
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
