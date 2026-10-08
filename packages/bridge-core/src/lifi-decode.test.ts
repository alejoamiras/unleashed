import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	type Abi,
	type AbiParameter,
	type Address,
	concat,
	decodeAbiParameters,
	decodeFunctionData,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	type Hex,
	pad,
	slice,
	toHex,
	zeroHash,
} from "viem"
import { describe, expect, it } from "vitest"
import { ACROSS_V4_FACET_ABI, buildAcrossV4Deposit, START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR } from "./across-v4"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import { LIFI_RECEIVER_MESSAGE_PARAMS, type LifiSwapData, SWAP_TOKENS_MULTIPLE_V3_ABI, SWAP_TOKENS_SINGLE_V3_ABI } from "./lifi-abi"
import { lifiBook } from "./lifi-addresses"
import {
	acrossDepositFor,
	FEE_FORWARDER_ABI,
	type FieldPolicyKind,
	type RouteExpectation,
	type RouteTx,
	type RouteVerdict,
	routeFieldPolicy,
	verifyComposeMessage,
	verifyRoute,
} from "./lifi-decode"
import { decodeLzOptions, type LzExecutorOption, STARGATE_FACET_V2_ABI, stargateFeeCeiling } from "./stargate"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const readFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))
const rail = readFixture("testnet-rail.json")
const mainnet = readFixture("mainnet.json")
const raw = readFixture("mainnet.raw.json")
const compose = readFixture("mainnet.compose.json")

interface RouteCase {
	name: string
	tx: RouteTx
	expected: RouteExpectation
}

function routerCallIn(message: Hex): Hex {
	return decodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, message)[1][0].callData
}

function testnetExpectation(lifiTxId: Hex, routerCall: Hex): RouteExpectation {
	return {
		srcChainId: rail.source.chainId,
		user: rail.inputs.user,
		srcToken: rail.source.usdc,
		srcAmount: BigInt(rail.inputs.inputAmount),
		lifiTxId,
		l1ChainId: rail.destination.chainId,
		router: rail.router.router,
		destToken: rail.destination.usdc,
		feeAsset: rail.router.feeAsset,
		routerCall,
		fuel: { provider: "testnetSwapper" },
		rail: {
			kind: "acrossV4",
			outputAmount: BigInt(rail.inputs.outputAmount),
			quoteTimestamp: rail.inputs.quoteTimestamp,
			fillDeadline: rail.inputs.fillDeadline,
		},
	}
}

function testnetTx(data: Hex): RouteTx {
	const amount = BigInt(rail.inputs.inputAmount)
	return {
		chainId: rail.source.chainId,
		from: rail.inputs.user,
		to: rail.source.diamond,
		value: 0n,
		data,
		approval: { token: rail.source.usdc, spender: rail.source.diamond, amount },
	}
}

/** A recorded router variant: our builder's bytes, sent through LI.FI's Base Sepolia Diamond and filled on Sepolia. */
function testnetCase(variant: string): RouteCase {
	const v = rail.router.variants[variant]
	return { name: `testnet ${variant}`, tx: testnetTx(v.calldata), expected: testnetExpectation(v.transactionId, routerCallIn(v.message)) }
}

/** A plain token send (no fuel slice) through the same builder, so the empty `swapData` shape is covered too. */
function testnetPlainCase(): RouteCase {
	const intent = {
		...rail.router.variants.public.intent,
		fuelSlice: 0n,
		fuelRecipient: zeroHash,
		fuelSecretHash: zeroHash,
		minFuelOutput: 0n,
	}
	const out = BigInt(rail.inputs.outputAmount)
	const routerCall = encodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, functionName: "bridgeFromCaller", args: [intent, "0x", out, out] })
	const expected = { ...testnetExpectation(rail.router.variants.public.transactionId, routerCall), fuel: undefined }
	return { name: "testnet plain", tx: testnetTx(buildAcrossV4Deposit(acrossDepositFor(expected)).data), expected }
}

