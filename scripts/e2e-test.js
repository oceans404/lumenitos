#!/usr/bin/env node
/**
 * End-to-end integration tests for the Lumenitos agent wallet system.
 *
 * Exercises real __check_auth with actual ed25519 signatures on Stellar testnet.
 * Tests the full lifecycle: invite creation, agent onboarding, transfers with
 * policy enforcement, freeze/unfreeze, and owner drain.
 *
 * Prerequisites:
 *   OWNER_SECRET  — Stellar secret key of the factory owner (the account that
 *                   deployed the factory contract and is registered as its owner).
 *   FACTORY_ADDRESS  — (optional) Override factory contract address.
 *                      Default: CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP
 *   TESTNET_RPC      — (optional) Soroban RPC URL.
 *                      Default: https://soroban-testnet.stellar.org
 *   TEST_DESTINATION — (optional) Existing Stellar account to receive test transfers.
 *                      Skips friendbot if set.
 *
 * Usage:
 *   OWNER_SECRET=SDXYZ... node scripts/e2e-test.js
 */

'use strict';

const StellarSdk = require('@stellar/stellar-sdk');

// ============================================================================
// Configuration
// ============================================================================

const TESTNET_RPC = process.env.TESTNET_RPC || 'https://soroban-testnet.stellar.org';
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || 'CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP';
const OWNER_SECRET = process.env.OWNER_SECRET;
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

// Auth entries are valid for this many ledgers (~5 min at 5s/ledger)
const AUTH_EXPIRY_LEDGER_OFFSET = 60;

// Dummy account for simulation-only (read) transactions
const SIMULATION_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

// ============================================================================
// Helpers (inlined from the TS SDK so the script is self-contained)
// ============================================================================

function computeNetworkIdHash(networkPassphrase) {
  return StellarSdk.hash(Buffer.from(networkPassphrase));
}

function toRawAmount(amount, decimals = 7) {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = abs.split('.');
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const raw = BigInt(intPart + padded);
  return negative ? -raw : raw;
}

function fromRawAmount(raw, decimals = 7) {
  const value = typeof raw === 'number' ? BigInt(raw) : raw;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const str = abs.toString().padStart(decimals + 1, '0');
  const intPart = str.slice(0, str.length - decimals);
  const fracPart = str.slice(str.length - decimals);
  const trimmedFrac = fracPart.replace(/0+$/, '');
  const result = trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart;
  return negative ? `-${result}` : result;
}

function resolveTokenContract(token, networkPassphrase) {
  if (token === 'native') {
    const xlmContractId = StellarSdk.Asset.native().contractId(networkPassphrase);
    return new StellarSdk.Contract(xlmContractId);
  }
  return new StellarSdk.Contract(token);
}

function deriveContractAddress(deployerAddress, salt, networkPassphrase) {
  if (salt.length !== 32) {
    throw new Error(`Salt must be exactly 32 bytes, got ${salt.length}`);
  }
  const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeContractId(
    new StellarSdk.xdr.HashIdPreimageContractId({
      networkId: computeNetworkIdHash(networkPassphrase),
      contractIdPreimage: StellarSdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new StellarSdk.xdr.ContractIdPreimageFromAddress({
          address: new StellarSdk.Address(deployerAddress).toScAddress(),
          salt: Buffer.from(salt),
        })
      ),
    })
  );
  const contractId = StellarSdk.hash(preimage.toXDR());
  return StellarSdk.StrKey.encodeContract(contractId);
}

/**
 * Build the default Signature struct as ScVal map:
 *   { public_key: BytesN<32>, signature: BytesN<64> }
 * Fields sorted alphabetically (Soroban #[contracttype] convention).
 */
function buildSignatureScVal(publicKeyBytes, signatureBytes) {
  return StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('public_key'),
      val: StellarSdk.xdr.ScVal.scvBytes(publicKeyBytes),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('signature'),
      val: StellarSdk.xdr.ScVal.scvBytes(signatureBytes),
    }),
  ]);
}

