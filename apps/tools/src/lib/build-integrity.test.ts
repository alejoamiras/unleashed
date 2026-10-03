import { describe, expect, it } from "vitest"
import { checkBuildIntegrity } from "./build-integrity"
import { MAINNET_TARGET, TESTNET_TARGET } from "./network-targets"

const TESTNET = {
	key: "testnet" as const,
	l1ChainId: 11155111,
	walletChainId: 2904119610,
	host: "testnet.app.unleashed.systems",
	workersDevHost: "unleashed-testnet.alejo-amiras.workers.dev",
}
const MAINNET = {
	key: "mainnet" as const,
	l1ChainId: 1,
	walletChainId: 4248422646,
	host: "app.unleashed.systems",
	workersDevHost: "unleashed-mainnet.alejo-amiras.workers.dev",
}

describe("checkBuildIntegrity — fail-closed target/manifest/hostname", () => {
	it("passes when target, manifest, and host all agree (prod)", () => {
		const err = checkBuildIntegrity(
			TESTNET,
			{ l1ChainId: 11155111, walletChainId: 2904119610 },
			{ hostname: TESTNET.host, isProd: true },
		)
		expect(err).toBeNull()
	})

	// The exact placeholder-mainnet failure: a testnet-identity manifest bundled into a mainnet build.
	it("FAILS when the manifest chain != the build target (the placeholder-mainnet case)", () => {
		const err = checkBuildIntegrity(
			MAINNET,
			{ l1ChainId: 11155111, walletChainId: 2904119610 },
			{ hostname: MAINNET.host, isProd: true },
		)
		expect(err).toMatch(/manifest chain .* != mainnet target/)
	})

	it("FAILS when the manifest omits its chain identity", () => {
		const err = checkBuildIntegrity(TESTNET, {}, { hostname: TESTNET.host, isProd: true })
		expect(err).toMatch(/missing l1ChainId\/walletChainId/)
	})

	// Layer 5: a coherent testnet build served at the mainnet host passes the chain layers but must fail.
	it("FAILS in prod when the hostname != the target host (mis-hosted build)", () => {
		const err = checkBuildIntegrity(
			TESTNET,
			{ l1ChainId: 11155111, walletChainId: 2904119610 },
			{ hostname: MAINNET.host, isProd: true },
		)
		expect(err).toMatch(/mis-hosted build/)
	})

	// A preview is a PROD build at a host of the Worker's own: `<label>-<workers.dev host>`.
	it("runs a testnet build at any preview host of its Worker, and a mainnet build at none", () => {
		const manifest = { l1ChainId: 11155111, walletChainId: 2904119610 }
		const previews = { ...TESTNET, acceptsPreviewHosts: true }
		const at = (label: string) => `${label}${TESTNET.workersDevHost}`
		for (const hostname of [at("p-0a1b2c3d-feat-x-"), at("4182ff98-")]) {
			expect(checkBuildIntegrity(previews, manifest, { hostname, isProd: true }), hostname).toBeNull()
			expect(checkBuildIntegrity(TESTNET, manifest, { hostname, isProd: true }), hostname).toMatch(/mis-hosted build/)
		}
		// One label in front, nothing else: not a subdomain, not a bare dash, not under the custom domain.
		for (const hostname of [at("evil."), at("a.b-"), at("-"), at("x"), `p-0a1b2c3d-${TESTNET.host}`, `${at("x-")}.evil.example`]) {
			expect(checkBuildIntegrity(previews, manifest, { hostname, isProd: true }), hostname).toMatch(/mis-hosted build/)
		}
	})

	it("SKIPS the hostname check outside prod (localhost dev / e2e)", () => {
		const err = checkBuildIntegrity(
			TESTNET,
			{ l1ChainId: 11155111, walletChainId: 2904119610 },
			{ hostname: "localhost", isProd: false },
		)
		expect(err).toBeNull()
	})
})

describe("production hosts of the exported targets", () => {
	const hosts = {
		testnet: ["testnet.app.unleashed.systems", "unleashed-testnet.alejo-amiras.workers.dev"],
		mainnet: ["app.unleashed.systems", "unleashed-mainnet.alejo-amiras.workers.dev"],
	}
	const check = (target: typeof TESTNET_TARGET, hostname: string) =>
		checkBuildIntegrity(target, { l1ChainId: target.l1ChainId, walletChainId: target.walletChainId }, { hostname, isProd: true })

	// verify-build-target never reads the hosts, so nothing else would catch an edit to these pins.
	it("pins the custom domain and the workers.dev host of each target, and previews to testnet", () => {
		expect([TESTNET_TARGET.host, TESTNET_TARGET.workersDevHost]).toEqual(hosts.testnet)
		expect([MAINNET_TARGET.host, MAINNET_TARGET.workersDevHost]).toEqual(hosts.mainnet)
		expect(check(TESTNET_TARGET, `4182ff98-${hosts.testnet[1]}`)).toBeNull()
		expect(check(MAINNET_TARGET, `4182ff98-${hosts.mainnet[1]}`)).toMatch(/mis-hosted build/)
	})

	it("each target runs at its own two hosts and nowhere else on the domain", () => {
		const elsewhere = ["unleashed.systems", "evil.app.unleashed.systems", "app.unleashed.systems.evil.example", ""]
		for (const [target, own, other] of [
			[TESTNET_TARGET, hosts.testnet, hosts.mainnet],
			[MAINNET_TARGET, hosts.mainnet, hosts.testnet],
		] as const) {
			for (const hostname of own) expect(check(target, hostname), hostname).toBeNull()
			for (const hostname of [...other, ...elsewhere]) expect(check(target, hostname), hostname).toMatch(/mis-hosted build/)
		}
	})
})
