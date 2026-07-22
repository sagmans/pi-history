import {
	type AppKeybinding,
	CustomEditor,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	decodeKittyPrintable,
	type EditorComponent,
	type EditorTheme,
	fuzzyFilter,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type { GhostDegradationReason } from "./diagnostics.ts";
import type { HistoryEntry } from "./history-store.ts";
import {
	type EditorCursor,
	findGhostSuggestion,
	highlightMatches,
	removeLastGrapheme,
} from "./search.ts";

const DEFAULT_SEARCH_LIMIT = 7;
const CURSOR_AT_END_RENDER = "\x1b[7m \x1b[0m";
const ANSI_DIM = "\x1b[2m";
// Dim + reverse video: renders the first ghost grapheme inside the cursor
// block so the suggestion starts at the cursor cell, not one column after it.
const ANSI_DIM_REVERSE = "\x1b[2;7m";
const ANSI_RESET = "\x1b[0m";
const NEWLINE_MARKER = "↵";
const CONTROL_DISPLAY = "�";
const C0_C1_CONTROL_SEQUENCE = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI_DEFAULT_FOREGROUND = "\x1b[39m";
const NEXT_GHOST_WORD_PATTERN = /^[^\S\n]*\S+/u;

// Locale-independent grapheme cluster segmenter. A single shared instance is
// reused because grapheme boundaries do not depend on locale.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

// Search input owned by SelectList: navigation, confirm, and cancel. Kept as a
// readonly list so handleSearchInput delegates with one .some() pass instead of
// one keybindingsManager.matches branch per action (keeps cyclomatic complexity
// in check) and can request a render once for all delegated movement.
type SearchKeybinding = Parameters<KeybindingsManager["matches"]>[1];
const DELEGATED_SEARCH_ACTIONS: readonly SearchKeybinding[] = [
	"tui.select.cancel",
	"tui.select.confirm",
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
];

export type HistoryEditorOptions = {
	getEntries: () => readonly HistoryEntry[];
	getSearchMatchColorSgr: () => string;
	getSearchSelectedColorSgr: () => string;
	onGhostUnavailable?: (reason: GhostDegradationReason) => void;
	searchLimit?: number;
};

export type WrappedHistoryEditor = EditorComponent & {
	actionHandlers?: Map<AppKeybinding, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	disableSubmit?: boolean;
	focused?: boolean;
	getLines?(): string[];
	getCursor?(): EditorCursor;
};

type GhostCapableEditor = WrappedHistoryEditor & {
	getLines(): string[];
	getCursor(): EditorCursor;
	insertTextAtCursor(text: string): void;
};

type SearchState = {
	draft: string;
	query: string;
};

export class HistoryEditor extends CustomEditor {
	private searchState: SearchState | undefined;
	private selectList: SelectList | undefined;
	private ghostDisabledReason: GhostDegradationReason | undefined;
	private ghostUnavailableNotified = false;
	private readonly editorTheme: EditorTheme;

	constructor(
		private readonly appTui: TUI,
		theme: EditorTheme,
		private readonly keybindingsManager: KeybindingsManager,
		private readonly inner: WrappedHistoryEditor,
		private readonly options: HistoryEditorOptions,
	) {
		super(appTui, theme, keybindingsManager);
		this.editorTheme = theme;
		const missingReason = missingGhostMethodReason(inner);
		if (missingReason) this.disableGhost(missingReason);
	}

	private syncAppHandlers(): void {
		if (this.inner.actionHandlers instanceof Map) {
			this.inner.actionHandlers.clear();
			for (const [action, handler] of this.actionHandlers) {
				this.inner.actionHandlers.set(action, handler);
			}
		}
		this.inner.onSubmit = this.onSubmit;
		this.inner.onChange = this.onChange;
		this.inner.disableSubmit = this.disableSubmit;
		this.inner.onEscape = this.onEscape;
		this.inner.onCtrlD = this.onCtrlD;
		this.inner.onPasteImage = this.onPasteImage;
		this.inner.onExtensionShortcut = this.onExtensionShortcut;
		this.inner.focused = this.focused;
	}

	private openSearch(): void {
		const draft = this.inner.getText();
		this.searchState = {
			draft,
			query: draft,
		};
		this.selectList = this.buildSelectList(draft);
		this.appTui.requestRender();
	}

	private closeSearch(): void {
		this.searchState = undefined;
		this.selectList = undefined;
		this.appTui.requestRender();
	}

	private cancelSearch(): void {
		const state = this.searchState;
		if (!state) return;
		this.finishSearch(state.draft);
	}

	private confirmSearch(): void {
		const state = this.searchState;
		if (!state) return;
		const selected = this.selectList?.getSelectedItem();
		// Placeholder rows (No match / No history yet) carry an empty value; fall
		// back to the current query so Enter keeps what the user typed and sees in
		// the editor instead of reverting to the pre-search draft. Cancel (escape)
		// is the only path that restores the draft.
		this.finishSearch(selected?.value || state.query);
	}

	// Keep both search exits identical so handler sync cannot drift.
	private finishSearch(text: string): void {
		this.syncAppHandlers();
		this.inner.setText(text);
		this.closeSearch();
	}

	private buildSelectList(query: string): SelectList {
		const entries = [...this.options.getEntries()];
		const limit = this.options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
		const filtered =
			query.length > 0
				? fuzzyFilter(entries, query, (entry) => entry.text).slice(0, limit)
				: entries.slice(0, limit);
		const items: SelectItem[] =
			filtered.length > 0
				? filtered.map((entry) => ({
						value: entry.text,
						label: safeDisplayText(singleLine(entry.text)),
					}))
				: [
						{
							value: "",
							label: entries.length > 0 ? "No match" : "No history yet",
						},
					];
		const selectList = new SelectList(
			items,
			limit,
			this.editorTheme.selectList,
			this.searchListLayout(query),
		);
		selectList.setSelectedIndex(0);
		// Wire confirm/cancel once at construction so openSearch and
		// updateSearchQuery cannot drift apart on handler wiring.
		selectList.onSelect = () => this.confirmSearch();
		selectList.onCancel = () => this.cancelSearch();
		return selectList;
	}

	private searchListLayout(query: string): SelectListLayoutOptions {
		return {
			truncatePrimary: ({ text, maxWidth, isSelected }) => {
				const truncated = truncateToWidth(text, maxWidth, "");
				return highlightMatches(truncated, query, {
					match: this.options.getSearchMatchColorSgr(),
					restore: isSelected ? this.options.getSearchSelectedColorSgr() : ANSI_DEFAULT_FOREGROUND,
				});
			},
		};
	}

	private updateSearchQuery(query: string): void {
		const state = this.searchState;
		if (!state) return;
		state.query = query;
		this.inner.setText(query);
		this.selectList = this.buildSelectList(query);
		this.appTui.requestRender();
	}

	private handleSearchInput(data: string): void {
		const state = this.searchState;
		if (!state) return;

		// Navigation, confirm, and cancel are delegated to SelectList. SelectList
		// has no TUI handle and cannot request a render itself; confirm/cancel
		// still reach requestRender via onSelect/onCancel, but arrow/page movement
		// only fires onSelectionChange — request explicitly or the moved marker
		// never redraws.
		if (DELEGATED_SEARCH_ACTIONS.some((action) => this.keybindingsManager.matches(data, action))) {
			this.selectList?.handleInput(data);
			this.appTui.requestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			this.updateSearchQuery(removeLastGrapheme(state.query));
			return;
		}

		const printable = decodePrintable(data);
		if (printable !== undefined) this.updateSearchQuery(`${state.query}${printable}`);
	}

	private currentGhostSuffix(): string | undefined {
		if (this.ghostDisabledReason) return undefined;
		if (!hasGhostMethods(this.inner)) return undefined;
		return findGhostSuggestion({
			entries: this.options.getEntries(),
			text: this.inner.getText(),
			lines: this.inner.getLines(),
			cursor: this.inner.getCursor(),
		});
	}

	private acceptGhost(): boolean {
		return this.acceptGhostPart((suffix) => suffix);
	}

	private acceptGhostWord(): boolean {
		return this.acceptGhostPart(nextGhostWord);
	}

	private acceptGhostPart(selectPart: (suffix: string) => string | undefined): boolean {
		if (!hasGhostMethods(this.inner)) return false;
		const suffix = this.currentGhostSuffix();
		if (!suffix) return false;
		const part = selectPart(suffix);
		if (!part) return false;
		this.syncAppHandlers();
		this.inner.insertTextAtCursor(part);
		this.appTui.requestRender();
		return true;
	}

	private handleGhostInput(data: string): boolean {
		if (this.keybindingsManager.matches(data, "tui.editor.cursorWordRight")) {
			return this.acceptGhostWord();
		}
		if (matchesKey(data, "ctrl+e")) return this.acceptGhost();
		return false;
	}

	private renderGhost(lines: string[], width: number, suffix: string): string[] {
		const renderedSuffix = safeDisplayText(firstGhostLine(suffix));
		if (!renderedSuffix) return lines;
		const target = this.findGhostTarget(lines);
		if (!target) return lines;

		// Ghost text owns the cursor cell: slice the typed text up to the cursor
		// block and drop the block so its first grapheme can render inside it
		// (see renderGhostLine). Without this the suggestion lands one column
		// right of the cursor.
		const beforeGhost = target.line.slice(0, target.cursorStart);
		const afterCursor = target.line.slice(target.cursorStart + CURSOR_AT_END_RENDER.length);
		const remainingWidth = Math.max(0, width - visibleWidth(beforeGhost));
		if (remainingWidth === 0) return lines;

		const visibleGhost = truncateToWidth(renderedSuffix, remainingWidth, "");
		if (!visibleGhost) return lines;

		const nextLines = [...lines];
		nextLines[target.index] = HistoryEditor.renderGhostLine({
			beforeGhost,
			visibleGhost,
			afterCursor,
		});
		return nextLines;
	}

	private static renderGhostLine(input: {
		beforeGhost: string;
		visibleGhost: string;
		afterCursor: string;
	}): string {
		const [cursorGhost = "", ...rest] = HistoryEditor.splitGhostGraphemes(input.visibleGhost);
		const restGhost = rest.join("");
		const leadingSpaces = HistoryEditor.leadingSpacesOf(input.afterCursor);
		const nonSpaces = input.afterCursor.slice(leadingSpaces.length);
		// The cursor block used to occupy one cell; removing it frees that cell
		// for the first grapheme, so only the remaining ghost width eats into
		// trailing padding. Without the +1, trailing chrome shifts one column
		// left.
		const remainingSpaces = " ".repeat(
			Math.max(0, visibleWidth(leadingSpaces) + 1 - visibleWidth(input.visibleGhost)),
		);
		return `${input.beforeGhost}${ANSI_DIM_REVERSE}${cursorGhost}${ANSI_RESET}${ANSI_DIM}${restGhost}${ANSI_RESET}${remainingSpaces}${nonSpaces}`;
	}

	// Split on grapheme clusters (not code points) so multi-codepoint characters
	// such as ZWJ emoji or combining sequences stay intact. Kept as static
	// methods because module-scope const arrows confuse Codacy's length meter.
	private static splitGhostGraphemes(text: string): string[] {
		return [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
	}

	private static leadingSpacesOf(text: string): string {
		return text.match(/^ */)?.[0] ?? "";
	}

	private findGhostTarget(
		lines: string[],
	): { index: number; line: string; cursorStart: number } | undefined {
		const index = lines.findIndex((line) => line.includes(CURSOR_AT_END_RENDER));
		if (index < 0) {
			this.disableGhost("missing_render_seam");
			return undefined;
		}
		const line = lines[index];
		return line
			? {
					index,
					line,
					cursorStart: line.indexOf(CURSOR_AT_END_RENDER),
				}
			: undefined;
	}

	private disableGhost(reason: GhostDegradationReason): void {
		this.ghostDisabledReason = reason;
		if (this.ghostUnavailableNotified) return;
		this.ghostUnavailableNotified = true;
		this.options.onGhostUnavailable?.(reason);
	}

	render(width: number): string[] {
		this.inner.borderColor = this.borderColor;
		this.inner.focused = this.focused;
		let renderedLines = this.inner.render(width);
		const ghost = this.currentGhostSuffix();
		if (ghost) renderedLines = this.renderGhost(renderedLines, width, ghost);
		if (this.selectList) return [...this.selectList.render(width), ...renderedLines];
		return renderedLines;
	}

	handleInput(data: string): void {
		if (this.searchState) {
			this.handleSearchInput(data);
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.openSearch();
			return;
		}
		if (this.handleGhostInput(data)) return;
		this.syncAppHandlers();
		this.inner.handleInput(data);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	getText(): string {
		return this.inner.getText();
	}

	setText(text: string): void {
		this.searchState = undefined;
		this.syncAppHandlers();
		this.inner.setText(text);
	}

	addToHistory(text: string): void {
		this.inner.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.syncAppHandlers();
		this.inner.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.inner.getText();
	}

	getLines(): string[] {
		return this.inner.getLines?.() ?? this.inner.getText().split("\n");
	}

	getCursor(): EditorCursor {
		const cursor = this.inner.getCursor?.();
		if (cursor) return cursor;
		const lines = this.getLines();
		const lastLineIndex = Math.max(0, lines.length - 1);
		return {
			line: lastLineIndex,
			col: lines[lastLineIndex]?.length ?? 0,
		};
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.inner.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.inner.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible?.(maxVisible);
	}
}

function missingGhostMethodReason(
	editor: WrappedHistoryEditor,
): GhostDegradationReason | undefined {
	if (typeof editor.getLines !== "function") return "missing_lines";
	if (typeof editor.getCursor !== "function") return "missing_cursor";
	if (typeof editor.insertTextAtCursor !== "function") return "missing_insertion";
	return undefined;
}

function hasGhostMethods(editor: WrappedHistoryEditor): editor is GhostCapableEditor {
	return missingGhostMethodReason(editor) === undefined;
}

function decodePrintable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.length !== 1) return undefined;
	return data.charCodeAt(0) >= 32 ? data : undefined;
}

function nextGhostWord(text: string): string | undefined {
	// Keep leading whitespace with the word so partial accept preserves spacing.
	return text.match(NEXT_GHOST_WORD_PATTERN)?.[0];
}

function firstGhostLine(text: string): string {
	const newlineIndex = text.indexOf("\n");
	if (newlineIndex < 0) return text;
	const firstLine = text.slice(0, newlineIndex);
	return firstLine.length > 0 ? `${firstLine}${NEWLINE_MARKER}` : NEWLINE_MARKER;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function safeDisplayText(text: string): string {
	return text.replace(C0_C1_CONTROL_SEQUENCE, CONTROL_DISPLAY);
}
