# Reflections: Implementing a Custom Stellar Contract Account

This document captures the challenges, pitfalls, and lessons learned while implementing a custom Soroban smart wallet contract account in Lumenitos. The `simple_account` Soroban contract uses ed25519 signature verification for self-custodied smart wallet functionality.

## Overview

A "custom account" in Soroban is a smart contract that implements the `__check_auth` function. When this contract's address is used as a source for `require_auth`, the Soroban host calls `__check_auth` to verify the authorization. This enables smart wallets, multi-sig, and other custom authentication schemes.

Our contract is simple - it stores an ed25519 public key and verifies signatures against it:

```rust
pub fn __check_auth(
    env: Env,
    signature_payload: BytesN<32>,
    signature: BytesN<64>,
    _auth_context: Vec<Context>,
) {
    let public_key: BytesN<32> = env.storage().instance().get(&DataKey::Owner).unwrap();
    env.crypto().ed25519_verify(&public_key, &signature_payload.into(), &signature);
}
```

## Challenge 1: The SDK's `authorizeEntry` Doesn't Work for Contract Accounts

### The Problem

The Stellar JS SDK provides `StellarSdk.authorizeEntry()` which seems like the obvious choice for signing auth entries. However, it's designed for classic Stellar accounts (G... addresses), not contract accounts (C... addresses).

When we tried:
```javascript
const signedAuth = await StellarSdk.authorizeEntry(
  authEntry,
  keypair,
  validUntilLedger,
  config.networkPassphrase
);
```

We got: **"invalid version byte. expected 48, got 16"**

### Why This Happens

The SDK's `authorizeEntry` tries to extract a public key from the address in the auth entry. Contract addresses (C...) have a different version byte than classic accounts (G...), so the SDK fails when trying to decode it as an account.

### The Fix

You must manually construct the authorization preimage and sign it yourself. The SDK doesn't provide a helper for contract account authorization.

## Challenge 2: Preimage Hash Must Match Auth Entry Exactly

### The Problem

After manual signing, we got `invokeHostFunctionTrapped` - the contract's signature verification was failing. The signature was valid, but the payload being verified didn't match what we signed.

### The Root Cause

The `HashIdPreimage` for Soroban authorization contains a `signatureExpirationLedger` field. This value **MUST exactly match** the `signatureExpirationLedger` in the `SorobanAddressCredentials`.

Our code was doing:
```javascript
// BUG: Using simulation's expiration (could be 0!)
const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
  new StellarSdk.xdr.HashIdPreimageSorobanAuthorization({
    networkId: networkIdHash,
    nonce: addressCreds.nonce(),
    signatureExpirationLedger: addressCreds.signatureExpirationLedger(), // From simulation - often 0!
    invocation: auth.rootInvocation(),
  })
);

// Then setting a different value in the credentials
const newAddressCreds = new StellarSdk.xdr.SorobanAddressCredentials({
  ...
  signatureExpirationLedger: validUntilLedger, // Different value!
  ...
});
```

The Soroban host computes the preimage hash using the values in the credentials, so if they don't match what you signed, verification fails.

### The Fix

Compute your own `validUntilLedger` and use it consistently in BOTH places:

```javascript
const latestLedger = simResult.latestLedger;
const validUntilLedger = latestLedger + 60; // ~5 minutes

// Use validUntilLedger in the preimage
const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
  new StellarSdk.xdr.HashIdPreimageSorobanAuthorization({
    networkId: networkIdHash,
    nonce: nonce,
    signatureExpirationLedger: validUntilLedger, // Same value!
    invocation: auth.rootInvocation(),
  })
);

// And in the credentials
const newAddressCreds = new StellarSdk.xdr.SorobanAddressCredentials({
  address: addressCreds.address(),
  nonce: nonce,
  signatureExpirationLedger: validUntilLedger, // Same value!
  signature: signatureScVal,
});
```

## Challenge 3: Auth Entries Come in Multiple Formats

### The Problem