/** Sign a single Soroban auth entry for custom account authentication. */
function signAuthEntry(keypair, publicKeyBytes, auth, validUntilLedger, networkIdHash) {
  const addressCreds = auth.credentials().address();
  const nonce = addressCreds.nonce();

  const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new StellarSdk.xdr.HashIdPreimageSorobanAuthorization({
      networkId: networkIdHash,
      nonce,
      signatureExpirationLedger: validUntilLedger,
      invocation: auth.rootInvocation(),
    })
  );

  const payload = StellarSdk.hash(preimage.toXDR());
  const signatureBytes = keypair.sign(payload);
  const signatureScVal = buildSignatureScVal(publicKeyBytes, signatureBytes);

  const newAddressCreds = new StellarSdk.xdr.SorobanAddressCredentials({
    address: addressCreds.address(),
    nonce,
    signatureExpirationLedger: validUntilLedger,
    signature: signatureScVal,
  });

  return new StellarSdk.xdr.SorobanAuthorizationEntry({
    credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(newAddressCreds),
    rootInvocation: auth.rootInvocation(),
  });
}

/** Sign all address-credential auth entries. Non-address entries pass through unchanged. */
function signAllAuthEntries(keypair, publicKeyBytes, authEntries, validUntilLedger, networkPassphrase) {
  const networkIdHash = computeNetworkIdHash(networkPassphrase);
  return authEntries.map(entry => {
    const auth = typeof entry === 'string'
      ? StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64')
      : entry;
    if (auth.credentials().switch().name === 'sorobanCredentialsAddress') {
      return signAuthEntry(keypair, publicKeyBytes, auth, validUntilLedger, networkIdHash);
    }
    return auth;
  });
}

/** Bump instruction limit on a transaction envelope. */
function bumpInstructionLimit(txEnvelope, additional = 1_000_000) {
  const sorobanData = txEnvelope.v1().tx().ext().sorobanData();
  const resources = sorobanData.resources();
  resources.instructions(resources.instructions() + additional);
}

/** Wait for a transaction to be confirmed on-chain. */
async function waitForTransaction(rpcServer, hash, maxAttempts = 10, interval = 2000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const response = await rpcServer.getTransaction(hash);
    if (response.status === 'SUCCESS') return response;
    if (response.status === 'FAILED') {
      throw new Error(`Transaction failed: ${response.resultXdr || response.status}`);
    }
  }
  throw new Error('Transaction timed out waiting for confirmation');
}

/** Submit a transaction and wait for confirmation. */
async function submitAndWait(rpcServer, transaction) {
  const response = await rpcServer.sendTransaction(transaction);
  if (response.status === 'ERROR') {
    throw new Error(`Transaction submission error: ${JSON.stringify(response.errorResult) || 'Unknown error'}`);
  }
  if (response.status === 'PENDING') {
    return waitForTransaction(rpcServer, response.hash);
  }
  throw new Error(`Unexpected transaction status: ${response.status}`);
}

/**
 * Simulate a read-only contract call using a dummy account.
 */
async function simulateRead(rpcServer, operation) {
  const account = new StellarSdk.Account(SIMULATION_ACCOUNT, '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    const errorSim = sim;
    throw new Error(`Simulation failed: ${errorSim.error || 'Unknown error'}`);
  }
  return sim.result.retval;
}

// ============================================================================
// Transaction submission helpers
// ============================================================================

/**
 * Submit an operation using custom account auth (agent or owner signing
 * through the contract's __check_auth).
 *
 * @param {StellarSdk.rpc.Server} rpcServer
 * @param {StellarSdk.Keypair} authKeypair — the signer for auth entries (agent or owner)
 * @param {Buffer} authPublicKeyBytes — raw 32-byte ed25519 public key of the auth signer
 * @param {StellarSdk.xdr.Operation} operation
 * @param {StellarSdk.Keypair} sourceKeypair — the Stellar account that pays fees and signs the envelope
 * @returns {Promise<{hash: string, status: string, ledger: number}>}
 */
