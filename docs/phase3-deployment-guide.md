# Phase 3: Testnet Deployment & Operations Guide

This guide covers deploying the Lumenitos agent wallet system to Stellar testnet, running end-to-end validation, and operating the system day-to-day.

---

## 1. Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Stellar CLI (`stellar`) | >= 22.x | Contract compilation, deployment, CLI queries |
| Rust + `wasm32v1-none` target | stable | Compiling Soroban contracts to WASM |
| Node.js | >= 18 | Running deployment scripts, SDK, E2E tests |
| npm | >= 9 | Dependency management |

Install the Stellar CLI:

```bash
# macOS
brew install stellar-cli

# Or via cargo
cargo install stellar-cli --locked
```

Add the WASM target:

```bash
rustup target add wasm32v1-none
```

### Environment Setup

Clone the repo and install dependencies:

```bash
git clone <repo-url>
cd lumenitos
npm install
```

Set up environment variables. Create a `.env.local` file (never commit this):

```bash
# Owner/admin secret key for testnet (generate one or use an existing funded testnet account)
STELLAR_TESTNET_SECRET=SDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# After deployment, these get populated:
NEXT_PUBLIC_SIMPLE_ACCOUNT_WASM_HASH=<filled after deploy>
NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS=<filled after deploy>
```

Fund your admin account via friendbot:

```bash
curl "https://friendbot.stellar.org?addr=GXXXX_YOUR_PUBLIC_KEY"
```

### Build the WASM Contracts

Both contracts must be compiled before deployment. Build from the repo root:

```bash
# Build simple_account first (factory tests depend on its WASM)
cd contracts/simple_account
stellar contract build

# Build account_factory
cd ../account_factory
stellar contract build
```

Verify the output files exist:

```bash
ls -la contracts/simple_account/target/wasm32v1-none/release/simple_account.wasm
# Expected: ~15,537 bytes

ls -la contracts/account_factory/target/wasm32v1-none/release/account_factory.wasm
# Expected: ~9,469 bytes
```

Run the contract unit tests (45 tests, all should pass):

```bash
cd contracts/simple_account && cargo test
cd ../account_factory && cargo test
```

---

## 2. Deployment Steps

Deployment is a three-step process: upload WASM, deploy factory, fund factory.

### Step 1: Upload simple_account WASM to Testnet

This installs the agent contract WASM bytecode on-chain. The factory references it by hash when deploying new agent accounts.

```bash
stellar contract install \
  --wasm contracts/simple_account/target/wasm32v1-none/release/simple_account.wasm \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet
```

This prints the WASM hash. Save it:

```bash
# Example output:
# 7a1b2c3d4e5f...  (64 hex characters)
export SIMPLE_ACCOUNT_WASM_HASH=<the hash from above>
```

Verify the WASM is installed:

```bash
stellar contract info wasm-hash \
  --wasm contracts/simple_account/target/wasm32v1-none/release/simple_account.wasm
```

### Step 2: Deploy the account_factory Contract

First, upload the factory WASM:

```bash
stellar contract install \
  --wasm contracts/account_factory/target/wasm32v1-none/release/account_factory.wasm \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet
```

Then deploy the factory with constructor arguments. The constructor takes three arguments:
- `wasm_hash` (BytesN<32>): the simple_account WASM hash from Step 1
- `owner` (Address): the owner's Stellar address (for `require_auth`)
- `owner_key` (BytesN<32>): the owner's raw ed25519 public key (passed into deployed agent contracts)

```bash
# Get the owner's public key
OWNER_PUBLIC_KEY=$(stellar keys address $STELLAR_TESTNET_SECRET 2>/dev/null || echo "use your G... address")

# Get raw ed25519 bytes (32 bytes hex) from the public key
# The public key bytes are the base32-decoded G... address minus the version byte and checksum

stellar contract deploy \
  --wasm contracts/account_factory/target/wasm32v1-none/release/account_factory.wasm \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  --wasm_hash $SIMPLE_ACCOUNT_WASM_HASH \
  --owner $OWNER_PUBLIC_KEY \
  --owner_key $OWNER_PUBLIC_KEY
```

Save the deployed factory address:

```bash
# Example output:
# CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP
export FACTORY_ADDRESS=<the C... address from above>
```

### Step 3: Fund the Factory Token Pool

The factory needs tokens to fund agent accounts on deployment. For testnet, use the native XLM SAC (Stellar Asset Contract):