After transaction simulation, auth entries can be in different formats depending on the SDK version and how you access them:
- Raw XDR objects (`SorobanAuthorizationEntry` instances)
- Base64-encoded XDR strings
- JavaScript objects with a `toXDR()` method

### The Fix

Handle all cases:
```javascript
let auth;
if (typeof authEntry === 'string') {
  auth = StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(authEntry, 'base64');
} else if (authEntry instanceof StellarSdk.xdr.SorobanAuthorizationEntry) {
  auth = authEntry;
} else if (authEntry.toXDR) {
  auth = authEntry;
} else {
  throw new Error('Unknown auth entry format');
}
```

## Challenge 4: Instruction Limits for Custom Account Verification

### The Problem

After fixing the signature, we got `invokeHostFunctionResourceLimitExceeded`. The transaction simulation doesn't account for the additional CPU instructions needed for custom account `__check_auth` verification.

Ed25519 signature verification is computationally expensive in the Soroban VM - our contract needed ~927,000 additional instructions.

### The Fix

Bump the instruction limit after assembling the transaction:

```javascript
// Assemble transaction with simulation result
transaction = StellarSdk.rpc.assembleTransaction(transaction, simResult).build();

// Bump instruction limit for __check_auth verification
const txXdr = transaction.toXDR();
const txEnvelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(txXdr, 'base64');
const sorobanData = txEnvelope.v1().tx().ext().sorobanData();
const resources = sorobanData.resources();
const currentInstructions = resources.instructions();
resources.instructions(currentInstructions + 1000000); // Add 1M instructions buffer
```

Note: You can't just set a new value - you need to ADD to the existing value since the simulation already calculated base requirements.

## Challenge 5: Cannot Re-simulate After Signing

### The Problem

Initial attempts tried to:
1. Simulate transaction
2. Sign auth entries
3. Re-simulate to get updated resource requirements
4. Submit

This failed because re-simulation generates NEW nonces in the auth entries, invalidating the signatures.

### The Fix

Never re-simulate after signing. The workflow must be:
1. Build transaction
2. Simulate ONCE
3. Sign auth entries using values from that simulation
4. Assemble with the ORIGINAL simulation result
5. Manually bump instruction limits if needed
6. Submit

## Challenge 6: Buffer Compatibility in Browser

### The Problem

Node.js `Buffer` isn't natively available in browsers. Code like:
```javascript
const networkIdHash = StellarSdk.hash(Buffer.from(config.networkPassphrase));
```
Would fail in browser environments.

### The Fix

For Next.js apps, this works because Next.js polyfills `Buffer`. For pure browser apps, you'd need to use `TextEncoder` or include a Buffer polyfill:

```javascript
// Alternative without Buffer
const encoder = new TextEncoder();
const networkIdHash = StellarSdk.hash(encoder.encode(config.networkPassphrase));
```

## Challenge 7: Signature Format for Custom Contracts

### The Problem

The signature must be passed in the exact format the contract expects. Our contract expects `BytesN<64>` - a raw 64-byte ed25519 signature.

Different contracts might expect different formats (e.g., wrapped in a struct, or with additional metadata).

### The Fix

For raw signatures, use:
```javascript
const signature = keypair.sign(payload); // Returns Uint8Array(64)
const signatureScVal = StellarSdk.nativeToScVal(signature, { type: 'bytes' });
```

## Challenge 8: Limited Documentation and Examples

### The Problem

The Stellar documentation for custom account contracts is sparse. The official examples focus on basic contract deployment, not on the complex authorization flow needed for custom accounts.

Specific gaps:
- No clear documentation on the preimage format for custom accounts
- No examples of manually signing auth entries for contract accounts
- No guidance on instruction limit bumping for custom auth verification
- The relationship between simulation auth entries and final signed entries is unclear

### Recommendations

