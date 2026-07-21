import assert from "node:assert/strict";
import test from "node:test";

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	matchesKey,
	TUI_KEYBINDINGS,
	type EditorTheme,
} from "@earendil-works/pi-tui";

import { HistoryEditor, type WrappedHistoryEditor } from "../src/history-editor.ts";
import type { HistoryEntry } from "../src/history-store.ts";
import { testTheme } from "./theme-fixture.ts";

const CTRL_E = "\x05";
const CTRL_R = "\x12";
const CTRL_X = "\x18";
const ALT_RIGHT = "\x1b[1;3C";
const ENTER = "\r";
const ESCAPE_SEQ = "\x1b";
const ESCAPE = "\x1b";
const CURSOR_RENDER = "\x1b[7m \x1b[0m";

const theme: EditorTheme = {
	borderColor: (value) => value,
	selectList: {
		selectedPrefix: (value) => value,
		selectedText: (value) => value,
		description: (value) => value,
		scrollInfo: (value) => value,
		noMatch: (value) => value,
	},
};
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

test("wrapper delegates normal input to the previous editor", () => {
	const fixture = createEditorFixture();

	fixture.editor.handleInput("a");

	assert.deepEqual(fixture.inner.handled, ["a"]);
});

test("ghost is absent for empty and exact buffers", () => {
	const emptyFixture = createEditorFixture({ entries: [entry("review the diff")] });
	const exactFixture = createEditorFixture({
		text: "review the diff",
		entries: [entry("review the diff")],
	});

	assert.doesNotMatch(emptyFixture.editor.render(80).join("\n"), /for bugs/);
	assert.doesNotMatch(exactFixture.editor.render(80).join("\n"), /for bugs/);
});

test("ghost appears for newest prefix match when cursor is at end", () => {
	const fixture = createEditorFixture({
		text: "review the",
		entries: [entry("review the diff"), entry("review the docs")],
	});

	assert.match(fixture.editor.render(80).join("\n"), /diff/);
});

test("ghost rendering preserves trailing editor chrome", () => {
	const inner = new BorderInner("review the");
	const editor = createHistoryEditor({
		inner,
		entries: [entry("review the diff")],
	});

	const rendered = editor.render(80).join("\n");

	assert.match(rendered, /diff/);
	assert.match(rendered, /│/);
});

test("history display escapes stored terminal controls in ghost rendering", () => {
	const fixture = createEditorFixture({
		entries: [entry("review \x1b]52;c;secret\x07"), entry("review \x1b[31mred")],
	});

	fixture.inner.text = "review ";
	const ghostRendered = fixture.editor.render(80).join("\n");

	assert.doesNotMatch(ghostRendered, /\x1b\]52/);
});

test("ghost is absent when cursor is not at end", () => {
	const fixture = createEditorFixture({
		text: "review the",
		cursor: { line: 0, col: 3 },
		entries: [entry("review the diff")],
	});

	assert.doesNotMatch(fixture.editor.render(80).join("\n"), /diff/);
});

test("Ctrl+E accepts a visible ghost suffix", () => {
	const fixture = createEditorFixture({
		text: "review the",
		entries: [entry("review the diff")],
	});
	const changes: string[] = [];
	fixture.editor.onChange = (text) => changes.push(text);

	fixture.editor.handleInput(CTRL_E);

	assert.equal(fixture.inner.text, "review the diff");
	assert.deepEqual(fixture.inner.handled, []);
	assert.deepEqual(changes, ["review the diff"]);
});

test("Ctrl+E passes through when no ghost exists", () => {
	const fixture = createEditorFixture({ text: "review the" });

	fixture.editor.handleInput(CTRL_E);

	assert.deepEqual(fixture.inner.handled, [CTRL_E]);
});

test("Alt+Right accepts one visible ghost word", () => {
	const fixture = createEditorFixture({
		text: "review",
		entries: [entry("review the diff")],
	});
	const changes: string[] = [];
	fixture.editor.onChange = (text) => changes.push(text);

	fixture.editor.handleInput(ALT_RIGHT);
	fixture.editor.handleInput(ALT_RIGHT);

	assert.equal(fixture.inner.text, "review the diff");
	assert.deepEqual(fixture.inner.handled, []);
	assert.deepEqual(changes, ["review the", "review the diff"]);
});

