#!/usr/bin/env bash
# Phase 9 steps 5–6, one run on testnet-l1, from the repository root, against the candidate: the FPC gate,
# the plain and fueled smokes, then the fee samples calibrate needs (EURC's paid public first registration
# and three private claims, GBPC's private first claim and two more, a plain USDC claim_public). Every
# signing command runs behind `live-intent verify`; there is no retry, so a failure stops for a reading.
set -euo pipefail
I=implementations-plan/aztec-6-stable/lessons/intent.json
C=apps/tools/public/testnet-bridge.candidate.json
export FUEL_SLICE_UNITS=1500000
v() { bun packages/bridge-core/scripts/live-intent.ts verify "$I"; }
fpc() { bun packages/bridge-core/scripts/check-fpc-version.ts; }
fuel() { bun packages/bridge-core/scripts/fuel-testnet.ts --config "$C" "$@"; }
fpc
v
bun packages/bridge-core/scripts/smoke-existing-testnet.ts --config "$C"
v
bun packages/bridge-core/scripts/smoke-swap-existing-testnet.ts --config "$C"
fpc
v
fuel --token 0xc10bcb5a0519934e68b489a3a89ee28af8624d24
v
PUBLIC_RUNS=0 fuel --token 0x177ead2a677858e376941390548fcf01a6ebefca
v
PUBLIC_RUNS=1 PRIVATE_RUNS=0 fuel --token 0x8648424f0eae2368555d080c948b622d992651fc
fpc
