# Soroban Custom Account Kit

TypeScript infrastructure for building client SDKs that interact with Soroban custom account contracts on Stellar.

## What This Solves

Soroban custom account contracts authenticate via `__check_auth`, which requires clients to:

1. Simulate the transaction to get auth entries
2. Build a `HashIdPreimage` for each auth entry
3. SHA-256 hash and ed25519 sign it
4. Wrap the signature bytes into whatever `ScVal` format the contract expects
5. Inject signed auth entries back into the transaction envelope
6. Bump instruction limits (ed25519 verify is expensive)
7. Submit and poll for confirmation

Every custom account SDK reimplements this pipeline from scratch. This kit extracts the universal parts and makes the contract-specific part -- the signature format -- a single callback.

## Quick Start

### Default signature format

If your contract uses the canonical `{ public_key: BytesN<32>, signature: BytesN<64> }` struct (the format from the Soroban examples), zero configuration is needed:

```ts
import {
  Ed25519CustomAccountSigner,
  DirectSubmitter,
} from '@/lib/soroban-custom-account';
import * as StellarSdk from '@stellar/stellar-sdk';

const signer = Ed25519CustomAccountSigner.fromSecret('SDXYZ...');

const rpcServer = new StellarSdk.rpc.Server('https://soroban-testnet.stellar.org');
const networkConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: StellarSdk.Networks.TESTNET,
};

const submitter = new DirectSubmitter(signer, rpcServer, networkConfig);

// Build any invokeContract operation, then submit:
const contract = new StellarSdk.Contract('CABC...');
const op = contract.call('transfer', ...args);
const result = await submitter.submit(op, signer.publicKey);
console.log(result.hash, result.status);
```

### Custom signature format

If your contract's `__check_auth` expects a different struct, provide a `SignatureBuilder`:

```ts
import { Ed25519CustomAccountSigner } from '@/lib/soroban-custom-account';
import { xdr } from '@stellar/stellar-sdk';

const signer = new Ed25519CustomAccountSigner(keypair, (pubKeyBytes, sigBytes) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('id'),
      val: xdr.ScVal.scvBytes(pubKeyBytes),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('sig'),
      val: xdr.ScVal.scvBytes(sigBytes),
    }),
  ])
);
```

## API Reference

### Signer

#### `Ed25519CustomAccountSigner`

The core class that signs Soroban auth entries for custom account contracts.

| Member | Description |
|---|---|
| `constructor(keypair, buildSignature?)` | Create from an existing `Keypair`. Optional `SignatureBuilder` (defaults to canonical struct). |
| `static fromSecret(secret, buildSignature?)` | Create from a Stellar secret key string. |
| `static generate(buildSignature?)` | Create with a random keypair. |
| `publicKey` | Stellar public key (`G...`). |
| `secretKey` | Stellar secret key (`S...`). |
| `publicKeyBytes` | Raw 32-byte ed25519 public key. |
| `keypair` | Underlying `Keypair` instance. |
| `signAuthEntry(auth, validUntilLedger, networkIdHash)` | Sign a single `SorobanAuthorizationEntry`. |
| `signAllAuthEntries(authEntries, validUntilLedger, networkPassphrase)` | Sign all address-credential entries; non-address entries pass through unchanged. |

#### `defaultSignatureBuilder`

The built-in `SignatureBuilder` that produces `{ public_key: BytesN<32>, signature: BytesN<64> }` as an `ScVal` map with alphabetically sorted keys (Soroban `#[contracttype]` convention).

### Submitters

Both submitters implement the `TransactionSubmitter` interface:

```ts
interface TransactionSubmitter {
  submit(operation: xdr.Operation, sourcePublicKey: string): Promise<TransactionResult>;
}
```

#### `DirectSubmitter`

Self-pay submission. The signer's account pays fees and signs the transaction envelope. Requires the signer's Stellar account to exist and be funded. Suitable for owner operations and testing.

For agents that should not pay their own fees, use `RelayerSubmitter` with a self-hosted OpenZeppelin Relayer.

```ts
new DirectSubmitter(signer, rpcServer, networkConfig)
```

Pipeline: simulate -> sign auth entries -> assemble -> bump instructions -> sign envelope -> submit -> poll.

#### `RelayerSubmitter`

