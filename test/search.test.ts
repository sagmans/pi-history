import { strict as assert } from "node:assert";
import test from "node:test";

import type { HistoryEntry } from "../src/history-store.ts";
import {
	findGhostSuggestion,
	highlightMatches,
	isCursorAtTextEnd,
	removeLastGrapheme,
} from "../src/search.ts";
import { testHighlightSgr } from "./theme-fixture.ts";

test("highlightMatches colors matching chars in order", () => {
	const result = highlightMatches("write docs", "docs", testHighlightSgr);
	// "docs" are consecutive characters at positions 6-9 => single span
	assert.equal(result, `write ${testHighlightSgr.match}docs${testHighlightSgr.restore}`);
});

test("highlightMatches supports non-consecutive matches", () => {
	const result = highlightMatches("review the diff", "rvw", testHighlightSgr);
	// greedy: r@0, v@2, w@5 — non-consecutive, each its own span
	assert.equal(
		result,
		`${testHighlightSgr.match}r${testHighlightSgr.restore}e${testHighlightSgr.match}v${testHighlightSgr.restore}ie${testHighlightSgr.match}w${testHighlightSgr.restore} the diff`,
	);
});

test("highlightMatches is case-insensitive", () => {
	const result = highlightMatches("Git Commit", "git", testHighlightSgr);
	// G@0, i@1, t@2 — consecutive => single span
	assert.equal(result, `${testHighlightSgr.match}Git${testHighlightSgr.restore} Commit`);
});

test("highlightMatches returns plain label for empty query", () => {
	assert.equal(highlightMatches("write docs", "", testHighlightSgr), "write docs");
});

test("highlightMatches returns plain label for no match", () => {
	assert.equal(highlightMatches("write docs", "zzz", testHighlightSgr), "write docs");
});

test("highlightMatches keeps non-BMP surrogate pairs intact", () => {
	// \u{1F4BB} (laptop) is a single grapheme spanning two UTF-16 code units.
	// Code-unit indexing would inject SGR between the surrogates and corrupt
	// rendering; grapheme iteration keeps the pair whole.
	const emoji = "\u{1F4BB}";
	const result = highlightMatches(`${emoji} docs`, "docs", testHighlightSgr);
	assert.equal(result, `${emoji} ${testHighlightSgr.match}docs${testHighlightSgr.restore}`);
});

test("highlightMatches keeps multi-codepoint ZWJ graphemes intact", () => {
	// Woman technologist is one grapheme across several code units; the query
	// matches the trailing literal and the emoji must stay unsplit.
	const emoji = "\u{1F469}\u200D\u{1F4BB}";
	const result = highlightMatches(`${emoji} x`, "x", testHighlightSgr);
	assert.equal(result, `${emoji} ${testHighlightSgr.match}x${testHighlightSgr.restore}`);
});

test("ghost suggestion uses newest prefix match at cursor end", () => {
	const entries = [
		entry("review the diff for bugs"),
		entry("review the diff for style"),
	];

	assert.equal(
		findGhostSuggestion({
			entries,
			text: "review the diff",
			lines: ["review the diff"],
			cursor: { line: 0, col: 15 },
		}),
		" for bugs",
	);
});

test("ghost suggestion is absent for empty and exact buffers", () => {
	const entries = [entry("review the diff")];

	assert.equal(
		findGhostSuggestion({
			entries,
			text: "",
			lines: [""],
			cursor: { line: 0, col: 0 },
		}),
		undefined,
	);
	assert.equal(
		findGhostSuggestion({
			entries,
			text: "review the diff",
			lines: ["review the diff"],
			cursor: { line: 0, col: 15 },
		}),
		undefined,
	);
});

test("ghost suggestion is absent when cursor is not at text end", () => {
	const entries = [entry("review the diff")];

	assert.equal(
		findGhostSuggestion({
			entries,
			text: "review",
			lines: ["review"],
			cursor: { line: 0, col: 3 },
		}),
		undefined,
	);
});

test("cursor end check supports multiline buffers", () => {
	assert.equal(
		isCursorAtTextEnd({
			lines: ["first", "second"],
			cursor: { line: 1, col: 6 },
		}),
		true,
	);
	assert.equal(
		isCursorAtTextEnd({
			lines: ["first", "second"],
			cursor: { line: 0, col: 5 },
		}),
		false,
	);
});

function entry(text: string): HistoryEntry {
	return {
		text,
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		useCount: 1,
	};
}

test("removeLastGrapheme deletes one full grapheme, not one UTF-16 unit", () => {
	assert.equal(removeLastGrapheme("abc"), "ab");
	// Astral emoji: slice(0,-1) would orphan the high surrogate.
	assert.equal(removeLastGrapheme("ab\u{1F525}"), "ab");
	// ZWJ cluster: multiple code points, one perceived character.
	assert.equal(removeLastGrapheme("x\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"), "x");
	// Flag: two regional indicators, one grapheme.
	assert.equal(removeLastGrapheme("y\u{1F1FA}\u{1F1F8}"), "y");
	// Combining sequence stays whole.
	assert.equal(removeLastGrapheme("cafe\u0301"), "caf");
	assert.equal(removeLastGrapheme(""), "");
});