1. **Read the Soroban source code** - The XDR definitions and host functions are the ultimate source of truth
2. **Use verbose logging during development** - Log XDR hex/base64 and compare with working examples
3. **Test on testnet first** - The error messages are cryptic, debugging is much easier with testnet explorers
4. **Check transaction history on Stellar Expert** - You can see exact error details and compare with successful transactions

## Complete Working Code Pattern

Here's the complete pattern for signing a transaction from a custom contract account:

```javascript
async function sendFromContractAccount(destination, amount) {
  const keypair = getStoredKeypair();
  const publicKey = keypair.publicKey();
  const contractAddress = deriveContractAddress(publicKey);

  // Build the transfer operation
  const transferOp = buildTransferOperation(contractAddress, destination, amount);

  // Create and simulate transaction
  let transaction = new StellarSdk.TransactionBuilder(sourceAccount, { fee, networkPassphrase })
    .addOperation(transferOp)
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(transaction);

  if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
    throw new Error(simResult.error);
  }

  // Sign auth entries
  const authEntries = simResult.result.auth || [];
  const signedAuthEntries = [];
  const latestLedger = simResult.latestLedger;
  const validUntilLedger = latestLedger + 60;
  const networkIdHash = StellarSdk.hash(Buffer.from(networkPassphrase));

  for (const authEntry of authEntries) {
    let auth = parseAuthEntry(authEntry);

    if (auth.credentials().switch().name === 'sorobanCredentialsAddress') {
      const addressCreds = auth.credentials().address();
      const nonce = addressCreds.nonce();

      // Build preimage with SAME validUntilLedger as we'll use in credentials
      const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new StellarSdk.xdr.HashIdPreimageSorobanAuthorization({
          networkId: networkIdHash,
          nonce: nonce,
          signatureExpirationLedger: validUntilLedger,
          invocation: auth.rootInvocation(),
        })
      );

      // Hash and sign
      const payload = StellarSdk.hash(preimage.toXDR());
      const signature = keypair.sign(payload);
      const signatureScVal = StellarSdk.nativeToScVal(signature, { type: 'bytes' });

      // Create new credentials with our signature
      const newAddressCreds = new StellarSdk.xdr.SorobanAddressCredentials({
        address: addressCreds.address(),
        nonce: nonce,
        signatureExpirationLedger: validUntilLedger,
        signature: signatureScVal,
      });

      const signedAuth = new StellarSdk.xdr.SorobanAuthorizationEntry({
        credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(newAddressCreds),
        rootInvocation: auth.rootInvocation(),
      });
      signedAuthEntries.push(signedAuth);
    } else {
      signedAuthEntries.push(auth);
    }
  }

  // Assemble with ORIGINAL simulation (never re-simulate!)
  transaction = StellarSdk.rpc.assembleTransaction(transaction, simResult).build();

  // Replace auth entries at XDR level
  const txEnvelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(transaction.toXDR(), 'base64');
  const invokeOp = txEnvelope.v1().tx().operations()[0].body().invokeHostFunctionOp();
  invokeOp.auth(signedAuthEntries);

  // Bump instruction limit for __check_auth
  const resources = txEnvelope.v1().tx().ext().sorobanData().resources();
  resources.instructions(resources.instructions() + 1000000);

  // Rebuild and sign transaction
  transaction = new StellarSdk.Transaction(txEnvelope.toXDR('base64'), networkPassphrase);
  transaction.sign(keypair);

  // Submit
  return await server.sendTransaction(transaction);
}
```

## Challenge 9: TTL Extension with extendFootprintTtl

### The Problem

Implementing TTL (Time-To-Live) extension for contract entries seemed straightforward - build a transaction with `extendFootprintTtl` operation, simulate, assemble, submit. However, the operation consistently failed with `extendFootprintTtlMalformed` error.

### Investigation

The `extendFootprintTtlMalformed` error occurs when:
1. The footprint is empty, OR
2. The `extendTo` value is invalid

