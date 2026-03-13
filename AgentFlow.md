# Agent Wallet Flow (v3)

## Overview

A system for giving autonomous agents their own Stellar smart wallet — without ever seeing their keys, while retaining full owner control. Agents can send tokens, trade on DEXes, use lending protocols like Blend, and interact with any Soroban contract — all within policies the owner defines.

## Core Design Principles

1. **Account balance = total budget.** Fund an agent with 500 XLM, that's their spending cap. No counters to bypass.
2. **Per-tx limits enforced on all paths.** Every token movement goes through the contract's wrapper functions, which check limits before forwarding.
3. **Agents can only call wrapper functions.** `__check_auth` restricts agents to whitelisted functions on their own contract. No direct external contract authorization. No admin function access.
4. **One-call onboarding.** Invite codes carry the full config (budget + policy). Agent calls `factory.create()` and gets a funded, configured, operational account.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Owner (You)                        │
│                                                      │
│  - Pre-funds factory with token pool                 │
│  - Creates invite codes (budget + policy)            │
│  - Can revoke/freeze/drain any agent                 │
│  - Can rotate own key and agent keys                 │
│  - Never sees agent secret keys                      │
└──────────┬───────────────────────────────┬───────────┘
           │                               │
     create_invite(code, config)     revoke/freeze/drain
           │                               │
           ▼                               ▼
┌─────────────────────┐      ┌─────────────────────────┐
│   Factory Contract   │      │  Agent Contract Account  │
│                      │      │                          │
│  - Owner as Address  │──►   │  - Owner key (from       │
│  - Validates invite  │      │    factory at deploy)    │
│  - Burns + deploys   │      │  - Agent key + policy    │
│  - Funds from pool   │      │  - Wrapper functions     │
│  - Config in invite  │      │  - __check_auth guard    │
└─────────────────────┘      └──────────┬──────────────┘
           ▲                             │
           │                    agent_transfer()
     create(key, code)          agent_invoke()
           │                    agent_swap()
           │                    agent_supply()
           │                    agent_withdraw()
           │                             │
┌──────────┴─────────────────────────────┴─────────────┐
│                      Agent                            │
│                                                      │
│  - Generates own keypair                             │
│  - Onboards via invite code (one call)               │
│  - Interacts with DeFi via wrapper functions         │
│  - Needs no XLM for gas (relayer)                    │
└──────────────────────────────────────────────────────┘
```

---

## Security Model

### `__check_auth` — the single enforcement point

```
if signer == owner   → allow everything
if signer == agent:
  → is agent frozen? → reject
  → is agent expired? → reject
  → for EVERY auth context entry:
      → must target THIS contract (not external)
      → must be a whitelisted wrapper function
      → agent_key arg must match the actual signer (prevents key spoofing)
      → reject admin functions, reject external calls
if signer == unknown → reject
```

Agents can NEVER:
- Call admin functions (`add_agent`, `drain`, `rotate_owner`, etc.)
- Directly authorize calls to external contracts (DEX, token, etc.)
- Call `approve` on a token (prevents colluding address drain) — *caveat: if a token contract is in the agent's allowlist, `agent_invoke` could proxy an `approve`/`burn` call; use `AllowOnly` without token contracts to prevent this*
- Call `burn` on a token

All external interactions go through wrapper functions, which enforce the policy.

### Wrapper functions — the policy enforcement layer

| Function | Purpose | What it checks |
|----------|---------|----------------|
| `agent_transfer` | Send tokens | Token allowed? Per-tx limit? Destination allowed? |
| `agent_invoke` | Call any external contract | Not self? Contract allowed? Declared spend under per-tx limit? |
| `agent_swap` | Trade on a DEX | DEX allowed? Token-in under per-tx limit? |
| `agent_supply` | Deposit into lending | Protocol allowed? Token under per-tx limit? |
| `agent_withdraw` | Withdraw from lending | Protocol allowed? (No spend check — value flows in) |

---

## Agent Onboarding — One Call

### Step 1: Owner creates invite codes

Each invite is an "agent starter kit" — budget, policy, everything:

```rust
pub struct InviteConfig {
    pub funding: Vec<TokenAmount>,  // e.g., [500 XLM, 1000 USDC]
    pub policy: AgentPolicy,        // per-tx limits, access control, expiry
}

// Single invite
factory.create_invite(code, config)