Submits transactions via a self-hosted [OpenZeppelin Relayer](https://docs.openzeppelin.com/relayer/1.4.x/stellar). The relayer pays fees with its own funded account (KMS-secured). The agent only signs auth entries — no private keys are shared.

```ts
new RelayerSubmitter(signer, rpcServer, networkConfig, {
  baseUrl: 'http://localhost:8080',
  relayerId: 'stellar-testnet',
  apiKey: 'your-api-key',
})
```

Pipeline: simulate -> sign auth entries -> assemble -> sign envelope -> POST signed XDR to relayer -> relayer fee-bumps + submits.

### Helpers

| Function | Description |
|---|---|
| `computeNetworkIdHash(networkPassphrase)` | SHA-256 hash of the network passphrase. Used in auth preimage construction. |
| `toRawAmount(amount, decimals?)` | String-based conversion from human-readable to raw `bigint` units. Avoids floating-point precision loss. Default 7 decimals. |
| `fromRawAmount(raw, decimals?)` | Inverse of `toRawAmount`. Converts raw units back to a human-readable string. |
| `deriveContractAddress(deployer, salt, networkPassphrase)` | Deterministic contract address derivation from deployer + 32-byte salt. Compatible with any factory using `deployer().with_current_contract(salt).deploy_v2()`. |
| `resolveTokenContract(token, networkPassphrase)` | Resolves `'native'` to the XLM Stellar Asset Contract, or returns a `Contract` for the given address. |
| `waitForTransaction(rpcServer, hash, options?)` | Poll RPC until a transaction is confirmed or fails. Configurable `maxAttempts` (default 10) and `interval` (default 2000ms). |
| `submitAndWait(rpcServer, transaction)` | Submit a signed `Transaction` and poll for confirmation. |
| `bumpInstructionLimit(txEnvelope, additional?)` | Increase the instruction budget on a transaction envelope. Default bump: 1,000,000. Necessary for any `__check_auth` performing ed25519 verification. |
| `parseAuthEntry(authEntry)` | Parse a `SorobanAuthorizationEntry` from either a base64 string or an existing XDR object. |
| `simulateRead(rpcServer, operation, networkPassphrase)` | Simulate a read-only contract call using a dummy account. Returns the `ScVal` result without needing a funded account. |

### Constants

| Constant | Value | Description |
|---|---|---|
| `SIMULATION_ACCOUNT` | `GAAA...WHF` | Dummy account address for read-only simulations. |
| `AUTH_EXPIRY_LEDGER_OFFSET` | `60` | Auth signatures are valid for ~60 ledgers (~5 minutes at 5s/ledger). |

### Types

| Type | Description |
|---|---|
| `NetworkConfig` | `{ rpcUrl, networkPassphrase, friendbotUrl? }` |
| `TransactionResult` | `{ hash, status, ledger?, returnValue? }` |
| `TransactionSubmitter` | Interface with `submit(operation, sourcePublicKey)`. |
| `CustomAccountSigner` | Interface with `publicKey`, `publicKeyBytes`, `keypair`, and `signAllAuthEntries()`. |
| `SignatureBuilder` | `(publicKeyBytes: Buffer, signatureBytes: Buffer) => xdr.ScVal` -- the key customization point. |

## Custom Signature Formats

The `SignatureBuilder` type is the only thing you need to change when targeting a different custom account contract. It receives the raw 32-byte public key and 64-byte ed25519 signature, and must return the `ScVal` that the contract's `__check_auth` will decode.

### Example: raw bytes only

```ts
const builder: SignatureBuilder = (_pubKey, sig) => xdr.ScVal.scvBytes(sig);
```

### Example: struct with different field names

```ts
const builder: SignatureBuilder = (pubKey, sig) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('authenticator'),
      val: xdr.ScVal.scvBytes(pubKey),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('sig'),
      val: xdr.ScVal.scvBytes(sig),
    }),
  ]);
```

### Example: vec of signatures (multi-sig)

```ts
// Wrap a single signature into a Vec expected by a multi-sig contract
const builder: SignatureBuilder = (pubKey, sig) =>
  xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('public_key'),
        val: xdr.ScVal.scvBytes(pubKey),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('signature'),
        val: xdr.ScVal.scvBytes(sig),
      }),
    ]),
  ]);
```

## Architecture

```
                     +-----------------------+
                     |  Your Application     |
                     +----------+------------+
                                |
                     +----------v------------+
                     |  Ed25519CustomAccount |
                     |  Signer              |
                     |                       |
                     |  universal: preimage  |
                     |    hash + sign        |
                     |  pluggable:           |
                     |    SignatureBuilder   |
                     +----------+------------+
                                |
                                |
              +----------v-----------+     +-------------------+
              |   DirectSubmitter    |     | RelayerSubmitter  |
              |                      |     |                   |
              |  self-pay: signs     |     | OZ Relayer: agent |
              |  envelope + submits  |     | signs auth only,  |
              |  signer pays fees    |     | relayer pays fees |
              +----------+-----------+     +--------+----------+
                         |                          |
                         +------------+-------------+
                                |
                     +----------v------------+
                     |  Helpers              |
                     |  amount conversion,   |
                     |  address derivation,  |
                     |  simulation, polling  |
                     +----------+------------+
                                |
                     +----------v------------+
                     |  Stellar SDK / RPC    |
                     +-----------------------+
```

The signer handles the cryptographic pipeline (preimage construction, hashing, signing, credential assembly). The submitters handle the transaction lifecycle (build, simulate, assemble, submit, poll). Helpers are pure functions with no shared state.

## Relationship to agent-sdk

The `agent-sdk` library (`lib/agent-sdk/`) builds on top of this kit to provide a higher-level SDK specifically for Lumenitos agent wallet contracts. It adds:

- Contract-specific method builders (send, swap, policy management)
- Factory-aware deployment and address derivation
- A domain-specific `SignatureBuilder` matching the agent wallet's `__check_auth` format

If you are building a client for a different custom account contract, use `soroban-custom-account` directly and provide your own `SignatureBuilder`. If you are building on the Lumenitos agent wallet contracts specifically, use `agent-sdk` instead.
