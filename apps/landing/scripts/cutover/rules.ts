/** Which zone redirect rules belong to the cutover. Pure, so the matching is tested offline. */

export const LANDING_HOSTS = ["unleashed.systems", "www.unleashed.systems"] as const
export const APP_HOST = "testnet.app.unleashed.systems"

export interface RedirectRule {
	id: string
	action: string
	expression: string
	enabled: boolean
	description?: string
	ref?: string
	version?: string
	last_updated?: string
	action_parameters?: {
		from_value?: {
			target_url?: { value?: string; expression?: string }
			status_code?: number
			preserve_query_string?: boolean
		}
	}
}

export function targetOf(rule: RedirectRule): string {
	const target = rule.action_parameters?.from_value?.target_url
	return target?.value ?? target?.expression ?? ""
}

/** True when the expression names `host` exactly: quoted, or as a URL's host. */
export function namesHost(expression: string, host: string): boolean {
	return new RegExp(`["/]${host.replaceAll(".", "\\.")}["/]`).test(expression)
}

/** The rules that send a landing host to the app. Anything else in the phase is left alone. */
export function landingRedirects(rules: readonly RedirectRule[]): RedirectRule[] {
	return rules.filter(
		(rule) =>
			rule.action === "redirect" &&
			new RegExp(`//${APP_HOST.replaceAll(".", "\\.")}(/|$)`).test(targetOf(rule)) &&
			LANDING_HOSTS.some((host) => namesHost(rule.expression, host)),
	)
}
