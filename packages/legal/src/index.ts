import { PRIVACY } from "./privacy.ts"
import { TERMS } from "./terms.ts"

export * from "./document.ts"
export { LEGAL_URLS } from "./site.ts"
export { PRIVACY, TERMS }

export const LEGAL_DOCUMENTS = [TERMS, PRIVACY] as const
