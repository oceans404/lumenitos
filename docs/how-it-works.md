# Lumenitos Agent Wallet: How It Works

A comprehensive guide to the Lumenitos agent wallet system -- from architecture to running it yourself.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [How the OZ Relayer Works](#3-how-the-oz-relayer-works)
4. [Transaction Flow (Step by Step)](#4-transaction-flow-step-by-step)
5. [How to Try It Yourself](#5-how-to-try-it-yourself)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. System Overview

### What is Lumenitos Agent Wallet?

Lumenitos is a system for giving autonomous software agents their own Stellar smart wallet. An agent (an AI, a bot, a script) gets a fully functional on-chain account with its own keypair, funded balance, and policy constraints -- all without the owner ever seeing the agent's private key, and without the agent needing XLM to pay transaction fees.

The agent can send tokens, trade on DEXes, supply to lending protocols, and interact with any Soroban smart contract -- all within the boundaries the owner defines.

### The Three Components

**1. Soroban Contracts (on-chain enforcement)**

Two contracts deployed on Stellar:

- **`simple_account`** -- The agent's smart wallet. Implements Soroban's custom account interface (`__check_auth`) to verify ed25519 signatures and enforce per-agent policies. Exposes five "wrapper" functions (`agent_transfer`, `agent_invoke`, `agent_swap`, `agent_supply`, `agent_withdraw`) that are the only operations an agent can authorize.

- **`account_factory`** -- Deploys new agent wallets in a single call. Manages invite codes that carry funding amounts and policy configuration. When an agent redeems an invite, the factory deploys a contract, configures it with the owner's key, the agent's key, and the policy, then funds it from the factory's token pool.

**2. TypeScript SDK (client-side logic)**

Two layers:

- **`lib/soroban-custom-account/`** -- A generic toolkit for Soroban custom accounts. Handles ed25519 auth entry signing, transaction simulation, and two submission backends (direct and relayer).

- **`lib/agent-sdk/`** -- The Lumenitos-specific facade. `AgentWallet` is the high-level class an agent uses. It wraps contract calls, handles the invite system, and manages the relayer connection.

**3. Self-Hosted OZ Relayer (fee sponsorship)**

A Rust service (from OpenZeppelin) running in Docker alongside Redis. It accepts contract invocation requests over HTTP, builds transactions using its own funded Stellar account, pays the fees, and submits to the network. The agent never needs XLM for gas.

### Security Model: Who Holds What Keys?

| Entity | Keys it holds | What it can do |
|--------|--------------|----------------|
| **Owner** | Owner ed25519 keypair | Full control: create invites, freeze/revoke agents, drain funds, rotate keys. Pays fees for admin operations directly. |
| **Agent** | Agent ed25519 keypair (self-generated) | Call wrapper functions only. Cannot call admin functions, cannot authorize external contract calls directly, cannot modify its own policy. |
| **Relayer** | Relayer Stellar keypair (in encrypted keystore) | Pay transaction fees and submit envelopes. Cannot authorize agent operations -- it never sees the agent's private key. Cannot authorize owner operations. |

The critical security property: **the agent never sees the relayer's keys, and the relayer never sees the agent's keys.** The agent signs only the auth entries (proving intent). The relayer signs only the transaction envelope (paying fees). The on-chain `__check_auth` function verifies the agent's signature independently.

---

## 2. Architecture Diagram

```
 OWNER (human / service)                         STELLAR NETWORK
 ========================                         ================

 Holds owner keypair                              Soroban Runtime
 Pays own fees (direct)                           +-----------------------+
                                                  |                       |
   create_invite()  -------> [ Factory Contract ] |  Validates invite     |
   fund_factory()            | Token pool (XLM) | |  Burns code           |
   freeze/revoke/drain       | Invite storage   | |  Deploys contract     |
                             +---------+---------+ |  Funds from pool      |
                                       |           |                       |
                                deploys via        |                       |
                              create(key, code)    |                       |
                                       |           |                       |
                                       v           |                       |
                             +-------------------+ |                       |
                             | Agent Contract    | |                       |
                             | (simple_account)  | |  __check_auth:        |
                             |                   | |    verify ed25519 sig |
                             | - Owner key       | |    check agent status |
                             | - Agent key       | |    enforce whitelist  |
                             | - Policy          | |    enforce policy     |
                             | - Token balances  | |                       |
                             +--------+----------+ +-----------------------+
                                      ^
                                      |
                              Soroban invocation
                            (built by relayer from
                             agent's signed auth)
                                      |
                                      |
 AGENT PROCESS                  OZ RELAYER (Docker)
 =============                  ===================

 Holds agent keypair            Holds relayer keypair
 Has NO funded account          Has funded Stellar account
                                Runs as: Docker + Redis
   1. Build operation
   2. Simulate via RPC     ---->  Soroban RPC
   3. Sign auth entries          (simulation)
   4. POST to relayer      ---->
                                  5. Build transaction
                                  6. Pay fees
                                  7. Sign envelope
                                  8. Submit to Stellar
   9. Poll for status      ---->
                                  10. Return confirmation
```

### Data Flow Summary

```
Agent signs:     auth entries (proving "I authorize agent_transfer with these args")
Relayer signs:   transaction envelope (proving "I'll pay the fee for this transaction")
Soroban verifies: __check_auth called with agent's signature + auth context
                  -> ed25519_verify(agent_public_key, payload, agent_signature)
                  -> check agent is Active, not frozen, not expired
                  -> check function is whitelisted
                  -> check agent_key arg matches signer (no spoofing)
```

---

## 3. How the OZ Relayer Works

### What It Is

The OpenZeppelin Relayer is a self-hosted Rust service that acts as a transaction submitter for Stellar/Soroban. It runs as two Docker containers:

- **`relayer`** -- The Rust service itself. Listens on port 8080, accepts contract invocation requests via a REST API, builds Stellar transactions, signs them with its own key, and submits them to the network.
- **`redis`** -- Backing store for transaction state, nonce management, and queue processing.

Configuration lives in `relayer/config/config.json`. The relayer's signing key is stored in an encrypted keystore file at `relayer/config/keys/local-signer.json`, decrypted at runtime using the `KEYSTORE_PASSPHRASE` environment variable.

### What It Does

The relayer solves a bootstrapping problem: a newly created agent has no funded Stellar account -- it only has a Soroban contract. Soroban contracts cannot submit transactions themselves. Someone needs to build, sign, and pay for the transaction envelope.

The relayer:

1. Accepts an operation description via HTTP (contract address, function name, args, signed auth entries)
2. Builds a Stellar transaction with the operation
3. Pays the fee from its own funded account
4. Signs the transaction envelope
5. Submits to the Stellar network
6. Tracks status (pending -> sent -> submitted -> confirmed)
7. Returns the result to the caller

### Why It Is Needed

Without the relayer, every agent would need a funded Stellar account to pay transaction fees. This creates a chicken-and-egg problem:

- Agent contracts hold tokens (e.g., XLM) as Soroban balances
- But submitting transactions requires a classic Stellar account with XLM
- An agent's contract balance cannot pay for the transaction that invokes it

The relayer breaks this dependency. The agent only needs to sign auth entries (proving its intent). The relayer handles everything else.

### The HTTP API Flow

**Endpoint:** `POST /api/v1/relayers/{relayer_id}/transactions`

**Request:**

```json
{
  "network": "testnet",
  "operations": [
    {
      "type": "invoke_contract",
      "contract_address": "CABC...",
      "function_name": "agent_transfer",
      "args": [
        { "bytes": "a1b2c3..." },
        { "address": "CDLZFC..." },
        { "address": "GBXYZ..." },
        { "i128": { "hi": "0", "lo": "50000000" } }
      ],
      "auth": {
        "type": "xdr",
        "entries": ["AAAAAQAAAA...base64..."]
      }
    }
  ]
}
```

**Headers:**

```
Content-Type: application/json
Authorization: Bearer <API_KEY>
```

**Response (wrapped in ApiResponse):**

```json
{
  "success": true,
  "data": {
    "id": "tx-uuid-here",
    "hash": null,
    "status": "pending",
    "source_account": "GRELAYER...",
    "fee": 100,
    "relayer_id": "stellar-testnet"
  }
}
```

**Polling:** `GET /api/v1/relayers/{relayer_id}/transactions/{tx_id}`

Status progresses: `pending` -> `sent` -> `submitted` -> `confirmed` (or `failed`).

### Key Security Property

The agent and relayer never share private keys:

- **Agent private key** stays on the agent. The relayer receives only the signed auth entry XDR (the output of signing, not the key).
- **Relayer private key** stays in the encrypted keystore. The agent never sees it. The relayer only uses it to sign the outer transaction envelope.

A compromised relayer cannot steal agent funds (it cannot forge agent auth signatures). A compromised agent cannot drain the relayer's account (it has no access to the relayer key). The worst a compromised relayer can do is refuse to submit transactions.

---

## 4. Transaction Flow (Step by Step)

Here is exactly what happens when an agent calls `wallet.transfer()` to send 5 XLM:

### Step 1: SDK Builds the Soroban Operation

The `AgentWallet.transfer()` method calls `AccountClient.buildTransfer()`, which constructs a Soroban `invokeHostFunction` operation targeting the agent's contract:

```
agent_contract.call("agent_transfer", agent_key, token_address, destination, amount)
```

This creates an XDR operation but does NOT yet build a transaction.

### Step 2: SDK Simulates Against RPC

The `RelayerSubmitter.submit()` method builds a dummy transaction using `SIMULATION_ACCOUNT` (a well-known zero account `GAAAAAA...WHF`) as the source. This transaction is sent to the Soroban RPC `simulateTransaction` endpoint.

Simulation returns:
- **Auth entries** -- the authorization entries that need to be signed
- **Resource estimates** -- CPU instructions, read/write bytes, etc.
- **Latest ledger** -- used to compute auth expiry

### Step 3: Agent Signs Auth Entries with ed25519

The SDK takes each auth entry from simulation and signs it:

1. Extract the nonce from the auth entry's address credentials
2. Build a `HashIdPreimage::envelopeTypeSorobanAuthorization` containing:
   - Network ID (hash of network passphrase)
   - Nonce
   - Signature expiration ledger (`latestLedger + 60`)
   - Root invocation tree
3. Hash the preimage (SHA-256)
4. Sign the hash with the agent's ed25519 private key
5. Pack the signature into the Lumenitos format: `{ public_key: BytesN<32>, signature: BytesN<64> }`
6. Replace the auth entry's `signature` field with this ScVal

The agent's private key is used here and nowhere else.

### Step 4: SDK Extracts Contract Address, Function Name, Args

From the original XDR operation, the SDK extracts:
- `contract_address`: the agent's contract (C... address)
- `function_name`: `"agent_transfer"`
- `args`: the four ScVal arguments

These are converted from binary XDR to the JSON ScVal format the relayer expects (e.g., `{"address": "GBXYZ..."}`, `{"i128": {"hi": "0", "lo": "50000000"}}`).

### Step 5: SDK POSTs to OZ Relayer

The SDK sends the operation details and signed auth entries to the relayer:

```
POST http://localhost:8080/api/v1/relayers/stellar-testnet/transactions
Authorization: Bearer <API_KEY>

{
  "network": "testnet",
  "operations": [{
    "type": "invoke_contract",
    "contract_address": "CABC...",
    "function_name": "agent_transfer",
    "args": [...JSON ScVals...],
    "auth": {
      "type": "xdr",
      "entries": ["...base64 XDR of signed auth entries..."]
    }
  }]
}
```

### Step 6: Relayer Builds Transaction, Pays Fees, Submits

The relayer:
1. Loads its own funded Stellar account as the transaction source
2. Builds a Stellar transaction with the `invokeHostFunction` operation
3. Attaches the signed auth entries from the request
4. Signs the transaction envelope with its own key
5. Submits to the Stellar network

The relayer's policies control: max fee (default 1 XLM / 10,000,000 stroops), minimum relayer balance (5 XLM), timeout (30 seconds).

### Step 7: Soroban Runtime Calls `__check_auth`

When the transaction executes on-chain, Soroban sees that the agent contract's address is used in a `require_auth()` call (inside `agent_transfer`). It invokes the contract's `__check_auth` function with:
- `signature_payload`: the SHA-256 hash of the authorization preimage
- `signature`: the `{ public_key, signature }` struct the agent signed in Step 3
- `auth_context`: the list of contract calls being authorized

### Step 8: `__check_auth` Verifies Signature and Enforces Policy

The contract's `__check_auth`:

1. **Verifies the ed25519 signature**: `env.crypto().ed25519_verify(public_key, payload, signature)` -- if this fails, the entire transaction reverts.

2. **Checks if signer is owner**: If yes, allow everything. Return immediately.

3. **Checks if signer is a known agent**: Loads agent status. If not found, panics ("unknown agent"). If frozen, panics ("agent is frozen"). If expired, panics ("agent key expired").

4. **Enforces the function whitelist**: For each entry in `auth_context`:
   - Must target THIS contract (not an external one) -- blocks direct external auth
   - Must be one of: `agent_transfer`, `agent_invoke`, `agent_swap`, `agent_supply`, `agent_withdraw`
   - The `agent_key` argument (first arg) must match the actual signer's public key -- prevents one agent from acting as another

### Step 9: Transaction Executes

After `__check_auth` returns successfully, the `agent_transfer` function body runs:

1. Loads the agent's policy
2. Checks the token is in the policy's `token_limits` list
3. Checks the amount is under the `per_tx_limit`
4. Checks the destination is allowed by the access control policy
5. Calls `token.transfer(self_contract, destination, amount)` to move the tokens
6. Emits a `(transfer,)` event

### Step 10: SDK Polls Relayer for Confirmation

Back on the client side, the SDK polls the relayer's status endpoint every 2 seconds:

```
GET /api/v1/relayers/stellar-testnet/transactions/{tx_id}
```

Status progresses through: `pending` -> `sent` -> `submitted` -> `confirmed`.

Once `confirmed`, the SDK returns a `TransactionResult` with the hash and status. The transfer is complete.

---

## 5. How to Try It Yourself

Complete instructions to go from zero to a working agent wallet on Stellar testnet.

### Prerequisites

- **Node.js 18+** (with native `fetch` support)
- **Docker Desktop** (for the OZ Relayer)
- **Rust toolchain** with the `wasm32v1-none` target:
  ```bash
  rustup target add wasm32v1-none
  ```
- **Stellar CLI** (`stellar`): https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli

### Step 1: Clone and Install

```bash
git clone https://github.com/ArsEarth/lumenitos.git
cd lumenitos
npm install
```

### Step 2: Build Contracts

Build both Soroban contracts to WASM. The factory includes the account WASM at compile time, so build `simple_account` first:

```bash
cd contracts/simple_account
stellar contract build
cd ../account_factory
stellar contract build
cd ../..
```

Verify the WASM files exist:

```bash
ls -la contracts/simple_account/target/wasm32v1-none/release/simple_account.wasm
ls -la contracts/account_factory/target/wasm32v1-none/release/account_factory.wasm
```

### Step 3: Deploy to Testnet

The deploy script uploads both WASMs and deploys the factory contract. If you do not provide a secret key, it generates a fresh keypair and funds it via friendbot:

```bash
node scripts/deploy-testnet.js
```

Or with an existing key:

```bash
STELLAR_TESTNET_SECRET=SXXX... node scripts/deploy-testnet.js
```

Save the output. You will need:
- The **owner secret key** (printed if a new keypair was generated)
- The **factory contract address** (starts with `C`)

Example output:

```
  Factory contract address:  CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP

  NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS=CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP
```

### Step 4: Fund the Factory

The factory needs XLM in its token pool to fund new agents. Transfer XLM from the owner account:

```bash
STELLAR_TESTNET_SECRET=SXXX... node scripts/fund-factory.js CFACTORY_ADDRESS_HERE
```

Default: 1000 XLM. Custom amount:

```bash
STELLAR_TESTNET_SECRET=SXXX... node scripts/fund-factory.js CFACTORY... 5000
```

### Step 5: Set Up the OZ Relayer

This is the most involved step. The relayer needs an encrypted keystore file, a funded account, and proper configuration.

**5a. Generate the keystore**

The OZ Relayer uses the `oz-keystore` crate, which produces an Ethereum-style encrypted JSON keystore with a keccak256 MAC. You need the Rust `oz-keystore` tool to generate it.

> **Important:** Do not try to generate the keystore with a Node.js script. The OZ Relayer's keystore format uses keccak256 for the MAC, not SHA-256. A Node.js implementation using `@ethereumjs/wallet` or similar will produce a MAC mismatch error at runtime. Use the Rust tool.

Clone the OZ Relayer repo and use its key generation example:

```bash
# In a separate directory:
git clone https://github.com/OpenZeppelin/openzeppelin-relayer.git
cd openzeppelin-relayer

# Generate a keystore for Stellar:
cargo run --example create_key -- \
  --passphrase "LumenitosDevPass123!" \
  --output /path/to/lumenitos/relayer/config/keys/local-signer.json \
  --network stellar
```

Alternatively, if the relayer repo has an `oz-keygen` binary or a different generation path, follow their documentation.

The keystore file will contain the relayer's Stellar keypair, encrypted with the passphrase.

**5b. Note the relayer's public key**

The keystore generation will print the Stellar public key (G...). Save it.

**5c. Fund the relayer account via friendbot**

```bash
curl "https://friendbot.stellar.org?addr=GRELAYER_PUBLIC_KEY_HERE"
```

The relayer needs XLM to pay transaction fees. Friendbot gives 10,000 XLM on testnet.

**5d. Configure environment**

```bash
cd relayer
cp .env.example .env
```

Edit `.env` with your values:

```
API_KEY=test-api-key-lumenitos-dev-32chars!!
WEBHOOK_SIGNING_KEY=test-webhook-key-lumenitos-dev-32ch!!
KEYSTORE_PASSPHRASE=LumenitosDevPass123!
RUST_LOG=info
```

The `API_KEY` must be at least 32 characters. This is what the SDK uses to authenticate with the relayer.

**5e. Start Docker**

```bash
cd relayer
docker compose up -d
```

**5f. Verify the relayer is running**

```bash
curl -s -H "Authorization: Bearer test-api-key-lumenitos-dev-32chars\!\!" \
  http://localhost:8080/api/v1/relayers/stellar-testnet | jq .
```

> **Note on special characters in bash:** If your API key contains `!` or other special characters, escape them with `\` in bash or use single quotes around the entire header value. See [Troubleshooting](#6-troubleshooting).

You should see a JSON response with `"success": true`.

### Step 6: Create an Invite Code

```bash
STELLAR_TESTNET_SECRET=SXXX... node scripts/create-invite.js CFACTORY_ADDRESS_HERE
```

Options:

```bash
# Custom funding and limits:
STELLAR_TESTNET_SECRET=SXXX... node scripts/create-invite.js CFACTORY... \
  --xlm 200 \
  --per-tx-limit 50 \
  --count 5
```

Save the invite code(s) printed in the output (64-character hex strings). Each is single-use and expires after ~7 days.

### Step 7: Run the E2E Tests

The E2E test exercises the full flow: RPC connectivity, relayer health, agent onboarding via factory, agent status verification, balance verification, agent transfer via relayer, and balance verification after transfer.

```bash
OWNER_SECRET=SXXX... \
RELAYER_API_KEY="test-api-key-lumenitos-dev-32chars!!" \
FACTORY_ADDRESS=CFACTORY... \
  node scripts/e2e-test-relayer.js
```

Expected output (all 9 tests pass):

```
======================================================================
  Lumenitos Agent Wallet -- E2E Relayer Test (Testnet)
======================================================================

--- Phase A: Setup & Connectivity ---
  [1] Connect to testnet RPC ... PASS (ledger 12345)
  [2] Relayer is reachable ... PASS (OK)
  [3] Generate fresh agent keypair (unfunded) ... PASS

--- Phase B: Invite + Onboarding ---
  [4] Owner creates invite code (direct submission) ... PASS
  [5] Agent onboards via factory.create() through RELAYER ... PASS
  [6] Verify agent contract is Active ... PASS
  [7] Verify agent balance matches funding (~100 XLM) ... PASS

--- Phase C: Agent Transfer via Relayer ---
  [8] Agent transfers 5 XLM via RELAYER (agent has no Stellar account) ... PASS
  [9] Agent balance reduced after 5 XLM transfer ... PASS

======================================================================
  Results: 9 passed, 0 failed, 9 total
======================================================================
```

### Step 8: Try It Programmatically

Use the `AgentWallet` SDK to create and operate an agent in your own code:

```typescript
import { AgentWallet } from './lib/agent-sdk';

// Relayer configuration
const relayer = {
  baseUrl: 'http://localhost:8080',
  relayerId: 'stellar-testnet',
  apiKey: 'test-api-key-lumenitos-dev-32chars!!',
};

// Create a new agent wallet (generates keypair, redeems invite, gets funded)
const wallet = await AgentWallet.create({
  network: 'testnet',
  inviteCode: 'a3f8c1d2...your-64-char-hex-invite-code...',
  relayer,
});

console.log('Agent public key:', wallet.publicKey);
console.log('Agent secret key:', wallet.secretKey);  // Save this!
console.log('Contract address:', wallet.address);

// Check balance
const balance = await wallet.getBalance('native');
console.log('Balance:', balance, 'XLM');

// Transfer XLM
const result = await wallet.transfer({
  token: 'native',
  to: 'GBXYZ...destination...',
  amount: '10.0',
});
console.log('Transfer hash:', result.hash);

// Check status and policy
const status = await wallet.getStatus();
const policy = await wallet.getPolicy();
console.log('Status:', status);
console.log('Policy:', policy);
```

To reconnect to an existing agent wallet:

```typescript
const wallet = AgentWallet.fromSecret('SAGENT_SECRET_KEY_HERE', {
  network: 'testnet',
  relayer,
});

// The contract address is derived deterministically from the factory + agent public key
console.log('Reconnected to:', wallet.address);
```

---

## 6. Troubleshooting

### MacMismatch Keystore Error

**Symptom:** The relayer container crashes on startup with a log message about MAC mismatch or keystore decryption failure.

**Cause:** The keystore file was generated with a tool that uses SHA-256 for the MAC (e.g., a Node.js implementation), but the OZ Relayer expects keccak256 (Ethereum keystore format via the `oz-keystore` crate).

**Fix:** Regenerate the keystore using the Rust `oz-keystore` tool from the OZ Relayer repository. Do not use Node.js keystore generators. See Step 5a above.

### 401 Unauthorized from Relayer

**Symptom:** `Relayer API error (401): Unauthorized` when the SDK or curl tries to call the relayer.

**Cause 1: Wrong API key.** The `API_KEY` in the relayer's `.env` must match the `apiKey` in the SDK's relayer config and the `Authorization: Bearer` header in curl.

**Cause 2: Special characters in bash.** If your API key contains `!` (like `test-api-key-lumenitos-dev-32chars!!`), bash interprets `!` as history expansion. Solutions:
- Use single quotes: `'Bearer test-api-key-lumenitos-dev-32chars!!'`
- Escape with backslash: `Bearer test-api-key-lumenitos-dev-32chars\!\!`
- Set the key in a variable first: `export RELAYER_API_KEY='test-api-key-lumenitos-dev-32chars!!'`
- In Node.js (the SDK), this is not an issue -- special characters work in strings.

**Cause 3: API key too short.** The OZ Relayer requires the API key to be at least 32 characters.

### Contract Not Found / Simulation Fails

**Symptom:** `Simulation failed: HostError` or similar when calling factory or agent contract functions.

**Possible causes:**
- **Factory not deployed:** Run `node scripts/deploy-testnet.js` first.
- **Wrong factory address:** Check that `FACTORY_ADDRESS` matches your deployment output.
- **WASM not uploaded:** The deploy script uploads both WASMs. If you only uploaded one, re-run.
- **Contract instance expired:** On testnet, contract instances can expire if not accessed for a long time. Re-deploy.

### "account entry is missing" or Destination Not Funded

**Symptom:** Transfer fails with an error about a missing account entry.

**Cause:** The XLM SAC (Stellar Asset Contract) on Soroban requires the destination to be an existing Stellar account. Unlike classic XLM payments, Soroban token transfers do not auto-create accounts.

**Fix:** Fund the destination via friendbot first:

```bash
curl "https://friendbot.stellar.org?addr=GDESTINATION_KEY_HERE"
```

This is a testnet constraint. On mainnet, destination accounts must already exist.

### Relayer Container Crashes or Won't Start

**Symptom:** `docker compose up` starts but the relayer exits immediately.

**Debug steps:**

```bash
cd relayer
docker compose logs relayer
```

Common causes:
- **Redis not ready:** The relayer depends on Redis. Usually `restart: on-failure:5` handles this. If not, try `docker compose down && docker compose up -d`.
- **Missing keystore file:** Ensure `relayer/config/keys/local-signer.json` exists. The relayer will crash if it cannot find the keystore.
- **Invalid config.json:** Check `relayer/config/config.json` for JSON syntax errors.
- **Wrong passphrase:** If `KEYSTORE_PASSPHRASE` does not match the passphrase used to generate the keystore, decryption fails.

### Relayer Transaction Stays "Pending" Forever

**Symptom:** The SDK polls but the transaction never reaches `confirmed`.

**Possible causes:**
- **Relayer account not funded:** The relayer's Stellar account needs XLM to pay fees. Check its balance on [stellar.expert](https://stellar.expert/explorer/testnet).
- **Relayer account below min_balance:** The config sets `min_balance: 50000000` (5 XLM). If the account drops below this, the relayer stops submitting.
- **Network congestion:** Increase `pollInterval` and `maxPollAttempts` in the relayer config.

### Transaction Fails with "exceeds per-transaction limit"

**Symptom:** The on-chain execution reverts with this error.

**Cause:** The agent is trying to send more than the `per_tx_limit` defined in its policy.

**Fix:** Either reduce the amount, or have the owner update the agent's policy with a higher limit via `update_policy()`.

### Transaction Fails with "agents cannot authorize external contract calls directly"

**Symptom:** On-chain revert in `__check_auth`.

**Cause:** The agent is trying to authorize a call to a contract other than its own. Agents can only authorize calls to their own contract's wrapper functions. All external interactions must go through `agent_invoke`, `agent_swap`, `agent_supply`, or `agent_withdraw`.

### Invite Code "invalid or expired"

**Symptom:** `factory.create()` panics with "invalid or expired invite code".

**Possible causes:**
- **Invite not created:** Ensure `create-invite.js` succeeded.
- **Invite already used:** Each code is single-use. Once redeemed, it is burned.
- **Invite expired:** Invites are stored in temporary storage with a ~7-day TTL. Create a fresh one.
- **Wrong factory:** The invite exists on a specific factory deployment. Make sure you are pointing at the correct `FACTORY_ADDRESS`.