test("Alt+Right passes through when no ghost exists", () => {
	const fixture = createEditorFixture({ text: "review" });

	fixture.editor.handleInput(ALT_RIGHT);

	assert.deepEqual(fixture.inner.handled, [ALT_RIGHT]);
});

test("partial ghost accept follows configured cursor-word-right keybinding", () => {
	const customKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.editor.cursorWordRight": "ctrl+e",
	});
	const inner = new FakeInner("review");
	const editor = createHistoryEditor({
		inner,
		entries: [entry("review the diff")],
		keybindingsManager: customKeybindings,
	});

	editor.handleInput(ALT_RIGHT);
	editor.handleInput(CTRL_E);

	assert.equal(inner.text, "review the");
	assert.deepEqual(inner.handled, [ALT_RIGHT]);
});

test("Alt+Right does not accept ghost words across newlines", () => {
	const fixture = createEditorFixture({
		text: "review",
		entries: [entry("review\nnext")],
	});

	fixture.editor.handleInput(ALT_RIGHT);

	assert.equal(fixture.inner.text, "review");
	assert.deepEqual(fixture.inner.handled, [ALT_RIGHT]);
});

test("unsupported ghost mode reports limitation and keeps Ctrl+R usable", () => {
	const notifications: string[] = [];
	const inner = new UnsupportedInner();
	const editor = createHistoryEditor({
		inner,
		entries: [entry("review the diff")],
		onGhostUnavailable: (reason) => notifications.push(reason),
	});

	editor.handleInput(CTRL_E);
	editor.handleInput(CTRL_R);
	editor.handleInput(ENTER);

	assert.match(notifications.join("\n"), /does not expose lines/);
	assert.deepEqual(inner.handled, [CTRL_E]);
	assert.equal(inner.text, "review the diff");
});

test("missing ghost render seam disables ghost and keeps Ctrl+R usable", () => {
	const notifications: string[] = [];
	const inner = new SeamlessInner("review the");
	const editor = createHistoryEditor({
		inner,
		entries: [entry("review the diff")],
		onGhostUnavailable: (reason) => notifications.push(reason),
	});

	assert.doesNotMatch(editor.render(80).join("\n"), /diff/);
	editor.handleInput(CTRL_E);
	editor.handleInput(CTRL_R);
	editor.handleInput(ENTER);

	assert.match(notifications.join("\n"), /no safe ghost render seam/);
	assert.deepEqual(inner.handled, [CTRL_E]);
	assert.equal(inner.text, "review the diff");
});

test("Ctrl+R with empty history shows No history yet message", () => {
	const fixture = createEditorFixture({ entries: [] });

	fixture.editor.handleInput(CTRL_R);
	const rendered = fixture.editor.render(80).join("\n");

	assert.match(rendered, /No history yet/);
});

test("Ctrl+X prefix behavior still reaches the wrapped editor", () => {
	const fixture = createEditorFixture();

	fixture.editor.handleInput(CTRL_X);

	assert.deepEqual(fixture.inner.handled, [CTRL_X]);
});

test("Ctrl+R enters search mode and preserves previous draft", () => {
	const fixture = createEditorFixture({
		text: "draft",
		entries: [entry("review the diff")],
	});
	const changes: string[] = [];
	fixture.editor.onChange = (text) => changes.push(text);

	fixture.editor.handleInput(CTRL_R);
	fixture.editor.handleInput("x");
	fixture.editor.handleInput(ESCAPE);

	assert.equal(fixture.inner.text, "draft");
	assert.equal(fixture.inner.submissions.length, 0);
	assert.deepEqual(changes, ["draft"]);
});

