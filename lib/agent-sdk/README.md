# Lumenitos Agent SDK

TypeScript SDK for AI agents to own and operate Soroban smart contract wallets on Stellar, built on top of the generic [Soroban Custom Account Kit](../soroban-custom-account/).

## Quick Start

```ts
import { AgentWallet } from '@/lib/agent-sdk';

// --- Path A: Create a new agent wallet (OZ Relayer pays fees) ---
const wallet = await AgentWallet.create({
  network: 'testnet',
  inviteCode: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});
console.log(wallet.address);   // C... (contract address)
console.log(wallet.secretKey);  // S... (save this!)

// --- Path B: Restore an existing agent ---
const restored = AgentWallet.fromSecret('SDXYZ...', {
  network: 'testnet',
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});

// --- Send tokens ---
await restored.transfer({ token: 'native', to: 'GBXYZ...', amount: '50.0' });

// --- Check balance ---
const balance = await restored.getBalance('native');
```

## Installation

This is currently an internal library within the Lumenitos monorepo. Import it via the path alias:

```ts
import { AgentWallet } from '@/lib/agent-sdk';
```

Peer dependency: `@stellar/stellar-sdk` (v12+).

> This package will be published to npm as a standalone module in a future release.

## API Reference

### Lumenitos-Specific

These classes and functions are defined in the agent-sdk and are specific to the Lumenitos contract system.

#### `AgentWallet`

The high-level facade. Most consumers only need this class.

**Static Constructors**

```ts
// Restore from an existing secret key (synchronous)
const wallet = AgentWallet.fromSecret(secret: string, config: WalletConfig): AgentWallet;

// Create a brand-new agent via factory invite code (async, requires relay)
const wallet = await AgentWallet.create(config: CreateConfig): Promise<AgentWallet>;
```

**Properties**

| Property | Type | Description |
|---|---|---|
| `address` | `string` | Agent's contract account address (`C...`) |
| `publicKey` | `string` | Agent's Stellar public key (`G...`) |
| `secretKey` | `string` | Agent's secret key (`S...`) -- store securely |
| `signer` | `AgentSigner` | Underlying signing identity |
| `networkConfig` | `LumenitosNetworkConfig` | Resolved network configuration (includes `factoryAddress`) |
| `account` | `AccountClient` | Low-level SimpleAccount contract client |
| `factory` | `FactoryClient` | Low-level AccountFactory contract client |

**Write Methods**

All write methods return `Promise<TransactionResult>`.

`transfer(params: TransferParams)` -- Send tokens from the agent's contract account.

```ts
await wallet.transfer({
  token: 'native',       // or a token contract address (C...)
  to: 'GBXYZ...',        // destination (G... or C...)
  amount: '100.5',       // human-readable
  decimals: 7,           // optional, default 7
});
```

`invoke(params: InvokeParams)` -- Call an arbitrary contract function through the agent.

```ts
import { nativeToScVal, Address } from '@stellar/stellar-sdk';

await wallet.invoke({
  contract: 'CABC...',
  fnName: 'do_something',
  args: [nativeToScVal('hello', { type: 'symbol' })],  // raw ScVal array
  spendToken: 'native',   // optional -- token the call spends
  spendAmount: '10.0',    // optional -- required if spendToken is set
});
```

`swap(params: SwapParams)` -- Execute a DEX swap.

```ts
await wallet.swap({
  dex: 'CDEX...',
  fnName: 'swap_exact_in',
  args: [/* DEX-specific ScVal args */],
  tokenIn: 'native',
  amountIn: '25.0',
});
```

`supply(params: SupplyParams)` -- Supply tokens to a lending protocol.

```ts
await wallet.supply({
  protocol: 'CLEND...',
  fnName: 'deposit',
  args: [/* protocol-specific ScVal args */],
  token: 'native',
  amount: '100.0',
});
```

`withdraw(params: WithdrawParams)` -- Withdraw from a lending protocol (no spend check -- value flows in).