```bash
# First, figure out the native XLM SAC address on testnet
stellar contract id asset --asset native --network testnet
# Save this as XLM_SAC_ADDRESS

# Transfer XLM to the factory using the SAC transfer function
stellar contract invoke \
  --id $XLM_SAC_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  transfer \
  --from $OWNER_PUBLIC_KEY \
  --to $FACTORY_ADDRESS \
  --amount 50000000000  # 5000 XLM in stroops (7 decimals)
```

Verify the factory balance:

```bash
stellar contract invoke \
  --id $XLM_SAC_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  balance \
  --id $FACTORY_ADDRESS
```

### Step 4: Create Invite Codes

Generate a random 32-byte invite code and create it on-chain:

```bash
# Generate a random invite code (64 hex chars = 32 bytes)
INVITE_CODE=$(openssl rand -hex 32)
echo "Invite code: $INVITE_CODE"
```

Create the invite via the factory contract. The invite config includes funding amounts and an agent policy:

```bash
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  create_invite \
  --invite_code $INVITE_CODE \
  --config '{"funding": [{"token": "'$XLM_SAC_ADDRESS'", "amount": 1000000000}], "policy": {"token_limits": [{"token": "'$XLM_SAC_ADDRESS'", "per_tx_limit": 500000000}], "access": "AllowAll", "expiry_ledger": 0}}'
```

This creates an invite that gives agents 100 XLM (1000000000 stroops) with a 50 XLM per-transaction limit.

### Expected Outputs Summary

| Step | Expected Output |
|------|----------------|
| WASM install | 64-character hex hash |
| Factory deploy | C... contract address |
| Fund factory | Transaction hash confirming transfer |
| Create invite | Transaction hash confirming invite creation |

---

## 3. Verification Checklist

### Verify Contracts Are Deployed

```bash
# Check the factory contract exists and responds
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  owner

# Expected: the owner's Address (should match your admin account)
```

```bash
# Check the WASM hash stored in the factory
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  wasm_hash

# Expected: matches $SIMPLE_ACCOUNT_WASM_HASH
```

### Verify Factory Configuration

```bash
# Check factory token balance (should be non-zero after funding)
stellar contract invoke \
  --id $XLM_SAC_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  balance \
  --id $FACTORY_ADDRESS
```

### Verify Invite Validity

```bash
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  is_invite_valid \
  --invite_code $INVITE_CODE

# Expected: true
```

### Verify Address Prediction

```bash
# Predict the address for a hypothetical agent key
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  get_address \
  --agent_key <32-byte-hex-agent-public-key>

# Expected: C... address (deterministic — same key always produces same address)
```

---

## 4. Running E2E Tests

### Setup

The E2E test script uses different env vars from the deployment scripts:

```bash
# For e2e-test.js:
OWNER_SECRET=SDXXXX...                    # Owner's secret key (required)
FACTORY_ADDRESS=CDUIY5ADZ6...             # Override factory address (optional)
TESTNET_RPC=https://soroban-testnet.stellar.org  # Override RPC URL (optional)

# For deploy-testnet.js, fund-factory.js, create-invite.js:
STELLAR_TESTNET_SECRET=SDXXXX...          # Deployer/owner secret key
```

### Running the Test Script

```bash
OWNER_SECRET=SDXXXX... node scripts/e2e-test.js
```

### What Each Test Validates

The E2E test script runs 23 tests across 5 phases:

| Phase | Tests | What It Validates |
|-------|-------|-------------------|
| **A: Setup** | 1-3 | RPC health, factory contract exists, agent keypair generation + address prediction |
| **B: Invite + Onboarding** | 4-10 | Owner creates invite, invite validity check, `factory.create()` deploys + funds agent, invite burned, agent status Active, balance matches funding |
| **C: Agent Operations** | 11-13 | Real `__check_auth` — agent transfers under limit (pass), over limit (rejected), balance verification |
| **D: Auth Rejections** | 14-16 | Unknown signer rejected, agent key spoofing rejected, invite replay rejected |
| **E: Owner Operations** | 17-23 | Owner freeze (blocks agent), unfreeze (restores agent), agent transfer after unfreeze, owner drain, final balance ~0 |

### Expected Output

A successful run produces output like:

