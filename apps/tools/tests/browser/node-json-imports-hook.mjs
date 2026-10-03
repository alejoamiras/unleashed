/** Resolve hook: every `.json` module resolves as if imported `with { type: "json" }`. */
export async function resolve(specifier, context, next) {
	const resolved = await next(specifier, context)
	if (!resolved.url?.endsWith(".json")) return resolved
	return { ...resolved, importAttributes: { ...resolved.importAttributes, type: "json" } }
}
