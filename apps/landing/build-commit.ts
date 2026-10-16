const SHA = /^[0-9a-f]{40}$/

/**
 * The commit a build comes from: Workers Builds' `WORKERS_CI_COMMIT_SHA` when it is a full SHA, else
 * the checkout's HEAD. Workers Builds put the branch name in that variable on the first build after an
 * import, so a value that is not a SHA is ignored, not trusted. Throws when neither names a commit.
 */
export function buildCommit(fromEnv: string | undefined, head: () => string | null): string {
	if (fromEnv && SHA.test(fromEnv)) return fromEnv
	const sha = head()
	if (sha && SHA.test(sha)) return sha
	throw new Error(`no build identity: WORKERS_CI_COMMIT_SHA is '${fromEnv ?? ""}' and git HEAD is '${sha ?? ""}'`)
}