/** A recorded li.quest contract-call quote into Ethereum, verbatim. */
function mainnetCase(name: "baseUsdc" | "arbitrumWeth" = "baseUsdc", destToken: Address = mainnet.ethereum.usdc): RouteCase {
	const q = raw[name]
	const lzFee = q.estimate.feeCosts.find((f: { name: string }) => f.name === "LayerZero native fee").amount
	const srcAmount = BigInt(q.action.fromAmount)
	const srcToken: Address = q.action.fromToken.address
	const swap = name === "baseUsdc" ? mainnet.sameChain.deadlineFree : mainnet.sameChain.weth
	const r = q.transactionRequest
	return {
		name: `mainnet ${name}`,
		tx: {
			chainId: r.chainId,
			from: r.from,
			to: r.to,
			value: BigInt(r.value),
			data: r.data,
			approval: { token: srcToken, spender: q.estimate.approvalAddress, amount: srcAmount },
		},
		expected: {
			srcChainId: q.action.fromChainId,
			user: q.action.fromAddress,
			srcToken,
			srcAmount,
			lifiTxId: q.transactionId,
			l1ChainId: 1,
			router: mainnet.router,
			destToken,
			feeAsset: mainnet.ethereum.aztec,
			routerCall: mainnet.crossChain[name].routerCalldata,
			fuel: { provider: "lifi", tool: swap.tool },
			rail: { kind: "stargateV2", maxNativeFee: stargateFeeCeiling(BigInt(lzFee)) },
		},
	}
}

const ROUTES: RouteCase[] = [...["public", "private", "fuelOnly", "floorUnmet"].map(testnetCase), testnetPlainCase(), mainnetCase()]

function refusalOf(v: RouteVerdict | ReturnType<typeof verifyComposeMessage>): { field: string; reason: string } | undefined {
	return v.ok ? undefined : { field: v.field, reason: v.reason }
}

describe("lifi-decode: recorded routes", () => {
	it.each(ROUTES.map((c) => [c.name, c] as const))("accepts %s", (_, c) => {
		expect(refusalOf(verifyRoute(c.tx, c.expected))).toBeUndefined()
	})

	it("our Across builder reproduces every recorded router variant from its expectation alone", () => {
		for (const c of ROUTES.filter((r) => r.expected.rail.kind === "acrossV4")) {
			expect(buildAcrossV4Deposit(acrossDepositFor(c.expected)).data).toBe(c.tx.data)
		}
	})

	it("reports what the Stargate route carries: LI.FI's fee, Stargate's floor, our bounds", () => {
		const c = mainnetCase()
		const v = verifyRoute(c.tx, c.expected)
		if (!v.ok) throw new Error(v.reason)
		expect(v.decoded.lifiFee * 400n).toBeLessThanOrEqual(c.expected.srcAmount)
		expect(v.decoded.bridgeData.minAmount).toBe(c.expected.srcAmount - v.decoded.lifiFee)
		expect(v.decoded.stargate?.minAmountLD).toBeGreaterThanOrEqual(v.decoded.router.minReceived)
		expect(v.decoded.message.step.requiresDeposit).toBe(true)
	})

	it("accepts the replayed compose message, which carries the quote's own composeMsg", () => {
		const c = mainnetCase()
		const v = verifyComposeMessage(compose.message, c.expected)
		expect(refusalOf(v)).toBeUndefined()
		if (v.ok) expect(v.decoded.compose.composeMsg).toBe(compose.composeMsg)
		const forged = concat([slice(compose.message as Hex, 0, 44), pad("0xbad0", { size: 32 }), compose.composeMsg as Hex])
		expect(refusalOf(verifyComposeMessage(forged, c.expected))?.field).toBe("compose.composeFrom")
	})
})

