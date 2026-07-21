import type { HistoryEntry } from "./history-store.ts";

export type MatchHighlightSgr = {
	match: string;
	restore: string;
};

export type EditorCursor = {
	line: number;
	col: number;
};

export type GhostSuggestionInput = {
	entries: readonly HistoryEntry[];
	text: string;
	lines: readonly string[];
	cursor: EditorCursor;
};

export function findGhostSuggestion(input: GhostSuggestionInput): string | undefined {
	if (input.text.length === 0) return undefined;
	if (!isCursorAtTextEnd({ lines: input.lines, cursor: input.cursor })) return undefined;
	const match = input.entries.find(
		(entry) => entry.text !== input.text && entry.text.startsWith(input.text),
	);
	return match?.text.slice(input.text.length);
}

export function isCursorAtTextEnd(input: {
	lines: readonly string[];
	cursor: EditorCursor;
}): boolean {
	const lastLineIndex = Math.max(0, input.lines.length - 1);
	const lastLine = input.lines[lastLineIndex] ?? "";
	return input.cursor.line === lastLineIndex && input.cursor.col === lastLine.length;
}

// Locale-independent grapheme cluster segmenter. A single shared instance is
// reused because grapheme boundaries do not depend on locale. Matching and
// slicing operate on grapheme clusters (not UTF-16 code units) so ANSI SGR
// spans are never injected inside a surrogate pair or combining sequence.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function segmentGraphemes(text: string): string[] {
	return [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
}

/**
 * Embed theme-provided foreground spans where graphemes match the query.
 * Grapheme-cluster iteration (via Intl.Segmenter) keeps multi-codepoint
 * characters such as ZWJ emoji or combining sequences intact when SGR spans
 * are injected between matches. Greedy character-order matching mirrors
 * fuzzyMatch's subsequence semantics. The caller supplies both the match color
 * and the restore color because selected and unselected SelectList rows differ.
 */
export function highlightMatches(label: string, query: string, sgr: MatchHighlightSgr): string {
	if (query.length === 0) return label;
	const labelGraphemes = segmentGraphemes(label);
	const matchPositions = findMatchPositions(labelGraphemes, query);
	if (matchPositions.length === 0) return label;
	return applyMatchHighlights(labelGraphemes, matchPositions, sgr);
}

/** Greedy character-order match: find each query grapheme's position in order. */
function findMatchPositions(labelGraphemes: string[], query: string): number[] {
	const queryGraphemes = segmentGraphemes(query);
	const positions: number[] = [];
	let searchFrom = 0;
	for (const qGrapheme of queryGraphemes) {
		const qLower = qGrapheme.toLowerCase();
		let foundAt = -1;
		for (let index = searchFrom; index < labelGraphemes.length; index += 1) {
			if (labelGraphemes[index].toLowerCase() === qLower) {
				foundAt = index;
				break;
			}
		}
		if (foundAt < 0) return [];
		positions.push(foundAt);
		searchFrom = foundAt + 1;
	}
	return positions;
}

/** Wrap matched grapheme segments with theme SGR and restore the row color. */
function applyMatchHighlights(graphemes: string[], positions: number[], sgr: MatchHighlightSgr): string {
	const matched = new Set(positions);
	let result = "";
	let inMatch = false;
	for (let index = 0; index < graphemes.length; index += 1) {
		const graphemeIsMatch = matched.has(index);
		result += highlightBoundary(graphemeIsMatch, inMatch, sgr);
		inMatch = graphemeIsMatch;
		result += graphemes[index];
	}
	if (inMatch) result += sgr.restore;
	return result;
}

/** Keep span-boundary decisions small so the hot loop stays easy to audit. */
function highlightBoundary(isMatch: boolean, inMatch: boolean, sgr: MatchHighlightSgr): string {
	if (isMatch === inMatch) return "";
	return isMatch ? sgr.match : sgr.restore;
}