test("reverse search filters history and replaces editor buffer without submitting", () => {
	const fixture = createEditorFixture({
		entries: [entry("review the diff"), entry("write docs")],
	});
	const changes: string[] = [];
	fixture.editor.onChange = (text) => changes.push(text);

	fixture.editor.handleInput(CTRL_R);
	for (const char of "docs") fixture.editor.handleInput(char);
	fixture.editor.handleInput(ENTER);

	assert.equal(fixture.inner.text, "write docs");
	assert.equal(fixture.inner.submissions.length, 0);
	assert.deepEqual(changes, ["write docs"]);
});

test("reverse search selection follows configured up and down keybindings", () => {
	const fixture = createEditorFixture({
		entries: [entry("first"), entry("second"), entry("third")],
	});

	fixture.editor.handleInput(CTRL_R);
	fixture.editor.handleInput("\x1b[B");
	fixture.editor.handleInput("\x1b[B");
	fixture.editor.handleInput("\x1b[A");
	fixture.editor.handleInput(ENTER);

	assert.equal(fixture.inner.text, "second");
});

test("reverse search arrow keys request a render so selection moves redraw", () => {
	const fixture = createEditorFixture({ entries: [entry("first"), entry("second")] });

	fixture.editor.handleInput(CTRL_R);
	const rendersBefore = fixture.renderCount();
	fixture.editor.handleInput("\x1b[B"); // down

	// SelectList.handleInput fires only onSelectionChange for arrows; without
	// an explicit requestRender the live TUI would never redraw the moved marker.
	assert.equal(fixture.renderCount(), rendersBefore + 1);
});

test("enter on no reverse-search match applies the typed query", () => {
	const fixture = createEditorFixture({
		text: "draft",
		entries: [entry("review the diff")],
	});

	fixture.editor.handleInput(CTRL_R);
	for (const char of "zzz") fixture.editor.handleInput(char);
	fixture.editor.handleInput(ENTER);

	// openSearch seeds the query with the draft, so typing "zzz" yields query
	// "draftzzz" (visible in the editor via setText). Enter keeps that visible
	// query instead of reverting to the pre-search draft; cancel restores draft.
	assert.equal(fixture.inner.text, "draftzzz");
});

test("ghost rendering works against the real CustomEditor seam", () => {
	const tui = createTui();
	const inner = new CustomEditor(tui as never, theme, keybindings as never);
	inner.setText("review the");
	const editor = createHistoryEditor({
		inner,
		entries: [entry("review the diff")],
		tui,
	});

	const rendered = editor.render(80).join("\n");

	// First ghost grapheme (the space) renders inside the cursor cell as
	// dim + reverse video; the remainder ("diff") stays dim. Use includes with
	// a shared ESC string instead of a regex literal so static analyzers do not
	// flag raw control bytes in the pattern.
	assert.ok(rendered.includes(`${ESCAPE_SEQ}[2;7m ${ESCAPE_SEQ}[0m${ESCAPE_SEQ}[2mdiff${ESCAPE_SEQ}[0m`));
});

test("ghost first char sits in the cursor cell, not one column right", () => {
	const fixture = createEditorFixture({
		text: "review the",
		entries: [entry("review the diff")],
	});

	const rendered = fixture.editor.render(80).join("\n");

	// Cursor block (reverse-video space) must be gone; its cell now holds the
	// first ghost char. Old buggy form kept the block and appended the ghost,
	// producing a double space and a +1 column shift.
	assert.ok(!rendered.includes(`review the${ESCAPE_SEQ}[7m ${ESCAPE_SEQ}[0m${ESCAPE_SEQ}[2m diff`));
	assert.ok(rendered.includes(`review the${ESCAPE_SEQ}[2;7m ${ESCAPE_SEQ}[0m${ESCAPE_SEQ}[2mdiff${ESCAPE_SEQ}[0m`));
});