describe("lifi-decode: refusals", () => {
	it("refuses the fork-proven direct-portal vector: its destination step is not our router call", () => {
		const c = testnetCase("public")
		const tx = { ...c.tx, data: rail.calldata }
		expect(refusalOf(verifyRoute(tx, { ...c.expected, lifiTxId: rail.inputs.transactionId }))?.field).toBe("message.swapData[0].callTo")
	})

	it("refuses the recorded Arbitrum WETH route: a source swap, and a destination swap before our call", () => {
		const c = mainnetCase("arbitrumWeth", mainnet.ethereum.weth)
		expect(refusalOf(verifyRoute(c.tx, c.expected))?.field).toBe("call._bridgeData.sendingAssetId")
		const { args } = decodeFunctionData({ abi: STARGATE_FACET_V2_ABI, data: c.tx.data })
		const sendParams = (args.length === 3 ? args[2] : args[1]).sendParams
		const delivered = encodePacked(
			["uint64", "uint32", "uint256", "bytes32", "bytes"],
			[1n, 30110, sendParams.minAmountLD, pad(lifiBook(42161).diamond, { size: 32 }), sendParams.composeMsg],
		)
		expect(refusalOf(verifyComposeMessage(delivered, c.expected))?.field).toBe("message.swapData.length")
	})

	it("refuses an Across call on a mainnet source, where no Across entrypoint is accepted", () => {
		const c = testnetCase("public")
		const base = lifiBook(8453).diamond
		const tx = { ...c.tx, chainId: 8453, to: base, approval: { ...c.tx.approval, spender: base } }
		expect(refusalOf(verifyRoute(tx, { ...c.expected, srcChainId: 8453 }))?.field).toBe("call.selector")
	})

	it.each<[string, Partial<RouteExpectation>, string]>([
		["an expiring RFQ venue", { fuel: { provider: "lifi", tool: "bitget" } }, "fuel.tool"],
		["a venue no warp test proved", { fuel: { provider: "lifi", tool: "1inch" } }, "fuel.tool"],
		["TestnetFuelSwapper on mainnet", { fuel: { provider: "testnetSwapper" } }, "fuel.provider"],
		["a slice with no named provider", { fuel: undefined }, "fuel.provider"],
	])("refuses a fuel quote from %s", (_, override, field) => {
		const c = mainnetCase()
		expect(refusalOf(verifyRoute(c.tx, { ...c.expected, ...override }))?.field).toBe(field)
	})

	it("refuses bytes that are not the canonical encoding of their own fields", () => {
		const c = mainnetCase()
		expect(refusalOf(verifyRoute({ ...c.tx, data: `${c.tx.data}00` }, c.expected))?.field).toBe("call")
	})
})

// The generated mutation suite. A route is modelled as its decoded layers; a mutation changes one leaf,
// re-encodes every enclosing layer, and runs the decoder on the result.

type Seg = string | number
type Values = Record<string, unknown>
interface NodeState {
	selector?: Hex
	values: Values
}
interface State {
	tx: NodeState
	approval: NodeState
	nodes: Record<string, NodeState>
}
interface NodeSpec {
	name: string
	parent?: { node: string; at: Seg[] }
	selector?: Hex
	params?: readonly AbiParameter[]
	encode(values: Values): Hex
}
interface Model {
	c: RouteCase
	specs: NodeSpec[]
	state: State
}
interface Leaf {
	path: string
	node: string
	type: string
	read(s: NodeState): unknown
	write(s: NodeState, v: unknown): void
	grow?(s: NodeState): void
}

const get = (v: unknown, at: Seg[]): unknown => at.reduce<unknown>((o, k) => (o as Record<Seg, unknown>)[k], v)
function set(v: unknown, at: Seg[], value: unknown): void {
	;(get(v, at.slice(0, -1)) as Record<Seg, unknown>)[at[at.length - 1]] = value
}
const render = (node: string, at: Seg[]) => node + at.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("")

type AbiFunction = { type: "function"; name: string; inputs: readonly AbiParameter[] }

function functionNode(name: string, abi: Abi, data: Hex, parent?: NodeSpec["parent"]): { spec: NodeSpec; state: NodeState } {
	const { functionName, args = [] } = decodeFunctionData({ abi, data })
	const item = abi.find((i) => i.type === "function" && i.name === functionName) as AbiFunction
	const values = Object.fromEntries(item.inputs.map((p, i) => [p.name as string, args[i]]))
	const encode = (v: Values) =>
		encodeFunctionData({ abi: [item], functionName, args: item.inputs.map((p) => v[p.name as string]) } as never)
	return {
		spec: { name, parent, selector: slice(data, 0, 4), params: item.inputs, encode },
		state: { selector: slice(data, 0, 4), values },
	}
}

function messageNode(data: Hex, parent: NodeSpec["parent"]): { spec: NodeSpec; state: NodeState } {
	const [transactionId, swapData, receiver] = decodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, data)
	const encode = (v: Values) => encodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, [v.transactionId, v.swapData, v.receiver] as never)
	return {
		spec: { name: "message", parent, params: LIFI_RECEIVER_MESSAGE_PARAMS, encode },
		state: { values: { transactionId, swapData: structuredClone(swapData), receiver } },
	}
}

