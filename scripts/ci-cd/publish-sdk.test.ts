/**
 * The publish workflow's split: npm's OIDC token reaches one job, on `main` behind its environment, and that job runs
 * no repository or dependency code, only pinned actions and npm on the tarball the other job checked.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Step = { uses?: string; run?: string }
type Job = { permissions?: unknown; environment?: unknown; needs?: unknown; if?: unknown; steps: Step[] }

const ROOT = join(import.meta.dir, "..", "..")
const wf = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/publish-sdk.yml"), "utf8")) as {
  on: Record<string, unknown>
  permissions: unknown
  jobs: Record<string, Job>
}
const { pack, publish } = wf.jobs

test("runs only by hand, read-only by default", () => {
  expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"])
  expect(wf.permissions).toEqual({ contents: "read" })
  expect(Object.keys(wf.jobs).sort()).toEqual(["pack", "publish"])
})

test("only the publish job holds the OIDC token, on main, behind the npm-publish environment", () => {
  expect(pack.permissions).toBeUndefined()
  expect(publish.permissions).toEqual({ "id-token": "write" })
  expect(publish.needs).toBe("pack")
  expect(publish.if).toBe("github.ref == 'refs/heads/main'")
  expect(publish.environment).toBe("npm-publish")
})

test("the publish job checks out, installs and runs nothing of the repository's", () => {
  expect(publish.steps.flatMap((s) => (s.uses ? [s.uses.split("@")[0]] : []))).toEqual(["actions/download-artifact", "actions/setup-node"])
  const runs = publish.steps.flatMap((s) => (s.run ? [s.run] : []))
  expect(runs).toEqual([
    'echo "$SHA256  $TARBALL" | sha256sum --check --strict',
    'npm publish "./$TARBALL" --provenance --access public --ignore-scripts',
  ])
})

test("every action is pinned to a commit", () => {
  for (const step of [...pack.steps, ...publish.steps]) {
    if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
  }
})