We tried multiple approaches:
- Using `assembleTransaction` directly (footprint was being cleared/modified)
- Manually rebuilding the transaction with simulation's resource values
- Using `SorobanDataBuilder.setResources()` (API mismatch errors)
- Setting footprint via `simResult.transactionData.setReadOnly()` (still malformed)

### The Root Cause

The issue was **not** with the footprint handling - it was with the `extendTo` value. We initially used `MAX_TTL_EXTENSION = 3,110,400` ledgers (~6 months) based on theoretical Stellar network limits.

However, the actual maximum allowed value on testnet is significantly lower. When `extendTo` exceeds network-allowed limits, the operation is rejected as malformed.

### The Fix

Reduced `MAX_TTL_EXTENSION` to 500,000 ledgers (~35 days at 5s/ledger):

```javascript
// Maximum TTL extension (about 35 days at 5s/ledger)
const MAX_TTL_EXTENSION = 500000;
```

The final working implementation uses `prepareTransaction` which handles simulation and assembly correctly:

```javascript
const sorobanData = new StellarSdk.SorobanDataBuilder()
  .setReadOnly([ledgerKey])
  .build();

let transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
  fee: '10000',
  networkPassphrase,
})
  .addOperation(StellarSdk.Operation.extendFootprintTtl({
    extendTo: MAX_TTL_EXTENSION,
  }))
  .setTimeout(300)
  .setSorobanData(sorobanData)
  .build();

// prepareTransaction handles simulation and assembly correctly
const preparedTransaction = await rpcServer.prepareTransaction(transaction);
preparedTransaction.sign(keypair);
await rpcServer.sendTransaction(preparedTransaction);
```

### Key Lessons

1. **Network limits vary** - The theoretical maximum TTL (~3M ledgers) may not be allowed by the actual network configuration
2. **Error messages are misleading** - "malformed" suggests a format issue, but can actually mean invalid parameter values
3. **Use `prepareTransaction`** - It correctly handles simulation, assembly, and footprint management in one step
4. **Test with smaller values first** - When debugging, try significantly reduced values to isolate the issue

### Note on LedgerKey Construction

Building ledger keys for TTL extension requires careful XDR construction:

```javascript
// Contract instance key
const instanceKey = StellarSdk.xdr.LedgerKey.contractData(
  new StellarSdk.xdr.LedgerKeyContractData({
    contract: StellarSdk.Address.contract(contractIdBytes).toScAddress(),
    key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: StellarSdk.xdr.ContractDataDurability.persistent()
  })
);

// Contract code (WASM) key - requires getting WASM hash from instance first
const codeKey = StellarSdk.xdr.LedgerKey.contractCode(
  new StellarSdk.xdr.LedgerKeyContractCode({
    hash: wasmHash // Get from instance.executable().wasmHash()
  })
);

// Token balance key (in SAC)
const balanceKey = StellarSdk.xdr.LedgerKey.contractData(
  new StellarSdk.xdr.LedgerKeyContractData({
    contract: StellarSdk.Address.contract(xlmContractIdBytes).toScAddress(),
    key: StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvSymbol('Balance'),
      StellarSdk.Address.contract(holderContractId).toScVal()
    ]),
    durability: StellarSdk.xdr.ContractDataDurability.persistent()
  })
);
```

## Challenge 10: SEP-0041 Transfer Events with Muxed IDs

### The Problem

When parsing transfer history from SAC (Stellar Asset Contract) events, transfers to muxed addresses showed "0 XLM" instead of the actual amount. Regular transfers without muxed IDs displayed correctly.

### Investigation

The transfer event parsing code was:
```javascript
if (event.value) {
  const stroops = scValToAmount(event.value);
  amountXLM = stroopsToXlm(stroops);
}
```

This assumed `event.value` was always an i128 amount. For regular transfers, this is true. But the amount was returning 0 for muxed transfers.

### The Root Cause

Per [SEP-0041](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md), when a transfer includes a muxed ID, the event value is a **map** instead of a simple i128:

