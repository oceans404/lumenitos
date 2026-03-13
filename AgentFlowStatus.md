# Agent Wallet — Current Status & Next Steps

Last updated: 2026-03-13

## Summary

Phases 1, 2, 3, and 3.5 (DX) are complete. The agent wallet system is **fully operational on Stellar testnet** with:
- **Soroban contracts**: 2 contracts, shared types crate, 45 unit tests passing
- **TypeScript SDK**: 2-layer architecture (generic Soroban kit + Lumenitos-specific SDK), reviewed across multiple rounds by 3 specialists
- **Testnet deployment**: Latest factory at `CBBOC65D5RRPYJWRULZCRR6OTPSZ4IV6MPPB2PHWOHIMHTSWRRC2IPJR`, all 23 E2E tests passing with real `__check_auth`
- **OZ Relayer integration**: Self-hosted relayer in Docker, all 9 relayer E2E tests passing, KMS-ready architecture
- **Documentation**: Full "How It Works" guide (`docs/how-it-works.md`) covering architecture, transaction flow, setup, and troubleshooting
- **DX walkthrough**: Full guided setup tested end-to-end, DX observations captured

**Next milestone: Phase 4 — hardening (protocol integration tests, advanced auth scenarios).**

---

## Phase 1: Contracts ✅ COMPLETE

Both contracts compile to WASM and pass 45 tests.

| Contract | WASM | Tests | Purpose |
|----------|------|-------|---------|
| `simple_account` | 15,489 bytes | 28 | Agent wallet: __check_auth, 5 wrapper functions, lifecycle, policies |
| `account_factory` | 9,692 bytes | 17 | One-call onboarding: invite → deploy → configure → fund |
| `agent-types` | (lib crate) | — | Shared types: TokenLimit, AccessControl, AgentPolicy, TokenAmount |

**Key test caveat:** All 45 tests use `mock_all_auths()`. Real `__check_auth` (signature verification, agent restriction) is untested until Phase 3/4.

## Phase 2: TypeScript SDK ✅ COMPLETE

Two-layer TypeScript SDK with 0 type errors, reviewed across 3 rounds.

```
lib/
  soroban-custom-account/    ← Generic: signing, submission, helpers (reusable by anyone)
  agent-sdk/                 ← Lumenitos: AgentWallet, AccountClient, FactoryClient
```

| Layer | Files | What it does |
|-------|-------|-------------|
| `soroban-custom-account` | 7 | Ed25519 auth signing with pluggable SignatureBuilder, Direct + Relayer submitters, pure helpers |
| `agent-sdk` | 9 | AgentWallet facade, contract operation builders, invite system, network presets |

**Key design:** Generic layer accepts any `CustomAccountSigner` via `SignatureBuilder` callback. Lumenitos layer uses the default `{ public_key, signature }` struct. `RelayerSubmitter` (self-hosted OZ Relayer) handles fee sponsorship — transparent to the caller.

---

## Phase 3: Testnet Deployment ✅ COMPLETE

Real `__check_auth` with the Signature struct validated on testnet. All E2E tests pass with both DirectSubmitter and RelayerSubmitter.

### What was done

- **Deployment scripts** ✅: `scripts/deploy-testnet.js` (WASM upload + factory deploy), `scripts/fund-factory.js` (XLM transfer to factory), `scripts/create-invite.js` (invite creation with configurable policies). Reviewed by Stellar protocol specialist — all ScVal encodings, constructor args, and SDK v14 patterns verified correct.
- **E2E test script** ✅: `scripts/e2e-test.js` — 23 tests across 5 phases validating: factory reads, invite creation, agent onboarding, real `__check_auth` transfers, per-tx limit enforcement, unknown signer rejection, key spoofing rejection, invite replay rejection, freeze/unfreeze, drain.
- **Relayer E2E test script** ✅: `scripts/e2e-test-relayer.js` — 9 tests validating fee-sponsored agent operations via self-hosted OZ Relayer.
- **Self-hosted OZ Relayer** ✅: `relayer/` — Docker Compose setup with KMS-ready architecture. Replaces the removed GaslessSubmitter (OZ Channels/Defender).
- **Deployment guide** ✅: `docs/phase3-deployment-guide.md` — prerequisites, step-by-step deployment, verification checklist, E2E testing guide, agent quickstart, owner operations, known issues.
- **Factory deployed on testnet**: `CBBOC65D5RRPYJWRULZCRR6OTPSZ4IV6MPPB2PHWOHIMHTSWRRC2IPJR` (latest), `CAVMF7D675SOIXXZQCRJPDAKLJB43UUZYDVSZEK2L7UC5JYSYNHYBVH7` (previous)

### Key milestones

- ✅ Deployed to testnet: factory at `CBBOC65D5RRPYJWRULZCRR6OTPSZ4IV6MPPB2PHWOHIMHTSWRRC2IPJR`
- ✅ All 23 E2E tests pass with real `__check_auth` signatures on testnet (DirectSubmitter)
- ✅ All 9 relayer E2E tests pass with OZ Relayer on testnet (RelayerSubmitter)
- ✅ GaslessSubmitter (OZ Channels) removed — replaced by RelayerSubmitter with self-hosted OZ Relayer
- ✅ RelayConfig (embedded owner key) removed — eliminated security hole
- ✅ Instruction limit bump (+1M) confirmed sufficient for on-chain ed25519 verification
- ✅ Documented tooling challenges in `REFLECTIONS.md`
- ✅ Fixed 3 bugs found during testnet run: returnValue parsing, destination account existence, contract address extraction

## Phase 3.5: Documentation & DX ✅ COMPLETE

Guided walkthrough of the full setup flow, observed by a DX specialist. All steps completed successfully.