test("ghost keeps a multi-codepoint grapheme whole inside the cursor cell", () => {
	// A ZWJ emoji is multiple code points perceived as one character. Splitting
	// the ghost by code points would insert an ANSI reset mid-cluster and corrupt
	// it; grapheme segmentation must keep it intact inside the cursor cell.
	const emoji = "\u{1F469}\u200D\u{1F4BB}";
	const fixture = createEditorFixture({
		text: "review the",
		entries: [entry(`review the${emoji} done`)],
	});

	const rendered = fixture.editor.render(80).join("\n");

	assert.ok(
		rendered.includes(`${ESCAPE_SEQ}[2;7m${emoji}${ESCAPE_SEQ}[0m`),
		"expected the ZWJ emoji whole inside the cursor cell",
	);
});

type TestTui = {
	terminal: { rows: number };
	requestRender(): void;
};

type EditorFixture = {
	editor: HistoryEditor;
	inner: FakeInner;
	renderCount: () => number;
};

function createEditorFixture(options: {
	text?: string;
	cursor?: { line: number; col: number };
	entries?: HistoryEntry[];
} = {}): EditorFixture {
	const inner = new FakeInner(options.text ?? "", options.cursor);
	const tui = createTui();
	const editor = createHistoryEditor({
		inner,
		entries: options.entries ?? [],
		tui,
	});
	return { editor, inner, renderCount: () => tui.renders };
}

function createTui(): TestTui & { readonly renders: number } {
	let renders = 0;
	return {
		terminal: { rows: 24 },
		get renders() {
			return renders;
		},
		requestRender() {
			renders += 1;
		},
	};
}

function createHistoryEditor(input: {
	inner: WrappedHistoryEditor;
	entries: HistoryEntry[];
	tui?: TestTui;
	keybindingsManager?: KeybindingsManager;
	onGhostUnavailable?: (reason: string) => void;
}): HistoryEditor {
	return new HistoryEditor(
		(input.tui ?? { terminal: { rows: 24 }, requestRender: () => {} }) as never,
		theme,
		(input.keybindingsManager ?? keybindings) as never,
		input.inner,
		{
			getEntries: () => input.entries,
			getSearchMatchColorSgr: () => testTheme.getFgAnsi("mdCode"),
			getSearchSelectedColorSgr: () => testTheme.getFgAnsi("accent"),
			onGhostUnavailable: input.onGhostUnavailable,
		},
	);
}

class FakeInner implements WrappedHistoryEditor {
	actionHandlers = new Map();
	handled: string[] = [];
	submissions: string[] = [];
	focused = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	disableSubmit = false;
	borderColor?: (text: string) => string;

	constructor(
		public text: string,
		private cursorOverride?: { line: number; col: number },
	) {}

	render(width: number): string[] {
		const line = `${this.text}${CURSOR_RENDER}`;
		return [line.padEnd(width, " ")];
	}

	handleInput(data: string): void {
		this.handled.push(data);
		if (matchesKey(data, "enter") && !this.disableSubmit) {
			this.submissions.push(this.text);
			this.onSubmit?.(this.text);
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.text += data;
			this.onChange?.(this.text);
		}
	}

	invalidate(): void {}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.onChange?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.text += text;
		this.onChange?.(this.text);
	}

	getExpandedText(): string {
		return this.text;
	}

	getLines(): string[] {
		return this.text.split("\n");
	}

	getCursor(): { line: number; col: number } {
		if (this.cursorOverride) return this.cursorOverride;
		const lines = this.getLines();
		const line = lines.length - 1;
		return { line, col: lines[line]?.length ?? 0 };
	}
}

class BorderInner extends FakeInner {
	render(): string[] {
		return [`${this.text}${CURSOR_RENDER}   │`];
	}
}

class SeamlessInner extends FakeInner {
	render(width: number): string[] {
		return [this.text.padEnd(width, " ")];
	}
}

class UnsupportedInner implements WrappedHistoryEditor {
	handled: string[] = [];
	text = "";
	render(): string[] {
		return [this.text];
	}
	handleInput(data: string): void {
		this.handled.push(data);
	}
	invalidate(): void {}
	getText(): string {
		return this.text;
	}
	setText(text: string): void {
		this.text = text;
	}
}

function entry(text: string): HistoryEntry {
	return {
		text,
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		useCount: 1,
	};
}