```
{
  amount: i128,           // The transfer amount
  to_muxed_id: Option<u64 | String | BytesN<32>>  // The muxed ID
}
```

The `scValToNative()` function was converting this to a JavaScript object, and `BigInt(object)` was returning 0n.

### The Fix

Updated `scValToAmount` in `utils/stellar/helpers.js` to handle both formats:

```javascript
export function scValToAmount(scVal) {
  try {
    const native = StellarSdk.scValToNative(scVal);
    // If it's a map (muxed transfer per SEP-0041), extract the amount field
    if (native && typeof native === 'object' && 'amount' in native) {
      return BigInt(native.amount);
    }
    return BigInt(native);
  } catch {
    if (scVal.switch().name === 'scvI128') {
      const parts = scVal.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      return (hi << 64n) | lo;
    }
    // Handle map case manually if scValToNative failed
    if (scVal.switch().name === 'scvMap') {
      const entries = scVal.map();
      for (const entry of entries) {
        const key = entry.key();
        if (key.switch().name === 'scvSymbol' && key.sym().toString() === 'amount') {
          return scValToAmount(entry.val());
        }
      }
    }
    return 0n;
  }
}
```

### Key Lessons

1. **Read the SEPs** - SEP-0041 defines the standard token interface including event formats. The muxed ID handling is documented there.
2. **Event data formats can vary** - Don't assume event values have a fixed format. Token events may include additional metadata.
3. **Test with edge cases** - Muxed addresses are less common, so this bug only appeared when specifically testing muxed transfers.

## Challenge 11: OpenZeppelin Channels Gasless Transfers

### The Problem

Integrating OpenZeppelin Channels for gasless (sponsored) transfers revealed that both classic and contract accounts CAN work, but require different signature formats that weren't obvious from the documentation.

### Investigation

We integrated the `@openzeppelin/relayer-plugin-channels` package to enable fee-free transactions via OZ's hosted relayer service.

Initial testing revealed:
1. **Contract account transfers** worked after signing the auth entries with raw ed25519 signatures
2. **Classic account transfers** initially failed with: "Detached address credentials required: source-account credentials are incompatible with relayer-managed channel accounts"

After fixing the auth to use detached credentials, classic accounts then failed with:
- `Error(Auth, InvalidAction)` - "failed account authentication with error", `Error(Value, UnexpectedType)`

### The Root Cause

OZ Channels requires **"detached address credentials"** (`sorobanCredentialsAddress`) for all transfers. This is correct. However, **the signature format differs between classic and contract accounts**:

**For contract accounts (C...):**
- Signature is raw `BytesN<64>` ed25519 signature bytes
- The custom `__check_auth` function verifies this directly

**For classic accounts (G...):**
- Signature must be a `Vec<AccountEd25519Signature>` where each entry is a map:
  ```rust
  pub struct AccountEd25519Signature {
      pub public_key: BytesN<32>,
      pub signature: BytesN<64>,
  }
  ```
- The native account contract expects this specific format per the Soroban authorization spec
- Multiple signatures are supported for multisig accounts

Our initial implementation used raw bytes for both account types. The fix was to wrap classic account signatures in the proper struct format:

```javascript
// For classic accounts (G...), wrap signature in AccountEd25519Signature struct
const pubKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(sourceAddress);

const accountSigStruct = StellarSdk.xdr.ScVal.scvMap([
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol('public_key'),
    val: StellarSdk.xdr.ScVal.scvBytes(pubKeyBytes),
  }),
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol('signature'),
    val: StellarSdk.xdr.ScVal.scvBytes(signature),
  }),
]);

// Wrap in a Vec as required by the native account contract
const signatureScVal = StellarSdk.xdr.ScVal.scvVec([accountSigStruct]);
```

### The Solution

Both classic AND contract accounts support gasless transfers! The key difference:

1. **Contract accounts**: Use raw `BytesN<64>` signature in `SorobanAddressCredentials.signature`
2. **Classic accounts**: Use `Vec<{public_key: BytesN<32>, signature: BytesN<64>}>` in the same field

