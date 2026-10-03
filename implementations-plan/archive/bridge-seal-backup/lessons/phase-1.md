# P1 - bridge-core backup module (lessons)

## P1 COMPLETE
- `backup.ts`: `BridgeBackupFile` v1 (unauthenticated routing header + AES-GCM blob over `{bk:1, record}`), `parseBackupFile` ladder (junk/foreign/future-version/malformed/provisional), `validateBackupRecord` strict per-direction guard (the journal's shallow parser is for OUR storage, never foreign files), `sealBridgeBackup` (provisional withdraws refuse), `openBridgeBackup` (attribution-honest GCM copy; every header field re-checked against the sealed copies).
- 9 pins: 3-variant round-trip, no-plaintext-secret, wrong-key, tampered blob, header swaps (id/chainId/direction), provisional refusal at seal+parse, parse ladder, junk shapes, forged inner payload.
- Gotcha: bridge-core tests run under VITEST (not bun:test, despite the bun-everywhere repo rule) - a bun:test import both fails typecheck and loads incompatibly (the aztec foundation expect-extension).

LESSONS_FILE=implementations-plan/archive/bridge-seal-backup/lessons/phase-1.md