async function submitWithCustomAuth(rpcServer, authKeypair, authPublicKeyBytes, operation, sourceKeypair) {
  const sourceAccount = await rpcServer.getAccount(sourceKeypair.publicKey());

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '10000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await rpcServer.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    const errorSim = simResult;
    throw new Error(`Simulation failed: ${errorSim.error || 'Unknown error'}`);
  }

  const authEntries = simResult.result?.auth ?? [];
  const validUntilLedger = simResult.latestLedger + AUTH_EXPIRY_LEDGER_OFFSET;

  const signedAuthEntries = signAllAuthEntries(
    authKeypair, authPublicKeyBytes, authEntries, validUntilLedger, NETWORK_PASSPHRASE,
  );

  tx = StellarSdk.rpc.assembleTransaction(tx, simResult).build();

  const txXdr = tx.toXDR();
  const txEnvelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(txXdr, 'base64');
  const ops = txEnvelope.v1().tx().operations();

  if (ops.length > 0 && ops[0].body().switch().name === 'invokeHostFunction') {
    ops[0].body().invokeHostFunctionOp().auth(signedAuthEntries);
  }

  bumpInstructionLimit(txEnvelope);

  tx = new StellarSdk.Transaction(txEnvelope, NETWORK_PASSPHRASE);
  tx.sign(sourceKeypair);

  const response = await submitAndWait(rpcServer, tx);
  return {
    hash: response.txHash,
    status: 'SUCCESS',
    ledger: response.ledger,
    returnValue: response.returnValue,
  };
}

/**
 * Submit an operation with standard Stellar keypair signing (no custom account auth).
 * Used for owner operations on the factory (create_invite) where the owner's
 * Stellar address is the contract's stored owner and require_auth is checked.
 */
async function submitWithStandardAuth(rpcServer, keypair, operation) {
  const sourceAccount = await rpcServer.getAccount(keypair.publicKey());

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '10000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await rpcServer.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    const errorSim = simResult;
    throw new Error(`Simulation failed: ${errorSim.error || 'Unknown error'}`);
  }

  tx = StellarSdk.rpc.assembleTransaction(tx, simResult).build();
  tx.sign(keypair);

  const response = await submitAndWait(rpcServer, tx);
  return {
    hash: response.txHash,
    status: 'SUCCESS',
    ledger: response.ledger,
    returnValue: response.returnValue,
  };
}

// ============================================================================
// Test Framework
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;

function log(msg) {
  console.log(msg);
}

async function test(number, description, fn) {
  testCount++;
  const label = `  [${number}] ${description}`;
  try {
    const result = await fn();
    passCount++;
    log(`${label} ... PASS${result ? ` (${result})` : ''}`);
    return true;
  } catch (err) {
    failCount++;
    const errMsg = err.message || String(err);
    log(`${label} ... FAIL`);
    log(`        Error: ${errMsg}`);
    return false;
  }
}