Both use `sorobanCredentialsAddress` (detached credentials) - the default `sorobanCredentialsSourceAccount` from simulation must be converted.

### Additional Capability: Gasless Contract Deployment

Since the factory contract's `create()` function doesn't require auth (anyone can deploy a contract for any public key), we can also deploy contracts via OZ Channels. This enables **fully gasless onboarding** - users can create and use their contract account without ever needing XLM in their classic account (as long as they receive XLM to their contract account first).

### Key Lessons

1. **Both account types work with gasless** - the initial "source-account credentials" error just means you need to detach the auth entry
2. **Signature formats differ by account type** - classic accounts use `Vec<AccountEd25519Signature>`, custom accounts define their own format
3. **Read the Soroban auth spec** - the `AccountEd25519Signature` struct format is defined in CAP-0046 and the soroban-env source
4. **Error messages guide you** - `Error(Value, UnexpectedType)` indicated the signature format was wrong, not the overall approach

## Challenge 12: Factory Pattern for Contract Account Deployment

### The Problem

Initially, each user deployed their own `simple_account` contract directly from their classic account (G...). The contract address was derived from the user's public key + salt, with the user as the "deployer". This meant:

1. **Contract address derivation depended on the user's address** - changing how derivation works would break existing wallets
2. **Each user needed enough XLM to pay for contract deployment** - deployment fees can be significant
3. **No central point for upgrading the WASM** - each user deploys their own copy

### The Solution

We implemented an `account_factory` contract that deploys `simple_account` instances. Key changes:

1. **Factory as deployer**: The factory contract is now the "deployer" address in the contract ID preimage. This means contract addresses are derived from `factory_address + user_public_key_as_salt`.

2. **Deterministic addresses**: The `get_address(signer_bytes)` function allows computing the contract address without deploying, useful for UI display.

3. **No authorization required**: The `create(owner_bytes)` function doesn't require auth. This is safe because only the private key holder can use the deployed contract, and enables gasless onboarding.

```rust
pub fn create(env: Env, owner_bytes: BytesN<32>) -> Address {
    let wasm_hash = env.storage().instance().get(&symbol_short!("wasm")).unwrap();

    env.deployer()
        .with_current_contract(owner_bytes.clone())
        .deploy_v2(wasm_hash, (owner_bytes,))
}
```

### Key Insights

1. **Contract address formula changes with deployer** - when moving to a factory, existing wallet addresses will change because the deployer is now the factory, not the user
2. **Salt must be unique per user** - using the public key bytes as salt ensures one-contract-per-user
3. **WASM hash stored in factory** - the factory stores which `simple_account` WASM to use, enabling future upgrades (deploy new factory with new WASM hash)

### Future Possibilities

With a factory pattern:
- **Gasless onboarding**: The factory could be called via OZ Channels to deploy contracts without users paying fees
- **WASM upgrades**: Deploy a new factory with an updated WASM hash
- **Analytics**: The factory could emit events for all deployed accounts

## Challenge 13: Formatting Stellar Operations for Human Readability

### The Problem

Displaying transaction details in a block explorer requires converting raw XDR operation data into human-readable descriptions. The Stellar network supports 26 different operation types, each with its own structure and parameters.

### Investigation

The decoded `TransactionEnvelope` XDR contains operations in various formats:
- Different naming conventions: `snake_case`, `camelCase`, `PascalCase`
- Nested structure variations: `envelope.tx.tx.operations` vs `envelope.v1.tx.operations`
- Complex nested objects for certain operations (e.g., `invoke_host_function`)

### The Solution

We created a comprehensive operation formatter (`utils/scan/operations.js`) that:

1. **Normalizes operation types** - Converts all naming conventions to `snake_case`:
   ```javascript
   function normalizeOperationType(type) {
     return type
       .replace(/([a-z])([A-Z])/g, '$1_$2')
       .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
       .toLowerCase();
   }
   ```