// Batch — same config for all (e.g., 20 identical trading bots)
factory.create_invites(codes, config)
```

Invite codes are stored in **temporary storage** (~7 day TTL, auto-expire). Max batch size: 50.

### Step 2: Agent generates its own keypair

On boot. Owner never sees the secret key.

### Step 3: Agent calls `factory.create(my_key, invite_code)`

One call. The factory:
1. Validates the invite code exists → panics if not
2. Burns the invite code (atomic)
3. Deploys a new contract with owner key + agent key + policy (via constructor)
4. Funds the contract from the factory's token pool
5. Emits `(agent, deployed)` event

The agent is immediately operational with funds and a configured policy.

---

## Policy

### Token limits

Tokens not in the list are blocked entirely. Each token gets its own per-tx cap:

```rust
pub struct TokenLimit {
    pub token: Address,         // SAC for XLM, USDC contract, etc.
    pub per_tx_limit: i128,     // max per transaction, 0 = unlimited
}
```

### Access control

Which external contracts the agent can interact with. **Allowlist and denylist are mutually exclusive** — the contract rejects policies that set both.

```rust
pub enum AccessControl {
    AllowAll,                   // any contract
    AllowOnly(Vec<Address>),    // ONLY these (safest)
    DenyOnly(Vec<Address>),     // everything EXCEPT these (bypassable via proxy)
}
```

**Recommendation:** Use `AllowOnly` for real security. `DenyOnly` can be circumvented by a proxy contract.

### Full policy struct

```rust
pub struct AgentPolicy {
    pub token_limits: Vec<TokenLimit>,  // allowed tokens + per-tx caps
    pub access: AccessControl,          // which contracts
    pub expiry_ledger: u32,             // 0 = no expiry
}
```

### Budget

The account balance IS the total spending cap. Fund with 500 XLM → that's the budget. When it's gone, the agent stops. Owner tops up or drains to adjust.

---

## Example: Blend Lending Agent

```
Owner creates invite:
  funding: [2000 USDC]
  policy:
    token_limits: [{ token: USDC, per_tx_limit: 200 }]
    access: AllowOnly([BLEND_POOL, USDC_SAC])
    expiry: 30 days

Agent onboards → gets 2000 USDC, can interact with Blend only

Agent supplies 100 USDC to Blend:
  → agent_supply(my_key, BLEND_POOL, "supply", args, USDC, 100)
  → contract checks: BLEND_POOL in allowlist? ✓
  → contract checks: 100 USDC under per_tx_limit of 200? ✓
  → contract calls Blend.supply(...)
  → done

Agent tries 300 USDC:
  → 300 > per_tx_limit of 200 → REJECTED

Agent tries to call a random contract:
  → not in allowlist → REJECTED

Agent tries drain() on own contract:
  → __check_auth: not a wrapper function → REJECTED
