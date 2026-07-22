// Canonical write-block reason shared by storage and diagnostics so the two
// contracts cannot drift apart. Storage and diagnostics re-export this union
// under their own public names to preserve their module APIs.
export type BlockReason = "corrupt_history" | "unsupported_schema" | "project_root_mismatch";