### What was done

- **How It Works guide** ✅: `docs/how-it-works.md` — comprehensive guide covering system overview, architecture diagram, OZ Relayer internals, 10-step transaction flow, setup tutorial (8 steps), and troubleshooting (9 common issues).
- **`TEST_DESTINATION` env var** ✅: Both `e2e-test.js` and `e2e-test-relayer.js` now accept `TEST_DESTINATION` to skip friendbot for the destination account. Faster tests, no friendbot dependency.
- **Fresh testnet deployment verified** ✅: Full walkthrough from `npm install` through 9/9 relayer E2E tests passing.

### DX Observations

- **Overall**: Setup is well above average for a Soroban project. 9 steps, only 1 user error, no tooling failures.
- **Friction point**: Multi-line `ENV_VAR=value node script.js` commands break silently if user hits Enter before `node`. The missing-prerequisites error message handled it well. Recommendation: have E2E scripts auto-read from `.env` (matches `fund-factory` / `create-invite` pattern).
- **Gap**: First-time OZ Relayer setup (keystore generation with Rust `oz-keystore`, keccak256 MAC) was not tested — was pre-configured from a previous session. This step likely has the most friction for new users.
- **Good**: Deploy script output with env vars and next steps, contract build feedback (WASM sizes + exported functions), clear invite code output.

---

## Phase 4: Hardening

- **Real-auth `__check_auth` tests** without `mock_all_auths` — verify signature verification, agent restrictions, key matching, all rejection paths
- **Integration tests** with real Soroban protocols (Blend, Soroswap)
- **Deployment scripts** — automate compile → deploy → fund → invite

## Phase 5: Future Work

- Owner dashboard / agent fleet management UI
- Off-chain event indexer + spend rate alerting
- Publish `soroban-custom-account` as npm package
- Provisioning service (automated invite distribution)
- Multi-sig owner support, lifetime spending caps, rate limiting
- Formal security audit

---

## Security Status

### Closed + Tested (Unit Tests)
Privilege escalation, self-call escalation, agent key spoofing, per-tx limits, token restrictions, access control (allowlist/denylist), freeze/revoke, expiry, DeFi sub-auth nesting, invite burn/replay, duplicate key deploy, constructor mismatch guard, factory deploy+fund integration.

### Closed + Tested (E2E on Testnet — Phase 3)
Real ed25519 signature verification, agent restricted to wrapper functions, agent key spoofing rejection, owner bypass, frozen agent rejection, unknown signer rejection, per-tx limit enforcement, invite replay prevention, one-call onboarding, freeze/unfreeze cycle, owner drain.

### Closed + Tested (E2E on Testnet — Relayer)
Fee-sponsored agent onboarding via OZ Relayer, fee-sponsored agent transfers, fee-sponsored owner operations, relayer transparent to SDK user. All 9 relayer E2E tests pass.

### Closed + Untested (Phase 4)
Expired agent rejection (requires ledger advancement), non-Contract context block (not testable via SDK), agent calling admin functions directly (requires crafting custom auth context), two-agent isolation on same factory, policy update then agent operates under new policy.

### Accepted Risks
Balance = budget (no cumulative caps), `agent_withdraw` no spend check (value flows in), `per_tx_limit: 0` = unlimited, spend declaration in `agent_invoke` is trust-based, DenyOnly bypassable via proxy, invite codes not bound to specific key, no rate limiting.

---

## Architecture

```
Owner
  │
  ├── Pre-funds factory with tokens
  ├── Creates invite codes (budget + policy)
  └── Can revoke/freeze/drain any agent
  │
  ▼
Factory Contract → deploys →  Agent Contract Account
                                │  Owner key + Agent key + Policy
                                │  __check_auth: agent = wrappers only
                                │  Wrapper functions enforce limits
                                ▼
                              Agent (via SDK)
                                wallet.transfer() / .invoke() / .swap()
                                │
                        ┌───────┴────────┐
                        │                │
                  DirectSubmitter   RelayerSubmitter
                  (agent pays)     (OZ Relayer pays)
                                   Docker, KMS-ready
```

## Files

| File | Purpose |
|------|---------|
| `contracts/agent-types/src/lib.rs` | Shared Rust types |
| `contracts/simple_account/src/lib.rs` | Agent contract + 28 tests |
| `contracts/account_factory/src/lib.rs` | Factory contract + 17 tests |
| `lib/soroban-custom-account/` | Generic Soroban custom account kit (7 TS files) |
| `lib/agent-sdk/` | Lumenitos agent SDK (9 TS files) |
| `lib/README.md` | High-level library overview |
| `AgentFlow.md` | Design document (v3) |
| `AgentFlowStatus.md` | This file |
| `scripts/deploy-testnet.js` | Testnet deployment: WASM upload + factory deploy |
| `scripts/fund-factory.js` | Transfer XLM to factory token pool |
| `scripts/create-invite.js` | Create invite codes with configurable policies |
| `scripts/e2e-test.js` | 23 E2E tests with real `__check_auth` on testnet (DirectSubmitter) |
| `scripts/e2e-test-relayer.js` | 9 E2E tests with OZ Relayer on testnet (RelayerSubmitter) |
| `relayer/` | Self-hosted OZ Relayer: Docker Compose, config, KMS-ready |
| `relayer/docker-compose.yml` | OZ Relayer Docker orchestration |
| `relayer/config/config.json` | Relayer configuration (network, policies) |
| `docs/phase3-deployment-guide.md` | Full Phase 3 deployment + operations guide |
| `docs/how-it-works.md` | Comprehensive guide: architecture, tx flow, setup tutorial, troubleshooting |
