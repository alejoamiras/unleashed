import { expect, test } from "vitest"
import { buildCommit } from "./build-commit.ts"

const ENV_SHA = "1dd4aec78a68425761d5452383140439607f8ec3"
const HEAD_SHA = "bf6596d59c450b25996505cafeb010210ef0309e"

test("a full SHA from Workers Builds wins, and git is not asked", () => {
	expect(
		buildCommit(ENV_SHA, () => {
			throw new Error("git must not run")
		}),
	).toBe(ENV_SHA)
})

test.each([["main"], [""], [undefined], [ENV_SHA.slice(0, 8)]])("WORKERS_CI_COMMIT_SHA=%s falls back to git HEAD", (fromEnv) => {
	expect(buildCommit(fromEnv, () => HEAD_SHA)).toBe(HEAD_SHA)
})

test("with neither a SHA nor a checkout, the build has no identity", () => {
	expect(() => buildCommit("main", () => null)).toThrow("no build identity")
	expect(() => buildCommit(undefined, () => "main")).toThrow("no build identity")
})
