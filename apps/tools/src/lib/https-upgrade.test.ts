import { describe, expect, it } from "vitest"
import { httpsUpgradeUrl } from "./https-upgrade"

describe("httpsUpgradeUrl", () => {
	it("moves an insecure HTTP load to the same URL over HTTPS", () => {
		expect(httpsUpgradeUrl("http://testnet.app.unleashed.systems/?token=0xabc#activity", false)).toBe(
			"https://testnet.app.unleashed.systems/?token=0xabc#activity",
		)
	})

	it("leaves a secure context alone, HTTPS or loopback HTTP", () => {
		expect(httpsUpgradeUrl("https://testnet.app.unleashed.systems/", true)).toBeNull()
		expect(httpsUpgradeUrl("http://127.0.0.1:4173/", true)).toBeNull()
	})

	// An HTTPS page framed by an HTTP ancestor is not a secure context; upgrading it would loop.
	it("never upgrades a page already on HTTPS", () => {
		expect(httpsUpgradeUrl("https://testnet.app.unleashed.systems/", false)).toBeNull()
	})
})
