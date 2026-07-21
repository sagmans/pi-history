import { Theme } from "@earendil-works/pi-coding-agent";

type ThemeConstructorArgs = ConstructorParameters<typeof Theme>;
type ThemeForegroundColors = ThemeConstructorArgs[0];
type ThemeBackgroundColors = ThemeConstructorArgs[1];

const foregroundColors: ThemeForegroundColors = {
	accent: "#123456",
	border: "#111111",
	borderAccent: "#222222",
	borderMuted: "#333333",
	success: "#00aa00",
	error: "#aa0000",
	warning: "#aaaa00",
	muted: "#777777",
	dim: "#555555",
	text: "#eeeeee",
	thinkingText: "#777777",
	userMessageText: "#eeeeee",
	customMessageText: "#eeeeee",
	customMessageLabel: "#abcdef",
	toolTitle: "#eeeeee",
	toolOutput: "#777777",
	mdHeading: "#bbbb00",
	mdLink: "#0066cc",
	mdLinkUrl: "#777777",
	mdCode: "#FB9E24",
	mdCodeBlock: "#00aa00",
	mdCodeBlockBorder: "#777777",
	mdQuote: "#777777",
	mdQuoteBorder: "#777777",
	mdHr: "#777777",
	mdListBullet: "#123456",
	toolDiffAdded: "#00aa00",
	toolDiffRemoved: "#aa0000",
	toolDiffContext: "#777777",
	syntaxComment: "#777777",
	syntaxKeyword: "#0066cc",
	syntaxFunction: "#bbbb00",
	syntaxVariable: "#abcdef",
	syntaxString: "#00aa00",
	syntaxNumber: "#aa00aa",
	syntaxType: "#00aaaa",
	syntaxOperator: "#eeeeee",
	syntaxPunctuation: "#eeeeee",
	thinkingOff: "#333333",
	thinkingMinimal: "#555555",
	thinkingLow: "#0066cc",
	thinkingMedium: "#00aaaa",
	thinkingHigh: "#aa00aa",
	thinkingXhigh: "#ff00ff",
	thinkingMax: "#ff00ff",
	bashMode: "#00aa00",
};

const backgroundColors: ThemeBackgroundColors = {
	selectedBg: "#202020",
	userMessageBg: "#202020",
	customMessageBg: "#202020",
	toolPendingBg: "#202020",
	toolSuccessBg: "#203020",
	toolErrorBg: "#302020",
};

export const testTheme = new Theme(foregroundColors, backgroundColors, "truecolor", {
	name: "pi-history-test",
});

export const testHighlightSgr = {
	match: testTheme.getFgAnsi("mdCode"),
	restore: testTheme.getFgAnsi("accent"),
};
