# Phase R — public acceptance (lessons)

## Gate state

R NOT started — execution is user-gated ("test it before approving R"): the user is manually
smoke-testing the faucet preview of the tree (`buildId 0.1.0`, chainId 1816023401,
verify:deployments green) with the wallet before giving the go.

## Pre-R smoke finding (user manual test)

**registerContract void-conformance (connect-blocking)**: 5.0.1 WalletSchema returns
`Promise<void>`; the wallet's handler returned the instance → dApp-side `z.void()` ZodError killed the
faucet handshake. THE CI BLIND SPOT: the wallet's one e2e that executes the dApp-side wallet-sdk
validator accepted status "error". The wallet fixed both. Lesson: conformance to an
externally-owned schema needs a pin against that schema; an assertion that tolerates "error" isn't
a test, it's a mute button.

Also: local smoke rig needed a secure origin — raw-IP HTTP is not a secure context
(COOP ignored, `crypto.randomUUID` absent). Fixed via HTTPS in front of the vite
preview (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` for the host allowlist; no repo config).