2. **Handles multiple envelope formats** - The decoder checks for operations in all possible locations:
   ```javascript
   // v1 envelope
   if (envelope.v1?.tx?.operations) { ... }
   // Nested tx.tx format (from stellar-xdr-json)
   else if (envelope.tx?.tx?.operations) { ... }
   // Fee bump envelope
   else if (envelope.fee_bump?.tx?.inner_tx?.v1?.tx?.operations) { ... }
   ```

3. **Generates concise descriptions** for all 26 operations:

   | Operation | Example Output |
   |-----------|---------------|
   | `create_account` | `create account GDEST with 100 XLM` |
   | `payment` | `pay 50 USDC to GDEST` |
   | `manage_sell_offer` | `sell 100 XLM for USDC at 0.5` |
   | `change_trust` | `trust USDC` or `remove trust USDC` |
   | `invoke_host_function` | `invoke transfer() on CCONT` |
   | `extend_footprint_ttl` | `extend TTL by 100000 ledgers` |

4. **Handles edge cases**:
   - Missing data returns `?` placeholders
   - Unknown operation types display normalized name
   - Offer cancellations detected by amount=0
   - Liquidity pool assets distinguished from regular assets

### Key Insights

1. **Amount formatting requires decimals** - Stellar stores amounts in stroops (1 XLM = 10^7 stroops). Different assets have different decimal places (XLM=7, USDC=6).

2. **Asset formats vary widely** - Native XLM can be represented as `"native"`, `{ native: null }`, or `{ Native: {} }`. Credit assets can use `credit_alphanum4` or `CreditAlphanum4`.

3. **Some operations have body-level values** - Operations like `account_merge` and `begin_sponsoring_future_reserves` store their main value directly in the body rather than nested in an object.

4. **Contract invocations need special handling** - `invoke_host_function` can be contract invocation, WASM upload, or contract deployment, each with different structures.

### Implementation Notes

The formatter is pure JavaScript with no external dependencies:
- **105 unit tests** covering all operation types and edge cases
- Handles both standard and non-standard XDR decoder output formats
- Gracefully degrades for malformed or incomplete data

```javascript
// Usage in transaction page
import { formatOperations } from '@/utils/scan/operations';

const ops = formatOperations(decodedEnvelope);
// Returns: [{ index: 0, type: 'payment', description: 'pay 100 XLM to GDEST', details: {...} }]
```

### Reference

All 26 Stellar operations are documented at:
https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations

## Challenge 14: OpenZeppelin Channels Sunset and Relay Mode

### The Problem

OpenZeppelin Defender stopped accepting new sign-ups on June 30, 2025 and will fully shut down on **July 1, 2026**. The `GaslessSubmitter` and `@openzeppelin/relayer-plugin-channels` dependency are effectively dead.

### Investigation

The gasless flow worked as follows:
1. Agent signs auth entries with ed25519
2. SDK extracts the host function + signed auth
3. OZ Channels relay wraps it in a funded transaction, pays fees, submits

But since no new accounts can be created, and the service will be gone in months, we needed an alternative.

### The Solution: Relay Mode

Looking at the E2E test results, the answer was already in front of us: **the owner already acts as the transaction source**. In every agent operation, the owner's keypair pays fees and signs the envelope, while the agent only signs auth entries through `__check_auth`.

We formalized this into a `relay` config option in the SDK:

```typescript
// DirectSubmitter now accepts an optional sourceKeypair
const submitter = new DirectSubmitter(agentSigner, rpc, networkConfig, {
  sourceKeypair: ownerKeypair,  // pays fees, signs envelope
});

// AgentWallet accepts relay config
const wallet = await AgentWallet.create({
  network: 'testnet',
  inviteCode: '...',
  relay: { secret: 'SDOWNER...' },  // owner pays fees
});
```

The architecture is identical to what OZ Channels did, but without the external service:
- Agent signs auth entries (custom account `__check_auth`)
- Relay account builds, pays for, and submits the transaction
- The agent's Stellar account (G...) never needs to exist