const u = (v: bigint | number, bytes: number) =>
	BigInt(v)
		.toString(16)
		.padStart(bytes * 2, "0")
function encodeOption(o: LzExecutorOption): string {
	const body = (type: number, payload: string) => `01${u(payload.length / 2 + 1, 2)}${u(type, 1)}${payload}`
	if (o.kind === "lzReceive") return body(1, u(o.gas, 16) + (o.value ? u(o.value, 16) : ""))
	if (o.kind === "lzCompose") return body(3, u(o.index, 2) + u(o.gas, 16) + (o.value ? u(o.value, 16) : ""))
	if (o.kind === "nativeDrop") return body(2, u(o.amount, 16) + o.receiver.slice(2))
	return body(4, "")
}

const OPTION_FIELDS: Record<LzExecutorOption["kind"], Record<string, string>> = {
	lzReceive: { gas: "uint128", value: "uint128" },
	lzCompose: { index: "uint16", gas: "uint128", value: "uint128" },
	nativeDrop: { amount: "uint128", receiver: "bytes32" },
	orderedExecution: {},
}

function optionsNode(data: Hex, parent: NodeSpec["parent"], decoded: LzExecutorOption[]): { spec: NodeSpec; state: NodeState } {
	const encode = (v: Values) => `0x0003${(v.entries as LzExecutorOption[]).map(encodeOption).join("")}` as Hex
	expect(encode({ entries: decoded })).toBe(data)
	return { spec: { name: "options", parent, encode }, state: { values: { entries: decoded } } }
}

function buildModel(c: RouteCase): Model {
	const across = slice(c.tx.data, 0, 4) === START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR
	const call = functionNode("call", across ? ACROSS_V4_FACET_ABI : STARGATE_FACET_V2_ABI, c.tx.data)
	const built = [call]
	const messageAt: Seg[] = across ? ["_acrossData", "message"] : ["_stargateData", "sendParams", "composeMsg"]
	if (!across) {
		const at = ["_stargateData", "sendParams", "extraOptions"]
		const options = get(call.state.values, at) as Hex
		built.push(optionsNode(options, { node: "call", at }, decodeLzOptions(options)))
	}
	const swaps = call.state.values._swapData as LifiSwapData[] | undefined
	if (swaps?.[0])
		built.push(functionNode("fee", FEE_FORWARDER_ABI, swaps[0].callData, { node: "call", at: ["_swapData", 0, "callData"] }))
	const message = messageNode(get(call.state.values, messageAt) as Hex, { node: "call", at: messageAt })
	const routerData = (message.state.values.swapData as LifiSwapData[])[0].callData
	const router = functionNode("router", DEPOSIT_ROUTER_ABI, routerData, { node: "message", at: ["swapData", 0, "callData"] })
	built.push(message, router)
	const swapData = router.state.values.swapData as Hex
	if (swapData !== "0x") {
		const abi = [...SWAP_TOKENS_SINGLE_V3_ABI, ...SWAP_TOKENS_MULTIPLE_V3_ABI]
		built.push(functionNode("fuelSwap", abi, swapData, { node: "router", at: ["swapData"] }))
	}
	const order = ["fuelSwap", "router", "message", "fee", "options", "call"]
	const specs = order.flatMap((n) => built.filter((b) => b.spec.name === n).map((b) => b.spec))
	const tx = { values: { chainId: c.tx.chainId, from: c.tx.from, to: c.tx.to, value: c.tx.value } }
	const nodes = Object.fromEntries(built.map((b) => [b.spec.name, b.state]))
	return { c, specs, state: structuredClone({ tx, approval: { values: { ...c.tx.approval } }, nodes }) }
}

function encodeModel(m: Model, state: State): RouteCase {
	const bytes: Record<string, Hex> = {}
	for (const spec of m.specs) {
		const node = state.nodes[spec.name]
		let data = spec.encode(node.values)
		if (node.selector && node.selector !== spec.selector) data = concat([node.selector, slice(data, 4)])
		bytes[spec.name] = data
		if (spec.parent) set(state.nodes[spec.parent.node].values, spec.parent.at, data)
	}
	const t = state.tx.values as Omit<RouteTx, "data" | "approval">
	const tx: RouteTx = { ...t, data: bytes.call, approval: state.approval.values as RouteTx["approval"] }
	return { name: m.c.name, tx, expected: { ...m.c.expected, routerCall: bytes.router } }
}