```

---

## Owner Controls

All owner functions require `require_auth` → `__check_auth` → owner signature verified.

### Agent management

```rust
add_agent(agent_key, policy)
revoke_agent(agent_key)              // permanent
freeze_agent(agent_key)              // temporary, reversible
unfreeze_agent(agent_key)
update_policy(agent_key, policy)
rotate_agent_key(old_key, new_key)   // preserves status + policy
```

### Funds

```rust
drain(token_address, destination, amount)   // pull any token, any amount
```

### Key rotation

```rust
rotate_owner(new_owner)                       // change owner key (contract level)
factory.rotate_owner(new_owner, new_key)      // change factory owner
factory.drain(token, destination, amount)     // withdraw from factory token pool
```

### Read functions

```rust
get_owner() -> BytesN<32>
get_agent_status(agent_key) -> AgentStatus
get_policy(agent_key) -> AgentPolicy
```

---

## Event Emission

Every state-changing function emits a Soroban event:

| Event | Data |
|-------|------|
| `(agent, added)` | agent_key |
| `(agent, revoked)` | agent_key |
| `(agent, frozen)` | agent_key |
| `(agent, unfrozen)` | agent_key |
| `(agent, rotated)` | (old_key, new_key) |
| `(agent, deployed)` | (agent_key, contract_address) |
| `(policy, updated)` | agent_key |
| `(transfer,)` | (agent_key, token_address, destination, amount) |
| `(invoke,)` | (agent_key, contract, fn_name, spend_token, spend_amount) |
| `(swap,)` | (agent_key, dex, token_in, amount_in) |
| `(supply,)` | (agent_key, protocol, token, amount) |
| `(withdraw,)` | (agent_key, protocol) |
| `(drain,)` | (token_address, destination, amount) |
| `(owner, rotated)` | new_owner |
| `(invite, created)` | () |
| `(invite, batch)` | count |

---

## Storage Strategy

| Data | Storage Type | Why |
|------|-------------|-----|
| Owner key | Instance | Auto-extended on every invocation |
| Agent status | Persistent + TTL extension | Extended on every `__check_auth` read |
| Agent policy | Persistent + TTL extension | Extended on every `__check_auth` read |
| Invite configs (factory) | Temporary | Auto-expire after ~7 days |
| Factory owner + WASM hash | Instance | Auto-extended on every invocation |

---

## Security Properties

| Property | How it's enforced |
|----------|-------------------|
| Only owner's agents can onboard | Invite codes, owner-created only, auto-expiring |
| Invites can't be reused | Burned atomically with deployment |
| Owner never sees agent keys | Agent self-generates keypair |
| Agent can't call admin functions | `__check_auth` whitelists only wrapper functions; self-calls blocked |
| Agent can't spoof another agent's key | `__check_auth` verifies agent_key arg matches signer |
| Agent can't bypass per-tx limits | All paths go through wrapper functions; spend declaration required |
| Agent can't approve/burn tokens | `__check_auth` blocks all direct external auth |
| Agent total budget is bounded | Account balance = cap, can't spend what doesn't exist |
| Owner can revoke anytime | Remove agent key from contract storage |
| Owner can recover funds | `drain()` function, owner-only |
| Agent can't modify its own policy | Only owner key passes admin function auth |
| Compromised agent is contained | Revoke + drain, other agents unaffected |
| Owner key is rotatable | `rotate_owner()` on both contract and factory |
| All actions are auditable | Soroban events on every state change |

### Known Limitations

| Limitation | Mitigation |
|------------|------------|
| `DenyOnly` bypassable via proxy contracts | Use `AllowOnly` for real security |
| No rate-limiting (agent can drain balance in rapid txs) | Per-tx limit bounds each tx; monitor via events |
| Unsolicited tokens sent to agent inflate budget | Monitor incoming transfers; drain excess |
| Invite codes not bound to specific agent key | Interceptor gets an account owner controls; revoke immediately |

---

## Implementation Status

| Piece | Status | Where |
|-------|--------|-------|
| Agent contract (`simple_account`) | Done — v3, 28 tests | `contracts/simple_account/src/lib.rs` |
| Factory contract (`account_factory`) | Done — 17 tests (incl. integration) | `contracts/account_factory/src/lib.rs` |
| Shared types crate | Done | `contracts/agent-types/src/lib.rs` |
| WASM compilation | Done — 15KB + 9KB | `stellar contract build` |
| Generic Soroban custom account kit | Done — signing, submission, helpers | `lib/soroban-custom-account/` |
| Lumenitos Agent SDK | Done — AgentWallet, clients, relayer | `lib/agent-sdk/` |
| Signature struct support | Done — `{ public_key, signature }` ScVal map | `lib/soroban-custom-account/signer.ts` |
| Wrapper function client utils | Done — all 5 operations | `lib/agent-sdk/account-client.ts` |
| Fee-sponsored relay (OZ Relayer) | Done — transparent to SDK user, 9 relayer E2E tests pass | `lib/soroban-custom-account/relayer-submitter.ts` |
| Self-hosted OZ Relayer | Done — Docker, KMS-ready architecture | `relayer/` |
| Testnet deployment | Done — latest factory at `CBBOC65D5RRPYJWRULZCRR6OTPSZ4IV6MPPB2PHWOHIMHTSWRRC2IPJR` | `scripts/deploy-testnet.js` |
| Real `__check_auth` on-chain validation | Done — all 23 E2E tests pass with real signatures on testnet | `scripts/e2e-test.js` |
| Relayer E2E tests | Done — all 9 tests pass with OZ Relayer on testnet | `scripts/e2e-test-relayer.js` |
| How It Works guide | Done — architecture, tx flow, setup tutorial, troubleshooting | `docs/how-it-works.md` |
| DX walkthrough | Done — full guided setup verified, DX observations captured | `AgentFlowStatus.md` (Phase 3.5) |

## Future Work

| Piece | Description |
|-------|-------------|
| Phase 4: Hardening | Advanced auth scenarios (expired agents, two-agent isolation), protocol integration tests (Blend, Soroswap) |
| Owner dashboard / agent manager UI | Fleet management, balance monitoring, policy editor |
| Off-chain monitoring + alerting | Indexer for events, spend rate alerts, anomaly detection |
| Publish `soroban-custom-account` to npm | Generic kit usable by any Soroban custom account project |
| Provisioning service | Automated invite generation, secure code delivery |
| Multi-sig owner | Require multiple keys for owner operations |
| Lifetime spending cap | Optional cumulative limit per agent per token |
| Protocol-specific wrappers | Typed wrappers for Blend, Soroswap, etc. with richer validation |
| KMS integration for relayer | Replace local signer with cloud KMS (AWS/GCP) for production relayer |
| Formal security audit | External audit of contracts + SDK before mainnet |