```
======================================================================
  Lumenitos Agent Wallet — End-to-End Tests (Testnet)
======================================================================

  RPC:             https://soroban-testnet.stellar.org
  Factory:         CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP
  Owner:           GBXYZ...
  XLM SAC:         CDLZFC...

--- Phase A: Setup ---
  [1] Connect to testnet RPC ... PASS (ledger 12345)
  [2] Verify factory contract exists (read owner) ... PASS (owner = GBXYZ...)
  [3] Generate fresh agent keypair ... PASS (agent G... = GABCDE..., predicted contract = CXXXX...)

--- Phase B: Invite + Onboarding ---
  [4] Owner creates invite code with policy (per_tx_limit=10 XLM) ... PASS (tx a1b2c3...)
  [5] Verify invite is valid ... PASS (valid=true)
  [6] Call factory.create() to deploy agent contract ... PASS (tx d4e5f6..., deployed at CXXXX...)
  [7] Verify invite is burned after use ... PASS (valid=false)
  [8] Verify agent contract exists at predicted address ... PASS
  [9] Verify agent status is Active ... PASS (status=Active)
  [10] Verify agent balance matches funding amount (~100 XLM) ... PASS (balance=100 XLM)

--- Phase C: Agent Operations (real __check_auth) ---
  [11] Agent transfers 5 XLM (under 10 XLM per_tx_limit) — should succeed ... PASS (tx g7h8i9...)
  [12] Agent transfers 15 XLM (over 10 XLM limit) — should fail ... PASS (correctly rejected: ...)
  [13] Agent balance reduced after 5 XLM transfer ... PASS (balance=95 XLM)

--- Phase D: Auth Rejection Tests (real __check_auth negative paths) ---
  [14] Unknown signer rejected by __check_auth ... PASS (correctly rejected: ...)
  [15] Agent key spoofing rejected (agent_key arg != signer) ... PASS (correctly rejected: ...)
  [16] Invite replay rejected (burned invite code) ... PASS (correctly rejected: ...)

--- Phase E: Owner Operations ---
  [17] Owner freezes agent ... PASS (tx j0k1l2...)
  [18] Verify agent status is Frozen ... PASS (status=Frozen)
  [19] Agent transfer while frozen — should fail ... PASS (correctly rejected: ...)
  [20] Owner unfreezes agent ... PASS (tx m3n4o5...)
  [21] Agent transfers 2 XLM after unfreeze — should succeed ... PASS (tx p6q7r8...)
  [22] Owner drains remaining agent funds ... PASS (drained 88 XLM, tx s9t0u1...)
  [23] Verify agent balance is ~0 after drain ... PASS (balance=0 XLM)

======================================================================
  Results: 23 passed, 0 failed, 23 total
======================================================================
```

### Troubleshooting Common Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `invokeHostFunctionTrapped` | Signature verification failed in `__check_auth` | Ensure the preimage hash uses the same `signatureExpirationLedger` as the credentials (see REFLECTIONS.md Challenge 2) |
| `invokeHostFunctionResourceLimitExceeded` | Instruction limit too low for ed25519 verification | The SDK bumps instructions by +1M automatically; if using raw transactions, add buffer manually |
| `invalid or expired invite code` | Invite TTL expired (~7 days) or code was already used | Create a fresh invite; check `is_invite_valid()` first |
| `Error: insufficient balance` | Factory token pool is empty | Fund the factory with more tokens |
| `Error: Network request failed` | Testnet RPC is down or rate-limited | Wait and retry; testnet `https://soroban-testnet.stellar.org` has occasional outages |
| `Error(Auth, InvalidAction)` | Wrong signature format for account type | Contract accounts use raw `BytesN<64>`; classic accounts use `Vec<AccountEd25519Signature>` (see REFLECTIONS.md Challenge 11) |
| `extendFootprintTtlMalformed` | TTL extension value too large | Use `extendTo` of 500,000 ledgers max on testnet (see REFLECTIONS.md Challenge 9) |

---

## 5. Agent Quickstart

This section shows how an AI agent onboards and starts operating using the TypeScript SDK.

### How Transaction Submission Works

Agents don't pay their own transaction fees. Instead, a self-hosted **OpenZeppelin Relayer** submits transactions on the agent's behalf:

```
Agent signs auth entries  ──►  OZ Relayer builds + pays for tx  ──►  Soroban verifies via __check_auth
    (ed25519 signature)           (relayer's KMS-secured account)       (agent's contract account)
```

This is the `relayer` pattern. The agent's Stellar account (G...) never needs to exist — only the agent's contract account (C...) matters. The relayer manages its own funded account via KMS — no private keys are shared between agent and relayer.