const valueLeaf = (node: string, at: Seg[], type: string): Leaf => ({
	path: render(node, at),
	node,
	type,
	read: (s) => get(s.values, at),
	write: (s, v) => set(s.values, at, v),
})

function abiLeaves(node: string, p: AbiParameter, v: unknown, at: Seg[], children: string[]): Leaf[] {
	if (children.includes(render(node, at))) return []
	const components = "components" in p ? p.components : []
	if (p.type === "tuple")
		return components.flatMap((q) => abiLeaves(node, q, (v as Values)[q.name as string], [...at, q.name as string], children))
	if (p.type !== "tuple[]") return [valueLeaf(node, at, p.type)]
	const length: Leaf = {
		...valueLeaf(node, [...at, "length"], "length"),
		grow: (s) => (get(s.values, at) as unknown[]).push(structuredClone((get(s.values, at) as unknown[]).at(-1))),
	}
	const elements = (v as Values[]).flatMap((e, i) =>
		components.flatMap((q) => abiLeaves(node, q, e[q.name as string], [...at, i, q.name as string], children)),
	)
	return [length, ...elements]
}

function optionLeaves(entries: LzExecutorOption[]): Leaf[] {
	const seen: Record<string, number> = {}
	const leaves: Leaf[] = []
	for (const [j, o] of entries.entries()) {
		const i = seen[o.kind] ?? 0
		seen[o.kind] = i + 1
		for (const [f, type] of Object.entries(OPTION_FIELDS[o.kind])) {
			leaves.push({ ...valueLeaf("options", ["entries", j, f], type), path: `options.${o.kind}[${i}].${f}` })
		}
	}
	const grow = (kind: string) => (s: NodeState) => {
		const list = s.values.entries as LzExecutorOption[]
		const last = list.findLastIndex((o) => o.kind === kind)
		list.splice(last + 1, 0, structuredClone(list[last]))
	}
	return [
		...leaves,
		...Object.keys(seen).map((kind) => ({ ...valueLeaf("options", [], "length"), path: `options.${kind}.length`, grow: grow(kind) })),
	]
}

const PSEUDO_TYPES: Record<string, Record<string, string>> = {
	tx: { chainId: "uint32", from: "address", to: "address", value: "uint256" },
	approval: { token: "address", spender: "address", amount: "uint256" },
}

function leavesOf(m: Model): Leaf[] {
	const children = m.specs.filter((s) => s.parent).map((s) => render(s.parent?.node ?? "", s.parent?.at ?? []))
	const pseudo = Object.entries(PSEUDO_TYPES).flatMap(([node, fields]) => Object.entries(fields).map(([f, t]) => valueLeaf(node, [f], t)))
	const layers = m.specs.flatMap((spec): Leaf[] => {
		const values = m.state.nodes[spec.name].values
		if (spec.name === "options") return optionLeaves(values.entries as LzExecutorOption[])
		const params = spec.params ?? []
		const selector: Leaf[] = spec.selector
			? [
					{
						path: `${spec.name}.selector`,
						node: spec.name,
						type: "selector",
						read: (s) => s.selector,
						write: (s, v) => (s.selector = v as Hex),
					},
				]
			: []
		return [...selector, ...params.flatMap((p) => abiLeaves(spec.name, p, values[p.name as string], [p.name as string], children))]
	})
	return [...pseudo, ...layers]
}

const MAX = (type: string) => (1n << BigInt(type.replace(/\D/g, "") || 256)) - 1n
const asType = (type: string, v: bigint) => (Number(type.replace(/\D/g, "")) <= 48 ? Number(v) : v)