async function testExpectFail(number, description, fn, expectedErrorSubstring) {
  testCount++;
  const label = `  [${number}] ${description}`;
  try {
    await fn();
    failCount++;
    log(`${label} ... FAIL (expected error but succeeded)`);
    return false;
  } catch (err) {
    const errMsg = (err.message || String(err));
    if (expectedErrorSubstring && !errMsg.toLowerCase().includes(expectedErrorSubstring.toLowerCase())) {
      failCount++;
      log(`${label} ... FAIL (expected error containing "${expectedErrorSubstring}", got: ${errMsg.slice(0, 120)})`);
      return false;
    }
    passCount++;
    log(`${label} ... PASS (correctly rejected: ${errMsg.slice(0, 120)})`);
    return true;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // ---- Validate prerequisites ----
  if (!OWNER_SECRET) {
    console.error(`
======================================================================
  Lumenitos E2E Test — Missing Prerequisites
======================================================================

  Required environment variables:

    OWNER_SECRET    Stellar secret key (S...) of the factory owner.
                    This is the account that deployed the factory contract
                    and is registered as its owner.

  Optional:

    FACTORY_ADDRESS Override factory contract address.
                    Default: ${FACTORY_ADDRESS}

    TESTNET_RPC     Soroban RPC URL.
                    Default: ${TESTNET_RPC}

  Usage:
    OWNER_SECRET=SDXYZ... node scripts/e2e-test.js

======================================================================
`);
    process.exit(1);
  }

  const rpcServer = new StellarSdk.rpc.Server(TESTNET_RPC);
  const ownerKeypair = StellarSdk.Keypair.fromSecret(OWNER_SECRET);
  const ownerPublicKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(ownerKeypair.publicKey());
  const factoryContract = new StellarSdk.Contract(FACTORY_ADDRESS);

  // Derive XLM SAC (Stellar Asset Contract) address
  const xlmSacAddress = StellarSdk.Asset.native().contractId(NETWORK_PASSPHRASE);
  const xlmContract = new StellarSdk.Contract(xlmSacAddress);

  log('');
  log('======================================================================');
  log('  Lumenitos Agent Wallet — End-to-End Tests (Testnet)');
  log('======================================================================');
  log('');
  log(`  RPC:             ${TESTNET_RPC}`);
  log(`  Factory:         ${FACTORY_ADDRESS}`);
  log(`  Owner:           ${ownerKeypair.publicKey()}`);
  log(`  XLM SAC:         ${xlmSacAddress}`);
  log('');

  // ========================================================================
  // Phase A: Setup
  // ========================================================================

  log('--- Phase A: Setup ---');

  // Test 1: Connect to testnet RPC
  await test(1, 'Connect to testnet RPC', async () => {
    const health = await rpcServer.getHealth();
    if (health.status !== 'healthy') throw new Error(`RPC unhealthy: ${health.status}`);
    return `ledger ${health.latestLedger}`;
  });

  // Test 2: Verify factory contract exists (read owner)
  let factoryOwnerAddress;
  await test(2, 'Verify factory contract exists (read owner)', async () => {
    const op = factoryContract.call('owner');
    const result = await simulateRead(rpcServer, op);
    factoryOwnerAddress = StellarSdk.scValToNative(result);
    // The owner stored in the factory is a Stellar Address
    return `owner = ${factoryOwnerAddress}`;
  });

  // Test 3: Generate a fresh agent keypair
  const agentKeypair = StellarSdk.Keypair.random();
  const agentPublicKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(agentKeypair.publicKey());
  let agentContractAddress;

  await test(3, 'Generate fresh agent keypair', async () => {
    // Predict the agent contract address from factory + agent public key
    agentContractAddress = deriveContractAddress(
      FACTORY_ADDRESS, agentPublicKeyBytes, NETWORK_PASSPHRASE,
    );
    return `agent G... = ${agentKeypair.publicKey().slice(0, 12)}..., predicted contract = ${agentContractAddress.slice(0, 12)}...`;
  });

  // ========================================================================
  // Phase B: Invite + Onboarding
  // ========================================================================

  log('');
  log('--- Phase B: Invite + Onboarding ---');

  // Generate a random 32-byte invite code
  const inviteCodeBytes = StellarSdk.Keypair.random().rawPublicKey();
  const inviteCodeHex = Buffer.from(inviteCodeBytes).toString('hex');

  // Build the InviteConfig for create_invite.
  // Policy: per_tx_limit 10 XLM on XLM SAC, AllowAll access, no expiry.
  // Funding: 100 XLM from factory pool.
  const PER_TX_LIMIT = 10_0000000n; // 10 XLM in stroops
  const FUNDING_AMOUNT = 100_0000000n; // 100 XLM in stroops

  /**
   * Build the InviteConfig ScVal matching the Rust struct:
   *   InviteConfig { funding: Vec<TokenAmount>, policy: AgentPolicy }
   *   TokenAmount  { token: Address, amount: i128 }
   *   AgentPolicy  { token_limits: Vec<TokenLimit>, access: AccessControl, expiry_ledger: u32 }
   *   TokenLimit   { token: Address, per_tx_limit: i128 }
   *   AccessControl::AllowAll (enum variant)
   */
  function buildInviteConfigScVal() {
    const tokenAmountScVal = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
        val: StellarSdk.nativeToScVal(FUNDING_AMOUNT, { type: 'i128' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('token'),
        val: new StellarSdk.Address(xlmSacAddress).toScVal(),
      }),
    ]);

    const fundingVec = StellarSdk.xdr.ScVal.scvVec([tokenAmountScVal]);

    const tokenLimitScVal = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('per_tx_limit'),
        val: StellarSdk.nativeToScVal(PER_TX_LIMIT, { type: 'i128' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('token'),
        val: new StellarSdk.Address(xlmSacAddress).toScVal(),
      }),
    ]);

    const tokenLimitsVec = StellarSdk.xdr.ScVal.scvVec([tokenLimitScVal]);

    // AccessControl::AllowAll — a Soroban enum variant with no data
    // Represented as scvVec with a single symbol element for unit variants
    const accessControlScVal = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvSymbol('AllowAll'),
    ]);

    const policyScVal = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('access'),
        val: accessControlScVal,
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('expiry_ledger'),
        val: StellarSdk.nativeToScVal(0, { type: 'u32' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('token_limits'),
        val: tokenLimitsVec,
      }),
    ]);

    return StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('funding'),
        val: fundingVec,
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('policy'),
        val: policyScVal,
      }),
    ]);
  }

  // Test 4: Owner creates an invite code
  await test(4, 'Owner creates invite code with policy (per_tx_limit=10 XLM)', async () => {
    const op = factoryContract.call(
      'create_invite',
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
      buildInviteConfigScVal(),
    );
    const result = await submitWithStandardAuth(rpcServer, ownerKeypair, op);
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 5: Verify invite is valid
  await test(5, 'Verify invite is valid', async () => {
    const op = factoryContract.call(
      'is_invite_valid',
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(rpcServer, op);
    const isValid = StellarSdk.scValToNative(result);
    if (!isValid) throw new Error('Invite should be valid but is not');
    return 'valid=true';
  });

  // Test 6: Agent calls factory.create() with invite code -> deployed contract
  // The factory.create() does NOT require the caller to be the agent — anyone can
  // call it. We use the owner as the transaction source (to pay fees).
  await test(6, 'Call factory.create() to deploy agent contract', async () => {
    const op = factoryContract.call(
      'create',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );
    const result = await submitWithStandardAuth(rpcServer, ownerKeypair, op);
    return `tx ${result.hash.slice(0, 12)}..., deployed at ${agentContractAddress.slice(0, 12)}...`;
  });

  // Test 7: Verify invite is now burned (invalid)
  await test(7, 'Verify invite is burned after use', async () => {
    const op = factoryContract.call(
      'is_invite_valid',
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(rpcServer, op);
    const isValid = StellarSdk.scValToNative(result);
    if (isValid) throw new Error('Invite should be burned but is still valid');
    return 'valid=false';
  });

  // Test 8: Verify agent contract exists at predicted address
  const agentContract = new StellarSdk.Contract(agentContractAddress);
  await test(8, 'Verify agent contract exists at predicted address', async () => {
    const op = agentContract.call(
      'get_agent_status',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(rpcServer, op);
    const status = StellarSdk.scValToNative(result);
    return `get_agent_status returned: ${JSON.stringify(status)}`;
  });

  // Test 9: Verify agent status is Active
  await test(9, 'Verify agent status is Active', async () => {
    const op = agentContract.call(
      'get_agent_status',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(rpcServer, op);
    const status = StellarSdk.scValToNative(result);
    // Soroban enums serialize as strings or objects
    const statusStr = typeof status === 'string' ? status : String(status);
    if (!statusStr.toLowerCase().includes('active')) {
      throw new Error(`Expected Active status, got: ${statusStr}`);
    }
    return 'status=Active';
  });

  // Test 10: Verify agent balance matches funding amount
  await test(10, 'Verify agent balance matches funding amount (~100 XLM)', async () => {
    const op = xlmContract.call(
      'balance',
      new StellarSdk.Address(agentContractAddress).toScVal(),
    );
    const result = await simulateRead(rpcServer, op);
    const rawBalance = BigInt(StellarSdk.scValToNative(result));
    const balance = fromRawAmount(rawBalance);
    // Funding is 100 XLM
    if (rawBalance < FUNDING_AMOUNT - 1_0000000n) {
      throw new Error(`Expected ~100 XLM, got ${balance}`);
    }
    return `balance=${balance} XLM`;
  });

  // ========================================================================
  // Phase C: Agent Operations (Real __check_auth!)
  // ========================================================================

  log('');
  log('--- Phase C: Agent Operations (real __check_auth) ---');

  // Destination account — use TEST_DESTINATION env var or create one via friendbot
  let destinationAddress;
  if (process.env.TEST_DESTINATION) {
    destinationAddress = process.env.TEST_DESTINATION;
    log(`  Using TEST_DESTINATION ${destinationAddress.slice(0, 10)}...`);
  } else {
    const destinationKeypair = StellarSdk.Keypair.random();
    destinationAddress = destinationKeypair.publicKey();
    try {
      const fbRes = await fetch(`https://friendbot.stellar.org?addr=${destinationAddress}`);
      if (!fbRes.ok) throw new Error(`Friendbot: ${fbRes.status}`);
      log(`  Funded destination ${destinationAddress.slice(0, 10)}... via friendbot`);
    } catch (e) {
      log(`  WARNING: Could not fund destination via friendbot: ${e.message}`);
    }
  }

  // Test 11: Agent transfers XLM under per_tx_limit (should succeed)
  await test(11, 'Agent transfers 5 XLM (under 10 XLM per_tx_limit) — should succeed', async () => {
    const transferAmount = toRawAmount('5', 7);
    const op = agentContract.call(
      'agent_transfer',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(transferAmount, { type: 'i128' }),
    );

    // Use custom account auth — agent signs through __check_auth.
    // The owner's Stellar account is the tx source (pays fees), while
    // the agent's ed25519 key signs the auth entries via __check_auth.
    const result = await submitWithCustomAuth(
      rpcServer, agentKeypair, agentPublicKeyBytes, op, ownerKeypair,
    );
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 12: Agent tries to transfer over per_tx_limit (should FAIL)
  await testExpectFail(12, 'Agent transfers 15 XLM (over 10 XLM limit) — should fail', async () => {
    const overLimitAmount = toRawAmount('15', 7);
    const op = agentContract.call(
      'agent_transfer',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(overLimitAmount, { type: 'i128' }),
    );

    await submitWithCustomAuth(
      rpcServer, agentKeypair, agentPublicKeyBytes, op, ownerKeypair,
    );
  });

  // Test 13: Read agent balance after transfer (should be reduced)
  await test(13, 'Agent balance reduced after 5 XLM transfer', async () => {
    const op = xlmContract.call(
      'balance',
      new StellarSdk.Address(agentContractAddress).toScVal(),
    );
    const result = await simulateRead(rpcServer, op);
    const rawBalance = BigInt(StellarSdk.scValToNative(result));
    const balance = fromRawAmount(rawBalance);
    // Should be ~95 XLM (100 - 5)
    const expectedMax = FUNDING_AMOUNT - toRawAmount('5', 7) + 1_0000000n; // small tolerance
    const expectedMin = FUNDING_AMOUNT - toRawAmount('5', 7) - 1_0000000n;
    if (rawBalance > expectedMax || rawBalance < expectedMin) {
      throw new Error(`Expected ~95 XLM, got ${balance}`);
    }
    return `balance=${balance} XLM`;
  });

  // ========================================================================
  // Phase D: Auth Rejection Tests (negative paths for real __check_auth)
  // Run BEFORE the drain so the agent still has funds for simulation.
  // ========================================================================

  log('');
  log('--- Phase D: Auth Rejection Tests (real __check_auth negative paths) ---');

  // Test 14: Unknown signer rejected — a random keypair (not owner, not agent)
  // tries to sign an agent_transfer. __check_auth should reject because the
  // signer is neither the owner nor a registered agent.
  // NOTE: Simulation mocks all auth, so it will succeed. The real rejection
  // happens on-chain when the signed auth entry hits __check_auth.
  await testExpectFail(14, 'Unknown signer rejected by __check_auth', async () => {
    const unknownKeypair = StellarSdk.Keypair.random();
    const unknownPublicKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(unknownKeypair.publicKey());
    const transferAmount = toRawAmount('1', 7);

    const op = agentContract.call(
      'agent_transfer',
      StellarSdk.nativeToScVal(unknownPublicKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(transferAmount, { type: 'i128' }),
    );

    await submitWithCustomAuth(
      rpcServer, unknownKeypair, unknownPublicKeyBytes, op, ownerKeypair,
    );
  });

  // Test 15: Agent key spoofing — agent signs auth entry but claims to be a
  // different agent_key in the function args. __check_auth should reject because
  // the agent_key arg (first arg in auth context) does not match the actual signer.
  await testExpectFail(15, 'Agent key spoofing rejected (agent_key arg != signer)', async () => {
    // Create a fake agent_key that differs from the actual signer
    const fakeAgentKeyBytes = StellarSdk.Keypair.random().rawPublicKey();
    const transferAmount = toRawAmount('1', 7);

    const op = agentContract.call(
      'agent_transfer',
      // Pass a fake agent_key as the first arg — does NOT match agentKeypair
      StellarSdk.nativeToScVal(fakeAgentKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(transferAmount, { type: 'i128' }),
    );

    // The actual signer is agentKeypair, but the agent_key arg is fakeAgentKeyBytes
    await submitWithCustomAuth(
      rpcServer, agentKeypair, agentPublicKeyBytes, op, ownerKeypair,
    );
  });

  // Test 16: Invite replay — try to use the burned invite code again with
  // a new agent key. Should fail because the invite was already consumed.
  await testExpectFail(16, 'Invite replay rejected (burned invite code)', async () => {
    const replayAgentKey = StellarSdk.Keypair.random().rawPublicKey();
    const op = factoryContract.call(
      'create',
      StellarSdk.nativeToScVal(replayAgentKey, { type: 'bytes' }),
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );

    await submitWithStandardAuth(rpcServer, ownerKeypair, op);
  });

  // ========================================================================
  // Phase E: Owner Operations
  // ========================================================================

  log('');
  log('--- Phase E: Owner Operations ---');

  // Test 17: Owner freezes agent
  // Owner calls freeze_agent on the agent contract. The owner signs through
  // the agent contract's __check_auth (owner key is stored in the contract).
  await test(17, 'Owner freezes agent', async () => {
    const op = agentContract.call(
      'freeze_agent',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
    );
    // Owner signs through the agent contract's __check_auth
    const result = await submitWithCustomAuth(
      rpcServer, ownerKeypair, ownerPublicKeyBytes, op, ownerKeypair,
    );
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 18: Verify agent status is Frozen
  await test(18, 'Verify agent status is Frozen', async () => {
    const op = agentContract.call(
      'get_agent_status',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(rpcServer, op);
    const status = StellarSdk.scValToNative(result);
    const statusStr = typeof status === 'string' ? status : String(status);
    if (!statusStr.toLowerCase().includes('frozen')) {
      throw new Error(`Expected Frozen status, got: ${statusStr}`);
    }
    return 'status=Frozen';
  });

  // Test 19: Agent tries transfer while frozen (should FAIL)
  await testExpectFail(19, 'Agent transfer while frozen — should fail', async () => {
    const transferAmount = toRawAmount('1', 7);
    const op = agentContract.call(
      'agent_transfer',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(transferAmount, { type: 'i128' }),
    );

    await submitWithCustomAuth(
      rpcServer, agentKeypair, agentPublicKeyBytes, op, ownerKeypair,
    );
  });

  // Test 20: Owner unfreezes agent
  await test(20, 'Owner unfreezes agent', async () => {
    const op = agentContract.call(
      'unfreeze_agent',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
    );
    const result = await submitWithCustomAuth(
      rpcServer, ownerKeypair, ownerPublicKeyBytes, op, ownerKeypair,
    );
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 21: Agent transfers again after unfreeze (should succeed)
  await test(21, 'Agent transfers 2 XLM after unfreeze — should succeed', async () => {
    const transferAmount = toRawAmount('2', 7);
    const op = agentContract.call(
      'agent_transfer',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(transferAmount, { type: 'i128' }),
    );

    const result = await submitWithCustomAuth(
      rpcServer, agentKeypair, agentPublicKeyBytes, op, ownerKeypair,
    );
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 22: Owner drains remaining funds
  await test(22, 'Owner drains remaining agent funds', async () => {
    // First, read the current balance
    const balOp = xlmContract.call(
      'balance',
      new StellarSdk.Address(agentContractAddress).toScVal(),
    );
    const balResult = await simulateRead(rpcServer, balOp);
    const rawBalance = BigInt(StellarSdk.scValToNative(balResult));

    if (rawBalance <= 0n) {
      throw new Error('Agent balance is already 0');
    }

    const op = agentContract.call(
      'drain',
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(ownerKeypair.publicKey()).toScVal(),
      StellarSdk.nativeToScVal(rawBalance, { type: 'i128' }),
    );

    const result = await submitWithCustomAuth(
      rpcServer, ownerKeypair, ownerPublicKeyBytes, op, ownerKeypair,
    );
    return `drained ${fromRawAmount(rawBalance)} XLM, tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 23: Verify balance is ~0
  await test(23, 'Verify agent balance is ~0 after drain', async () => {
    const op = xlmContract.call(
      'balance',
      new StellarSdk.Address(agentContractAddress).toScVal(),
    );
    const result = await simulateRead(rpcServer, op);
    const rawBalance = BigInt(StellarSdk.scValToNative(result));
    const balance = fromRawAmount(rawBalance);

    if (rawBalance > 1_0000000n) { // more than 1 XLM remaining = unexpected
      throw new Error(`Expected ~0 XLM, got ${balance}`);
    }
    return `balance=${balance} XLM`;
  });

  // ========================================================================
  // Summary
  // ========================================================================

  log('');
  log('======================================================================');
  log(`  Results: ${passCount} passed, ${failCount} failed, ${testCount} total`);
  log('======================================================================');
  log('');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
