/**
 * The status tones the design package names. A component accepts only the tones it styles, as an
 * `Extract<SeverityTone, …>`, and keeps its own colours for them.
 */
export type SeverityTone = "info" | "warning" | "error" | "done" | "ok"