### Key Lessons

1. **Don't depend on hosted services for core functionality** — The gasless relay was always just "someone else submits the transaction for you." You can do this yourself with a funded Stellar account.
2. **The owner-as-relay pattern is simpler and more reliable** — No API keys, no external service, no rate limits. Just a funded account.
3. **For multi-agent deployments**, a simple relay server (~50 lines of Express) can replace OZ Channels entirely. The relay receives signed auth entries from agents and wraps them in funded transactions.

## Challenge 15: Phase 3 Testnet Deployment Findings

### The Problems

During the first real testnet deployment and E2E test run, three issues surfaced that weren't caught by unit tests (all of which use `mock_all_auths`).

### Finding 1: `getTransaction().returnValue` vs `resultMetaXdr.v3()`

**Problem:** After successfully submitting transactions, the result parsing code tried to extract return values via:
```javascript
response.resultMetaXdr?.v3()?.sorobanMeta()?.returnValue()
```
This failed with `"v3 not set"` — the `TransactionMeta` discriminant wasn't always v3.

**Fix:** In Stellar SDK v14, `getTransaction()` returns a `returnValue` property directly on successful responses. No need to parse the metadata XDR:
```javascript
// Before (broken)
returnValue: response.resultMetaXdr?.v3()?.sorobanMeta()?.returnValue()

// After (works)
returnValue: response.returnValue
```

### Finding 2: XLM SAC Transfers Require Destination Account to Exist

**Problem:** Agent transfer tests failed with `"account entry is missing"` when sending XLM to a random G... address. The XLM Stellar Asset Contract (SAC) requires the destination account to exist on-chain — unlike classic Stellar payments which can create accounts via `create_account`.

**Fix:** Fund the destination via friendbot before transferring, or send to an existing account. This is important for agent developers: if your agent sends XLM via `agent_transfer`, the destination must already be a funded Stellar account (or a contract address).

### Finding 3: Contract Address Extraction from Deploy Metadata

**Problem:** After deploying the factory contract, extracting the contract address from transaction metadata failed:
```
Error: The first argument must be of type string or an instance of Buffer...
Received an instance of ChildUnion
```

The `contract.contractId()` accessor on XDR `ScAddress` returns an XDR wrapper type (`ChildUnion`), not a raw Buffer.

**Fix:** Use `Address.fromScVal(response.returnValue)` from the transaction's return value (simpler and more reliable), with a fallback that handles the XDR type:
```javascript
// Primary: use returnValue directly
const addr = StellarSdk.Address.fromScVal(result.returnValue);
const contractId = addr.toString();

// Fallback: convert XDR wrapper to Buffer
const contractIdRaw = contract.contractId();
const buf = Buffer.isBuffer(contractIdRaw) ? contractIdRaw : Buffer.from(contractIdRaw);
return StellarSdk.StrKey.encodeContract(buf);
```

### Key Lessons

1. **Always test on testnet** — `mock_all_auths` hides real-world issues with transaction result parsing, account existence, and XDR type handling
2. **Use `response.returnValue`** — Don't parse `resultMetaXdr` manually; the SDK extracts it for you
3. **XLM SAC ≠ classic payments** — SAC `transfer` requires existing destination accounts; this affects agent transfer UX
4. **XDR wrappers aren't Buffers** — Always handle the possibility that XDR accessors return wrapper types

## Conclusion

Implementing a custom contract account in Stellar requires deep understanding of:
- Soroban XDR structures
- The authorization preimage format
- Transaction simulation lifecycle
- Resource management for custom auth

The SDK is designed primarily for classic accounts, so custom account support requires manual XDR manipulation. The key insight is that the preimage hash computation must use exactly the same values that end up in the final credentials - any mismatch will cause signature verification to fail.

Despite the challenges, custom contract accounts enable powerful smart wallet functionality that isn't possible with classic Stellar accounts.
