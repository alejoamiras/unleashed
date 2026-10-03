/**
 * Prints the DERIVED contract class id of a compiled Noir artifact — the on-chain identity
 * (bytecode + ABI), which is what `compile.sh --check` compares between a fresh compile and
 * the committed artifact. Byte-identity of the JSON is too strict (debug metadata), a
 * self-reported version too weak; the class id is exactly what a deploy binds.
 *
 *   bun scripts/noir-class-id.ts <artifact.json>
 */
import { readFileSync } from "node:fs"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"

const path = process.argv[2]
if (!path) {
	console.error("usage: bun scripts/noir-class-id.ts <artifact.json>")
	process.exit(2)
}
const artifact = loadContractArtifact(JSON.parse(readFileSync(path, "utf8")))
const cls = await getContractClassFromArtifact(artifact)
console.log(cls.id.toString())