> **Prerequisites:** Run a self-hosted [OZ Relayer](https://docs.openzeppelin.com/relayer/1.4.x/stellar) (Docker + Redis). See the OZ Relayer docs for setup instructions.

### Step 1: Generate Keypair and Onboard

```typescript
import { AgentWallet } from '@/lib/agent-sdk';

// Onboard a new agent with an invite code
// The OZ Relayer pays transaction fees on the agent's behalf
const wallet = await AgentWallet.create({
  network: 'testnet',
  inviteCode: 'a3f8c1d2e5b7...',  // 64 hex chars, provided by owner
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});

// The wallet is now deployed, funded, and ready
console.log('Agent public key:', wallet.publicKey);
console.log('Contract address:', wallet.address);
console.log('Secret key (store securely):', wallet.secretKey);
```

### Step 2: Reconnect an Existing Agent

```typescript
// If the agent already has a deployed contract, reconnect with its secret
// Include relayer config so the relayer continues paying fees
const wallet = AgentWallet.fromSecret('SDAGENT...', {
  network: 'testnet',
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});
```

### Step 3: Check Balance

```typescript
const balance = await wallet.getBalance('native');
console.log(`Balance: ${balance} XLM`);
// Output: "Balance: 100.0000000 XLM"
```

### Step 4: Transfer Tokens

```typescript
const result = await wallet.transfer({
  token: 'native',           // 'native' for XLM, or a C... token address
  to: 'GBXYZ...',            // destination address
  amount: '50.0',            // human-readable amount
});

console.log('Transfer TX:', result.hash);
```

### Step 5: Invoke an External Contract

```typescript
import * as StellarSdk from '@stellar/stellar-sdk';

const result = await wallet.invoke({
  contract: 'CCONTRACT...',            // target contract address
  fnName: 'some_function',             // function to call
  args: [                              // ScVal arguments
    StellarSdk.nativeToScVal('hello', { type: 'symbol' }),
  ],
  spendToken: 'native',                // token the call will spend
  spendAmount: '10.0',                 // declared spend (for policy check)
});
```

### Step 6: Check Status and Policy

```typescript
const status = await wallet.getStatus();
// Returns: 'active' or 'frozen'

const policy = await wallet.getPolicy();
// Returns: { token_limits: [...], access: 'AllowAll', expiry_ledger: 0 }
```

### Step 7: DeFi Operations (Swap, Supply, Withdraw)

```typescript
// Swap on a DEX
await wallet.swap({
  dex: 'CDEX_CONTRACT...',
  fnName: 'swap',
  args: [/* DEX-specific args */],
  tokenIn: 'native',
  amountIn: '100.0',
});

// Supply to a lending protocol
await wallet.supply({
  protocol: 'CBLEND_POOL...',
  fnName: 'supply',
  args: [/* protocol-specific args */],
  token: 'native',
  amount: '200.0',
});

// Withdraw from a lending protocol
await wallet.withdraw({
  protocol: 'CBLEND_POOL...',
  fnName: 'withdraw',
  args: [/* protocol-specific args */],
});
```

---

## 6. Owner Operations Guide

All owner operations require the owner's secret key and authorization. These can be executed via the Stellar CLI or programmatically.

### Creating Invite Codes

#### Single Invite

```bash
# Generate a random invite code
INVITE_CODE=$(openssl rand -hex 32)

# Create invite with funding of 100 XLM and 50 XLM per-tx limit
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  create_invite \
  --invite_code $INVITE_CODE \
  --config '{"funding": [{"token": "'$XLM_SAC_ADDRESS'", "amount": 1000000000}], "policy": {"token_limits": [{"token": "'$XLM_SAC_ADDRESS'", "per_tx_limit": 500000000}], "access": "AllowAll", "expiry_ledger": 0}}'
```

#### Batch Invites (up to 50)

```bash
# Generate multiple codes
CODE1=$(openssl rand -hex 32)
CODE2=$(openssl rand -hex 32)
CODE3=$(openssl rand -hex 32)

stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  create_invites \
  --codes "[\"$CODE1\", \"$CODE2\", \"$CODE3\"]" \
  --config '{"funding": [{"token": "'$XLM_SAC_ADDRESS'", "amount": 1000000000}], "policy": {"token_limits": [{"token": "'$XLM_SAC_ADDRESS'", "per_tx_limit": 500000000}], "access": "AllowAll", "expiry_ledger": 0}}'
```

Invite codes are stored in temporary storage with a ~7 day TTL. After that, unused invites automatically expire.

### Monitoring Agents

#### Check Agent Status

```bash
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  get_agent_status \
  --agent_key $AGENT_PUBLIC_KEY_BYTES

# Returns: "Active" or "Frozen"
```

#### Check Agent Policy

```bash
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  get_policy \
  --agent_key $AGENT_PUBLIC_KEY_BYTES

# Returns: { token_limits: [...], access: "AllowAll", expiry_ledger: 0 }
```

#### Check Agent Balance

```bash
stellar contract invoke \
  --id $XLM_SAC_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  balance \
  --id $AGENT_CONTRACT_ADDRESS
```

#### Check Contract Owner

```bash
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  get_owner
```

### Freezing and Unfreezing Agents

Freezing is reversible. A frozen agent cannot execute any wrapper functions (`agent_transfer`, `agent_invoke`, etc.) but its funds are preserved.

```bash
# Freeze an agent
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  freeze_agent \
  --agent_key $AGENT_PUBLIC_KEY_BYTES

# Unfreeze an agent
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  unfreeze_agent \
  --agent_key $AGENT_PUBLIC_KEY_BYTES
```

### Revoking Agents

Revoking is permanent. The agent key is removed and cannot be re-added.

```bash
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  revoke_agent \
  --agent_key $AGENT_PUBLIC_KEY_BYTES
```

### Draining Funds

Pull tokens from an agent account or the factory back to the owner (or any destination).

```bash
# Drain from an agent account
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  drain \
  --token_address $XLM_SAC_ADDRESS \
  --destination $OWNER_PUBLIC_KEY \
  --amount 5000000000  # 500 XLM

# Drain from factory token pool
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  drain \
  --token_address $XLM_SAC_ADDRESS \
  --destination $OWNER_PUBLIC_KEY \
  --amount 10000000000  # 1000 XLM
```

### Updating Agent Policy

Change an agent's token limits, access control, or expiry without redeploying.

```bash
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  update_policy \
  --agent_key $AGENT_PUBLIC_KEY_BYTES \
  --policy '{"token_limits": [{"token": "'$XLM_SAC_ADDRESS'", "per_tx_limit": 200000000}], "access": {"AllowOnly": ["'$SOME_CONTRACT'"]}, "expiry_ledger": 0}'
```

### Key Rotation

#### Rotate Agent Key

Replace an agent's key while preserving its status and policy. Useful if an agent key is compromised.

```bash
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  rotate_agent_key \
  --old_key $OLD_AGENT_KEY_BYTES \
  --new_key $NEW_AGENT_KEY_BYTES
```

#### Rotate Owner Key

Change the owner of an agent contract or the factory.

```bash
# Rotate agent contract owner
stellar contract invoke \
  --id $AGENT_CONTRACT_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  rotate_owner \
  --new_owner $NEW_OWNER_KEY_BYTES

# Rotate factory owner
stellar contract invoke \
  --id $FACTORY_ADDRESS \
  --source-account $STELLAR_TESTNET_SECRET \
  --network testnet \
  -- \
  rotate_owner \
  --new_owner $NEW_OWNER_ADDRESS \
  --new_owner_key $NEW_OWNER_KEY_BYTES
```

---

## 7. Known Issues & Limitations

### Testnet-Specific Quirks

| Issue | Details |
|-------|---------|
| **Friendbot rate limiting** | Testnet friendbot may throttle funding requests. Space them out or use a pre-funded account. |
| **RPC outages** | `soroban-testnet.stellar.org` has occasional downtime. Retry with exponential backoff. |
| **TTL extension limits** | Maximum `extendTo` on testnet is ~500,000 ledgers (~35 days), not the theoretical 3.1M. Using higher values causes `extendFootprintTtlMalformed`. |
| **Ledger resets** | Testnet resets periodically, wiping all deployed contracts. Redeploy after a reset. |
| **Transaction fees** | Testnet fees are negligible but simulated resource costs still apply. Set fee to at least `100000` stroops for contract calls. |

### The mock_all_auths Caveat

All 45 unit tests in Phase 1 use `mock_all_auths()`, which bypasses the real `__check_auth` signature verification. This means:

**What is tested at unit level:**
- All business logic (policy enforcement, token limits, access control, freeze/revoke/expiry)
- State management (storage reads/writes, TTL extensions)
- Event emission
- Integration between factory and agent contracts

**What is NOT tested until Phase 3 E2E:**
- Real ed25519 signature verification in `__check_auth`
- The `{ public_key, signature }` ScVal map format that the SDK sends
- Agent key matching (verifying `agent_key` arg matches actual signer)
- External contract auth blocking (agent cannot directly authorize external calls)
- Instruction limit requirements for on-chain signature verification (+~1M instructions)

Phase 3 E2E tests on testnet exercise the real auth path. This is the critical validation gap that Phase 3 closes.

### Accepted Risks

These are documented in the design and accepted as trade-offs:

| Risk | Mitigation |
|------|------------|
| **Balance = budget** (no cumulative spending cap) | Per-tx limit bounds each transaction; monitor via events for anomalous spending patterns |
| **`agent_withdraw` has no spend check** | Value flows into the account, not out. Protocol-level withdrawal restrictions apply. |
| **`per_tx_limit: 0` means unlimited** | Explicit design choice; use non-zero values in production policies |
| **Spend declaration in `agent_invoke` is trust-based** | Agent declares how much it will spend; actual spend depends on the called contract. Use `AllowOnly` to restrict callable contracts. |
| **`DenyOnly` access control is bypassable** | An agent could use a proxy contract to reach denied contracts. Use `AllowOnly` for real security. |
| **Invite codes are not bound to a specific agent key** | If intercepted, anyone can use the code. However, the resulting account is controlled by the owner, who can immediately revoke. |
| **No rate limiting** | An agent can send many transactions rapidly up to its balance. Monitor events and freeze if needed. |
| **Unsolicited inbound tokens inflate budget** | Anyone can send tokens to the agent contract. Monitor and drain excess. |

### Transaction Fee Sponsorship

Agents don't pay their own transaction fees. The SDK uses a self-hosted [OpenZeppelin Relayer](https://docs.openzeppelin.com/relayer/1.4.x/stellar) to sponsor fees on behalf of agents:

```typescript
const wallet = await AgentWallet.create({
  inviteCode: '...',
  network: 'testnet',
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});
```

The relayer manages its own funded Stellar account via KMS. No private keys are shared between agent and relayer. The agent only signs Soroban auth entries; the relayer builds, fee-bumps, and submits the transaction.

> **Historical note:** The SDK previously supported OZ Channels (hosted gasless relay via OpenZeppelin Defender), but that service shut down. The `GaslessSubmitter` and `gasless` config are removed. The self-hosted OZ Relayer (`RelayerSubmitter`) is the replacement.

### XLM SAC Transfer Destination Requirement

The XLM Stellar Asset Contract (SAC) `transfer` function requires the destination account to exist on-chain. Unlike classic Stellar `create_account` operations, SAC transfers cannot create new accounts. If an agent tries to send XLM to an unfunded G... address, the transaction will fail with `"account entry is missing"`.

**Workaround:** Send to existing accounts, or fund the destination via friendbot (testnet) / `create_account` operation first. Contract addresses (C...) do not have this restriction.

### SDK / Tooling Challenges

Documented in detail in `REFLECTIONS.md`. Key items for deployers:

1. **Do not use `authorizeEntry()`** for contract accounts. It only works for classic (G...) accounts. Build the preimage manually.
2. **Never re-simulate after signing auth entries.** Re-simulation generates new nonces, invalidating signatures.
3. **Bump instruction limits** after assembling transactions that involve `__check_auth`. Add +1M instructions to the simulation result.
4. **Signature format differs by account type.** Contract accounts use raw `BytesN<64>`. Classic accounts use `Vec<{public_key, signature}>`.
5. **Use `response.returnValue`** instead of parsing `resultMetaXdr.v3()`. The SDK v14 `getTransaction()` response provides `returnValue` directly.

---

## Appendix: Quick Reference

### Environment Variables

| Variable | Example | Where Used |
|----------|---------|------------|
| `STELLAR_TESTNET_SECRET` | `SDXXX...` | Deploy scripts, CLI commands |
| `NEXT_PUBLIC_SIMPLE_ACCOUNT_WASM_HASH` | `7a1b2c...` | App, SDK (contract address derivation) |
| `NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS` | `CDUIY5...` | App, SDK (factory calls) |

### Key Addresses (Testnet)

| Item | Address |
|------|---------|
| Factory (current) | `CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Friendbot | `https://friendbot.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |

### Amount Conversion

All on-chain amounts are in stroops (7 decimal places for XLM):

| Human | Stroops |
|-------|---------|
| 1 XLM | 10,000,000 |
| 100 XLM | 1,000,000,000 |
| 0.5 XLM | 5,000,000 |

The SDK handles conversion automatically when you pass human-readable strings like `'50.0'`.