/** A value different from `v` of the same ABI type. */
function bump(type: string, v: unknown): unknown {
	if (typeof v === "boolean") return !v
	if (typeof v === "number" || typeof v === "bigint") return asType(type, BigInt(v) === MAX(type) ? BigInt(v) - 1n : BigInt(v) + 1n)
	if (type === "address")
		return (v as string).toLowerCase() === "0x000000000000000000000000000000000000dead"
			? `0x${"be".repeat(20)}`
			: "0x000000000000000000000000000000000000dEaD"
	if (type === "string") return `${v}x`
	if (type === "bytes") return concat([v as Hex, "0x01"])
	const bytes = v as Hex
	return `${bytes.slice(0, -2)}${toHex(Number.parseInt(bytes.slice(-2), 16) ^ 1, { size: 1 }).slice(2)}`
}

type Mutation = (s: NodeState) => void

function mutationsOf(leaf: Leaf, kind: FieldPolicyKind | "unpoliced", value: unknown): Mutation[] {
	const to =
		(v: unknown): Mutation =>
		(s) =>
			leaf.write(s, v)
	if (leaf.grow) return [leaf.grow]
	if (leaf.type === "selector") return [to("0xdeadbeef")]
	if (kind === "atLeast") return [to(asType(leaf.type, 0n))]
	if (kind === "atMost") return [to(asType(leaf.type, MAX(leaf.type)))]
	if (kind === "within") return [to(asType(leaf.type, 0n)), to(asType(leaf.type, MAX(leaf.type)))]
	return [to(bump(leaf.type, value))]
}

function runMutation(m: Model, leaf: Leaf, mutate: Mutation, alsoOurs: boolean): RouteVerdict {
	const state = structuredClone(m.state)
	const target = leaf.node === "tx" || leaf.node === "approval" ? state[leaf.node] : state.nodes[leaf.node]
	mutate(target)
	const mutated = encodeModel(m, state)
	// `routerCall` follows the mutation only when our builder embedded the changed bytes (the provider's fuel quote).
	const expected = alsoOurs ? mutated.expected : m.c.expected
	return verifyRoute(mutated.tx, expected)
}

function judgeLeaf(m: Model, leaf: Leaf): string[] {
	const policy = routeFieldPolicy(leaf.path)
	if (!policy) return [`${leaf.path}: neither policed nor listed unpoliced`]
	const failures: string[] = []
	const value = leaf.read(leaf.node === "tx" || leaf.node === "approval" ? m.state[leaf.node] : m.state.nodes[leaf.node])
	const kind = "kind" in policy ? policy.kind : "unpoliced"
	const quote = leaf.path.startsWith("fuelSwap.")
	if (value === undefined && !leaf.grow && leaf.type !== "selector") return [`${leaf.path}: read undefined`]
	for (const mutate of mutationsOf(leaf, kind, value)) {
		// Inside our own calldata every byte is ours: changed in transit, any leaf is refused.
		if (quote) failures.push(...expectRefused(leaf.path, runMutation(m, leaf, mutate, false), "in transit"))
		const verdict = runMutation(m, leaf, mutate, quote)
		if (kind === "unpoliced") {
			if (!verdict.ok) failures.push(`${leaf.path}: unpoliced but refused as ${verdict.field} (${verdict.reason})`)
		} else {
			failures.push(...expectRefused(leaf.path, verdict, kind))
		}
	}
	return failures
}

function expectRefused(path: string, v: RouteVerdict, how: string): string[] {
	if (v.ok) return [`${path}: a mutation outside its policy (${how}) was accepted`]
	return v.field === path ? [] : [`${path}: refused under ${v.field} (${v.reason}), ${how}`]
}

describe("lifi-decode: every single-field mutation", () => {
	it.each(ROUTES.map((c) => [c.name, c] as const))("of %s is refused under its own name unless listed unpoliced", (_, c) => {
		const m = buildModel(c)
		const leaves = leavesOf(m)
		const nested = c.expected.rail.kind === "stargateV2" ? ["fee._distributions[0].amount", "options.lzCompose[0].gas"] : []
		const fuel =
			c.name === "testnet plain" ? ["router.swapData"] : ["fuelSwap._swapData.fromAmount", "fuelSwap._swapData[0].fromAmount"]
		expect(leaves.map((l) => l.path)).toEqual(expect.arrayContaining(["message.receiver", "router.intent.fuelSlice", ...nested]))
		expect(leaves.some((l) => fuel.includes(l.path))).toBe(true)
		expect(leaves.flatMap((leaf) => judgeLeaf(m, leaf))).toEqual([])
	})
})