```ts
await wallet.withdraw({
  protocol: 'CLEND...',
  fnName: 'withdraw',
  args: [/* protocol-specific ScVal args */],
});
```

**Read Methods**

`getBalance(token?, decimals?)` -- Returns human-readable balance string.

```ts
const xlmBalance = await wallet.getBalance();                    // XLM (default)
const usdcBalance = await wallet.getBalance('CUSDC...', 6);     // USDC with 6 decimals
```

`getStatus()` -- Returns `'active'` or `'frozen'`.

```ts
const status: AgentStatus = await wallet.getStatus();
```

`getPolicy()` -- Returns the agent's on-chain policy object.

```ts
const policy = await wallet.getPolicy();
```

`isInviteValid(inviteCodeHex)` -- Check if an invite code can still be redeemed.

```ts
const valid = await wallet.isInviteValid('deadbeef...');
```

`predictAddress(publicKey?)` -- Deterministically compute the contract address for a given public key (defaults to this agent's key).

```ts
const addr = wallet.predictAddress();                    // this agent
const other = wallet.predictAddress('GOTHER...');        // another agent
```

---

#### `AccountClient`

Low-level client for the Lumenitos SimpleAccount contract. Builds operations but does not sign or submit them.

```ts
import { AccountClient } from '@/lib/agent-sdk';

const client = new AccountClient(contractAddress, networkConfig, rpcServer);

// Build operations (returns xdr.Operation)
client.buildTransfer(agentKeyBytes, token, destination, amount, decimals);
client.buildInvoke(agentKeyBytes, contract, fnName, args, spendToken, spendAmount, decimals);
client.buildSwap(agentKeyBytes, dex, fnName, args, tokenIn, amountIn, decimals);
client.buildSupply(agentKeyBytes, protocol, fnName, args, token, amount, decimals);
client.buildWithdraw(agentKeyBytes, protocol, fnName, args);

// Read functions
await client.getAgentStatus(agentKeyBytes);  // 'active' | 'frozen'
await client.getPolicy(agentKeyBytes);       // Record<string, unknown>
await client.getOwner();                     // Buffer (owner public key)
```

---

#### `FactoryClient`

Client for the Lumenitos AccountFactory contract. Handles agent onboarding and address derivation.

```ts
import { FactoryClient } from '@/lib/agent-sdk';

const factory = new FactoryClient(networkConfig, rpcServer);

factory.buildCreate(agentKeyBytes, inviteCodeBytes);  // xdr.Operation
factory.getAddress(agentKeyBytes);                    // predicted C... address
await factory.isInviteValid(inviteCodeBytes);         // boolean
```

---

#### `Networks`

Lumenitos network presets. These extend the generic `NetworkConfig` with a `factoryAddress` field.

```ts
import * as Networks from '@/lib/agent-sdk';

Networks.testnet;   // LumenitosNetworkConfig for Stellar testnet
Networks.mainnet;   // LumenitosNetworkConfig for Stellar mainnet (factory not yet deployed)

Networks.resolveNetwork('testnet');  // returns a copy of the testnet config
```

---

#### `validateInviteCode(hex)`

Validates a hex-encoded invite code (must be exactly 64 hex characters / 32 bytes). Returns the decoded `Uint8Array` or throws.

```ts
import { validateInviteCode } from '@/lib/agent-sdk';

const bytes = validateInviteCode('deadbeef...');  // throws on invalid
```

---

### Re-exports from Soroban Custom Account Kit

These are re-exported from `lib/soroban-custom-account` for convenience. They are generic infrastructure not tied to Lumenitos.

#### `AgentSigner`

Re-export of `Ed25519CustomAccountSigner` from the generic layer. Handles ed25519 signing for Soroban custom account `__check_auth`, producing the default `Signature { public_key: BytesN<32>, signature: BytesN<64> }` struct.

```ts
import { AgentSigner } from '@/lib/agent-sdk';

const signer = AgentSigner.fromSecret('SXYZ...');
const signer = AgentSigner.generate();  // new random identity

signer.publicKey;       // G...
signer.secretKey;       // S...
signer.publicKeyBytes;  // Buffer (32 bytes)
signer.keypair;         // Stellar Keypair

// Sign auth entries from a simulation result
const signed = signer.signAllAuthEntries(authEntries, validUntilLedger, networkPassphrase);
```

> `AgentSigner` is a type alias for `Ed25519CustomAccountSigner`. Both names are exported.

---

#### `DirectSubmitter`

Self-pay submission. Signs the transaction envelope and submits via Soroban RPC. The signer's Stellar account must be funded to pay fees. Suitable for owner operations and testing.

For agents that should not pay their own fees, use `RelayerSubmitter` with a self-hosted OZ Relayer.

```ts
import { DirectSubmitter } from '@/lib/agent-sdk';

const submitter = new DirectSubmitter(signer, rpcServer, networkConfig);
const result = await submitter.submit(operation, sourcePublicKey);
```

---

#### `RelayerSubmitter`

Fee-sponsored submission via a self-hosted [OpenZeppelin Relayer](https://docs.openzeppelin.com/relayer/1.4.x/stellar). The relayer pays fees with its own KMS-secured account. The agent only signs auth entries -- no private keys are shared.

```ts
import { RelayerSubmitter } from '@/lib/agent-sdk';

const submitter = new RelayerSubmitter(signer, rpcServer, networkConfig, {
  baseUrl: 'http://localhost:8080',
  relayerId: 'stellar-testnet',
  apiKey: 'your-api-key',
});
const result = await submitter.submit(operation, sourcePublicKey);
```

---

#### Helper Functions

All re-exported from the generic layer:

```ts
import {
  toRawAmount,
  fromRawAmount,
  deriveContractAddress,
  resolveTokenContract,
  waitForTransaction,
  SIMULATION_ACCOUNT,
} from '@/lib/agent-sdk';

// Amount conversion (string-based, no floating-point precision loss)
toRawAmount('50.0', 7);        // 500000000n
fromRawAmount(500000000n, 7);  // '50'
toRawAmount('0.1', 7);         // 1000000n (exact)

// Deterministic address derivation
const contractAddr = deriveContractAddress(factoryAddress, agentKeyBytes, networkPassphrase);

// Resolve 'native' to XLM SAC contract, or pass through C... addresses
const contract = resolveTokenContract('native', networkPassphrase);

// Wait for on-chain confirmation
const result = await waitForTransaction(rpcServer, txHash, { maxAttempts: 10, interval: 2000 });

// Dummy account for simulation-only transactions
SIMULATION_ACCOUNT;  // 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
```

---

### Types

```ts
import type {
  // Lumenitos-specific
  LumenitosNetworkConfig,    // extends NetworkConfig with factoryAddress
  WalletConfig,
  CreateConfig,
  TransferParams,
  InvokeParams,
  SwapParams,
  SupplyParams,
  WithdrawParams,
  TokenLimit,                // { token, perTxLimit }
  AccessControl,             // 'allowAll' | 'allowOnly' | 'denyOnly'
  AgentPolicy,               // { tokenLimits, access, expiryLedger }
  TokenAmount,               // { token, amount }
  AgentStatus,               // 'active' | 'frozen'

  // Re-exported from soroban-custom-account
  NetworkConfig,             // base network config (rpcUrl, networkPassphrase)
  TransactionResult,         // { hash, status, ledger?, returnValue? }
  TransactionSubmitter,      // interface for DirectSubmitter / RelayerSubmitter
  CustomAccountSigner,       // interface for any custom account signer
  SignatureBuilder,          // (preimage, keypair) => xdr.ScVal
  RelayerConfig,             // { baseUrl, relayerId, apiKey, maxFee?, ... }
} from '@/lib/agent-sdk';
```

## Relayer Mode (Recommended)

Agents don't pay their own transaction fees. A self-hosted **OpenZeppelin Relayer** submits transactions on the agent's behalf. The agent only signs auth entries via `__check_auth`; the relayer pays fees with its own KMS-secured account.

**When to use it:**
- `AgentWallet.create()` -- required (new agents have no funded account)
- All agent operations -- agents never need XLM for gas fees
- Any production deployment where agents should not hold fee-paying keys

**Prerequisites:**

Run a self-hosted [OZ Relayer](https://docs.openzeppelin.com/relayer/1.4.x/stellar) (Docker + Redis). The relayer manages its own funded Stellar account via KMS -- no private keys are shared between agent and relayer.

**Configuration:**

```ts
// Create a new agent (relayer pays for the factory.create() call)
const wallet = await AgentWallet.create({
  network: 'testnet',
  inviteCode: 'deadbeef...',
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});

// Reconnect an existing agent (relayer continues paying fees)
const wallet = AgentWallet.fromSecret('SDAGENT...', {
  network: 'testnet',
  relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: 'your-api-key' },
});

// The API is identical -- relayer is transparent to the caller
await wallet.transfer({ token: 'native', to: 'GBXYZ...', amount: '10.0' });
```

**`RelayerConfig` options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | (required) | Base URL of the self-hosted OZ Relayer |
| `relayerId` | `string` | (required) | Relayer ID from OZ Relayer config |
| `apiKey` | `string` | (required) | API key for relayer authentication |
| `maxFee` | `number` | `10_000_000` | Max fee in stroops the relayer will pay (1 XLM) |
| `pollInterval` | `number` | `2000` | Polling interval in ms for tx confirmation |
| `maxPollAttempts` | `number` | `15` | Max polling attempts before timeout |

**How it works under the hood:**
1. SDK builds the operation and simulates it against Soroban RPC
2. Agent signs the Soroban auth entries (ed25519 + `{public_key, signature}` struct)
3. SDK extracts the contract address, function name, args, and signed auth XDR
4. SDK POSTs to the OZ Relayer's operations API
5. Relayer builds the transaction, pays fees (KMS-secured account), and submits
6. SDK polls the relayer for confirmation

## Architecture

The SDK is split into two layers:

```
+---------------------------------------------------------------+
|                    lib/agent-sdk (this package)                |
|                                                                |
|  AgentWallet          AccountClient        FactoryClient       |
|  (high-level          (SimpleAccount       (AccountFactory     |
|   facade)              contract ABI)        contract ABI)      |
|                                                                |
|  Networks (testnet/mainnet presets with factoryAddress)        |
|  validateInviteCode   AgentSigner (re-export)                  |
+-------------------------------+-------------------------------+
                                |
                    imports generic infra from
                                |
+-------------------------------v-------------------------------+
|              lib/soroban-custom-account (generic layer)        |
|                                                                |
|  Ed25519CustomAccountSigner   defaultSignatureBuilder          |
|  DirectSubmitter              RelayerSubmitter (OZ Relayer)  |
|  toRawAmount / fromRawAmount  deriveContractAddress             |
|  resolveTokenContract         waitForTransaction                |
|  simulateRead                 SIMULATION_ACCOUNT                |
+---------------------------------------------------------------+
```

**What lives where:**

| Layer | Contains | Contract-specific? |
|---|---|---|
| `lib/soroban-custom-account` | Ed25519 signing, transaction submission, amount/address utilities | No -- works with any Soroban custom account contract |
| `lib/agent-sdk` | `AgentWallet`, `AccountClient`, `FactoryClient`, network presets, invite system | Yes -- tied to Lumenitos SimpleAccount + AccountFactory ABIs |

**Key design decisions:**
- **Two-layer split**: Generic Soroban custom account infrastructure is separated from Lumenitos-specific logic so other projects can reuse the generic layer.
- **Facade pattern**: `AgentWallet` wraps everything. Power users can drop down to `AccountClient`/`FactoryClient` directly.
- **Pluggable submission**: `DirectSubmitter` handles self-pay mode (signer pays fees). `RelayerSubmitter` handles fee-sponsored mode via a self-hosted OZ Relayer (recommended for agents).
- **Re-export convention**: `AgentSigner` is a re-export of `Ed25519CustomAccountSigner` -- it uses the default `{ public_key, signature }` struct which matches the SimpleAccount contract's `__check_auth`.

## Building Your Own SDK

If you are building an SDK for a different Soroban custom account contract (not Lumenitos), you do not need this package. Use the generic layer directly:

```ts
import {
  Ed25519CustomAccountSigner,
  defaultSignatureBuilder,
  DirectSubmitter,
  toRawAmount,
  fromRawAmount,
  deriveContractAddress,
  resolveTokenContract,
  waitForTransaction,
  simulateRead,
  SIMULATION_ACCOUNT,
} from '@/lib/soroban-custom-account';

import type {
  NetworkConfig,
  TransactionResult,
  TransactionSubmitter,
  CustomAccountSigner,
  SignatureBuilder,
} from '@/lib/soroban-custom-account';
```

The generic layer gives you:
- **`Ed25519CustomAccountSigner`** -- signs Soroban auth entries using ed25519 with the default `Signature { public_key: BytesN<32>, signature: BytesN<64> }` struct. If your contract uses a different signature format, pass a custom `SignatureBuilder` function.
- **`DirectSubmitter`** -- self-pay submission. Handles transaction assembly, simulation, signing, and submission. Works with any `CustomAccountSigner`.
- **`RelayerSubmitter`** -- fee-sponsored submission via a self-hosted OZ Relayer. The agent only signs auth entries; the relayer pays fees. Recommended for production agents.
- **Helper utilities** -- amount conversion, address derivation, token resolution, simulation helpers.

To build your own SDK, follow the same pattern as `lib/agent-sdk`:
1. Create contract client classes that build `xdr.Operation` objects for your contract's functions
2. Re-export or wrap `Ed25519CustomAccountSigner` (with a custom `SignatureBuilder` if needed)
3. Create a high-level facade class that ties the contract clients to a submitter
4. Add your own network presets and domain-specific helpers

See [`lib/soroban-custom-account/README.md`](../soroban-custom-account/README.md) for full documentation of the generic layer.

## Security Notes

- **Testnet only** -- mainnet factory is not yet deployed. The SDK will throw if you try to use `'mainnet'`.
- **Agent keys are sensitive** -- `wallet.secretKey` controls the agent's contract account. Store it securely (vault, encrypted env, etc.). Never log it or commit it to source control.
- **Invite codes are one-time** -- each 32-byte invite code can only be redeemed once by the factory contract.
- **Policy enforcement is on-chain** -- the owner sets token limits, access control, and expiry via the SimpleAccount contract. The SDK does not enforce policy client-side.

## Limitations

- **`invoke`, `swap`, `supply`, `withdraw` args require raw `xdr.ScVal[]`** -- there is no high-level argument builder yet. You must construct ScVal arrays manually using `@stellar/stellar-sdk`.
- **Instruction limit bump** -- the SDK adds 1,000,000 to the simulated instruction limit to cover `__check_auth` ed25519 verification overhead. This is a fixed heuristic and may need tuning for complex transactions.
- **`toRawAmount` truncates silently** -- excess decimal places beyond the specified `decimals` are dropped without rounding (e.g., `toRawAmount('1.12345678', 7)` produces `11234567n`).
- **Not yet end-to-end validated on testnet** -- the SDK structure is complete but integration testing against deployed contracts is in progress.
- **Mainnet not available** -- the factory contract has not been deployed to mainnet. Attempting to use `network: 'mainnet'` will throw.
