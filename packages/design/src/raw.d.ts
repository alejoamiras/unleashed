declare module "*?raw" {
	const content: string
	export default content
}

interface ImportMeta {
	glob(pattern: string | string[], options?: { query?: string; eager?: boolean; import?: string }): Record<string, unknown>
}
