#!/usr/bin/env node
/**
 * End-to-end test for the Lumenitos agent wallet system using the
 * OpenZeppelin Relayer for fee-free agent transactions.
 *
 * This proves the full relayer integration: agents can submit transactions
 * (onboard, transfer) without holding XLM for fees — the relayer pays.
 *
 * Prerequisites:
 *   OWNER_SECRET    — Stellar secret key of the factory owner.
 *   RELAYER_URL     — OZ Relayer base URL (default: http://localhost:8080).
 *   RELAYER_API_KEY — API key for the relayer.
 *   FACTORY_ADDRESS    — (optional) Override factory contract address.
 *   TESTNET_RPC        — (optional) Soroban RPC URL.
 *   TEST_DESTINATION   — (optional) Existing Stellar account to receive test transfers.
 *                        Skips friendbot if set.
 *
 * Usage:
 *   OWNER_SECRET=SDXYZ... RELAYER_API_KEY=... node scripts/e2e-test-relayer.js
 */

'use strict';

const StellarSdk = require('@stellar/stellar-sdk');

// ============================================================================
// Configuration
// ============================================================================

const TESTNET_RPC = process.env.TESTNET_RPC || 'https://soroban-testnet.stellar.org';
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || 'CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP';
const OWNER_SECRET = process.env.OWNER_SECRET;
const RELAYER_URL = process.env.RELAYER_URL || 'http://localhost:8080';
const RELAYER_API_KEY = process.env.RELAYER_API_KEY || 'test-api-key-lumenitos-dev-32chars!!';
const RELAYER_ID = process.env.RELAYER_ID || 'stellar-testnet';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

const AUTH_EXPIRY_LEDGER_OFFSET = 60;
const SIMULATION_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

// ============================================================================
// Helpers (same as e2e-test.js — inlined for self-containment)
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

function deriveContractAddress(deployerAddress, salt, networkPassphrase) {
  if (salt.length !== 32) throw new Error(`Salt must be exactly 32 bytes, got ${salt.length}`);
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

function bumpInstructionLimit(txEnvelope, additional = 1_000_000) {
  const sorobanData = txEnvelope.v1().tx().ext().sorobanData();
  const resources = sorobanData.resources();
  resources.instructions(resources.instructions() + additional);
}

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
    throw new Error(`Simulation failed: ${sim.error || 'Unknown error'}`);
  }
  return sim.result.retval;
}

// Owner direct submission (for create_invite — owner has a funded account)
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
    throw new Error(`Simulation failed: ${simResult.error || 'Unknown error'}`);
  }
  tx = StellarSdk.rpc.assembleTransaction(tx, simResult).build();
  tx.sign(keypair);
  const response = await submitAndWait(rpcServer, tx);
  return { hash: response.txHash, status: 'SUCCESS', ledger: response.ledger, returnValue: response.returnValue };
}

// ============================================================================
// Relayer Submission — ScVal to JSON conversion + HTTP POST
// ============================================================================

/**
 * Convert a Stellar SDK ScVal to the JSON format expected by the OZ Relayer.
 * The relayer uses serde_json::from_value::<ScVal>() from the stellar-xdr crate.
 */
function scValToJson(scVal) {
  const type = scVal.switch();

  switch (type.value) {
    case StellarSdk.xdr.ScValType.scvBool().value:
      return { bool: scVal.b() };
    case StellarSdk.xdr.ScValType.scvVoid().value:
      return { void: null };
    case StellarSdk.xdr.ScValType.scvU32().value:
      return { u32: scVal.u32() };
    case StellarSdk.xdr.ScValType.scvI32().value:
      return { i32: scVal.i32() };
    case StellarSdk.xdr.ScValType.scvU64().value:
      return { u64: scVal.u64().toString() };
    case StellarSdk.xdr.ScValType.scvI64().value:
      return { i64: scVal.i64().toString() };
    case StellarSdk.xdr.ScValType.scvU128().value: {
      const parts = scVal.u128();
      return { u128: { hi: parts.hi().toString(), lo: parts.lo().toString() } };
    }
    case StellarSdk.xdr.ScValType.scvI128().value: {
      const parts = scVal.i128();
      return { i128: { hi: parts.hi().toString(), lo: parts.lo().toString() } };
    }
    case StellarSdk.xdr.ScValType.scvBytes().value:
      return { bytes: Buffer.from(scVal.bytes()).toString('hex') };
    case StellarSdk.xdr.ScValType.scvString().value:
      return { string: scVal.str().toString() };
    case StellarSdk.xdr.ScValType.scvSymbol().value:
      return { symbol: scVal.sym().toString() };
    case StellarSdk.xdr.ScValType.scvAddress().value: {
      const addr = StellarSdk.Address.fromScAddress(scVal.address());
      return { address: addr.toString() };
    }
    case StellarSdk.xdr.ScValType.scvVec().value: {
      const vec = scVal.vec() || [];
      return { vec: vec.map(v => scValToJson(v)) };
    }
    case StellarSdk.xdr.ScValType.scvMap().value: {
      const map = scVal.map() || [];
      return {
        map: map.map(entry => ({
          key: scValToJson(entry.key()),
          val: scValToJson(entry.val()),
        })),
      };
    }
    default:
      throw new Error(`scValToJson: unsupported ScVal type "${type.name}"`);
  }
}

/**
 * Extract contract address, function name, and args from an invokeHostFunction operation.
 */
function extractInvokeContractDetails(operation) {
  const body = operation.body();
  if (body.switch().name !== 'invokeHostFunction') {
    throw new Error(`Only invokeHostFunction operations supported, got: ${body.switch().name}`);
  }
  const hostFn = body.invokeHostFunctionOp().hostFunction();
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Error(`Only invokeContract host functions supported, got: ${hostFn.switch().name}`);
  }
  const invokeArgs = hostFn.invokeContract();
  const contractAddress = StellarSdk.Address.fromScAddress(invokeArgs.contractAddress()).toString();
  const functionName = invokeArgs.functionName().toString();
  const args = invokeArgs.args();
  return { contractAddress, functionName, args };
}

/**
 * Submit a contract call via the OZ Relayer.
 *
 * Flow:
 * 1. Build dummy tx and simulate to get auth entries
 * 2. Sign auth entries with the agent's key (custom account __check_auth)
 * 3. POST to relayer with operation details + signed auth XDR
 * 4. Poll relayer for transaction confirmation
 */
async function submitViaRelayer(rpcServer, authKeypair, authPublicKeyBytes, operation) {
  // 1. Simulate
  const dummyAccount = new StellarSdk.Account(SIMULATION_ACCOUNT, '0');
  const tx = new StellarSdk.TransactionBuilder(dummyAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await rpcServer.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error || 'Unknown error'}`);
  }

  // 2. Sign auth entries
  const authEntries = simResult.result?.auth ?? [];
  const validUntilLedger = simResult.latestLedger + AUTH_EXPIRY_LEDGER_OFFSET;
  const signedAuthEntries = signAllAuthEntries(
    authKeypair, authPublicKeyBytes, authEntries, validUntilLedger, NETWORK_PASSPHRASE,
  );
  const authXdrStrings = signedAuthEntries.map(entry => entry.toXDR('base64'));

  // 3. Extract operation details and build relayer request
  const details = extractInvokeContractDetails(operation);
  const argsJson = details.args.map(arg => scValToJson(arg));

  const requestBody = {
    network: 'testnet',
    operations: [{
      type: 'invoke_contract',
      contract_address: details.contractAddress,
      function_name: details.functionName,
      args: argsJson,
      auth: {
        type: 'xdr',
        entries: authXdrStrings,
      },
    }],
  };

  // 4. POST to relayer
  const url = `${RELAYER_URL}/api/v1/relayers/${RELAYER_ID}/transactions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RELAYER_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Relayer API error (${response.status}): ${errorText}`);
  }

  const apiResponse = await response.json();
  if (!apiResponse.success || !apiResponse.data) {
    throw new Error(`Relayer API error: ${apiResponse.error || 'Unknown error'}`);
  }

  const txData = apiResponse.data;

  // 5. Poll for confirmation
  if (['pending', 'sent', 'submitted'].includes(txData.status)) {
    return pollRelayerTransaction(txData.id);
  }

  if (txData.status === 'confirmed') {
    return { hash: txData.hash || txData.id, status: 'SUCCESS' };
  }

  throw new Error(`Relayer transaction ${txData.status}: ${txData.status_reason || 'Unknown'}`);
}

async function pollRelayerTransaction(transactionId, maxAttempts = 20, interval = 3000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    const url = `${RELAYER_URL}/api/v1/relayers/${RELAYER_ID}/transactions/${transactionId}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${RELAYER_API_KEY}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Relayer status check error (${response.status}): ${errorText}`);
    }

    const apiResponse = await response.json();
    if (!apiResponse.success || !apiResponse.data) {
      throw new Error(`Relayer status API error: ${apiResponse.error || 'Unknown'}`);
    }

    const status = apiResponse.data;

    if (status.status === 'confirmed') {
      return { hash: status.hash || status.id, status: 'SUCCESS' };
    }

    if (['failed', 'canceled', 'expired'].includes(status.status)) {
      throw new Error(`Relayer transaction ${status.status}: ${status.status_reason || 'Unknown'}`);
    }

    // Still pending — continue polling
  }

  throw new Error(`Relayer transaction timed out after ${maxAttempts} attempts (tx: ${transactionId})`);
}

// ============================================================================
// Test Framework
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;

function log(msg) { console.log(msg); }

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
    log(`${label} ... FAIL`);
    log(`        Error: ${err.message || String(err)}`);
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (!OWNER_SECRET) {
    console.error(`
======================================================================
  Lumenitos E2E Relayer Test — Missing Prerequisites
======================================================================

  Required environment variables:

    OWNER_SECRET    Stellar secret key (S...) of the factory owner.
    RELAYER_API_KEY API key for the OZ Relayer.

  Optional:

    RELAYER_URL     OZ Relayer base URL (default: ${RELAYER_URL})
    RELAYER_ID      Relayer ID (default: ${RELAYER_ID})
    FACTORY_ADDRESS Factory contract address (default: ${FACTORY_ADDRESS})
    TESTNET_RPC     Soroban RPC URL (default: ${TESTNET_RPC})

  Usage:
    OWNER_SECRET=SDXYZ... RELAYER_API_KEY=... node scripts/e2e-test-relayer.js

======================================================================
`);
    process.exit(1);
  }

  const rpcServer = new StellarSdk.rpc.Server(TESTNET_RPC);
  const ownerKeypair = StellarSdk.Keypair.fromSecret(OWNER_SECRET);
  const ownerPublicKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(ownerKeypair.publicKey());
  const factoryContract = new StellarSdk.Contract(FACTORY_ADDRESS);
  const xlmSacAddress = StellarSdk.Asset.native().contractId(NETWORK_PASSPHRASE);
  const xlmContract = new StellarSdk.Contract(xlmSacAddress);

  log('');
  log('======================================================================');
  log('  Lumenitos Agent Wallet — E2E Relayer Test (Testnet)');
  log('======================================================================');
  log('');
  log(`  RPC:             ${TESTNET_RPC}`);
  log(`  Factory:         ${FACTORY_ADDRESS}`);
  log(`  Owner:           ${ownerKeypair.publicKey()}`);
  log(`  Relayer URL:     ${RELAYER_URL}`);
  log(`  Relayer ID:      ${RELAYER_ID}`);
  log(`  XLM SAC:         ${xlmSacAddress}`);
  log('');

  // ========================================================================
  // Phase A: Setup & Connectivity
  // ========================================================================

  log('--- Phase A: Setup & Connectivity ---');

  await test(1, 'Connect to testnet RPC', async () => {
    const health = await rpcServer.getHealth();
    if (health.status !== 'healthy') throw new Error(`RPC unhealthy: ${health.status}`);
    return `ledger ${health.latestLedger}`;
  });

  await test(2, 'Relayer is reachable', async () => {
    // The relayer should respond to a GET on its base path or health endpoint
    const response = await fetch(`${RELAYER_URL}/api/v1/relayers/${RELAYER_ID}`, {
      headers: { 'Authorization': `Bearer ${RELAYER_API_KEY}` },
    });
    if (!response.ok) {
      throw new Error(`Relayer returned ${response.status}: ${await response.text()}`);
    }
    return 'OK';
  });

  // Generate agent keypair (agent has NO funded Stellar account)
  const agentKeypair = StellarSdk.Keypair.random();
  const agentPublicKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(agentKeypair.publicKey());
  const agentContractAddress = deriveContractAddress(
    FACTORY_ADDRESS, agentPublicKeyBytes, NETWORK_PASSPHRASE,
  );

  await test(3, 'Generate fresh agent keypair (unfunded)', async () => {
    return `agent = ${agentKeypair.publicKey().slice(0, 12)}..., predicted contract = ${agentContractAddress.slice(0, 12)}...`;
  });

  // ========================================================================
  // Phase B: Invite + Onboarding via Relayer
  // ========================================================================

  log('');
  log('--- Phase B: Invite + Onboarding ---');

  const inviteCodeBytes = StellarSdk.Keypair.random().rawPublicKey();
  const PER_TX_LIMIT = 10_0000000n;
  const FUNDING_AMOUNT = 100_0000000n;

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
        val: StellarSdk.xdr.ScVal.scvVec([tokenLimitScVal]),
      }),
    ]);
    return StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('funding'),
        val: StellarSdk.xdr.ScVal.scvVec([tokenAmountScVal]),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('policy'),
        val: policyScVal,
      }),
    ]);
  }

  // Test 4: Owner creates invite (uses DirectSubmitter — owner has funds)
  await test(4, 'Owner creates invite code (direct submission)', async () => {
    const op = factoryContract.call(
      'create_invite',
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
      buildInviteConfigScVal(),
    );
    const result = await submitWithStandardAuth(rpcServer, ownerKeypair, op);
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 5: Agent onboards via factory.create() using the RELAYER
  // The factory.create() call doesn't require custom auth (anyone can call it),
  // but we submit it through the relayer so the agent doesn't need to pay fees.
  // NOTE: factory.create() uses standard auth (no __check_auth), so we submit
  // it as a simple contract call without custom auth signing.
  await test(5, 'Agent onboards via factory.create() through RELAYER', async () => {
    const op = factoryContract.call(
      'create',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );

    // For factory.create(), there's no custom account auth — it's a public function.
    // We still use submitViaRelayer but with a dummy signer (auth entries will be empty
    // or source-account type, which the relayer handles automatically).
    const details = extractInvokeContractDetails(op);
    const argsJson = details.args.map(arg => scValToJson(arg));

    const requestBody = {
      network: 'testnet',
      operations: [{
        type: 'invoke_contract',
        contract_address: details.contractAddress,
        function_name: details.functionName,
        args: argsJson,
      }],
    };

    const url = `${RELAYER_URL}/api/v1/relayers/${RELAYER_ID}/transactions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAYER_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Relayer API error (${response.status}): ${errorText}`);
    }

    const apiResponse = await response.json();
    if (!apiResponse.success || !apiResponse.data) {
      throw new Error(`Relayer error: ${apiResponse.error || 'Unknown'}`);
    }

    const txData = apiResponse.data;
    let result;
    if (['pending', 'sent', 'submitted'].includes(txData.status)) {
      result = await pollRelayerTransaction(txData.id);
    } else if (txData.status === 'confirmed') {
      result = { hash: txData.hash || txData.id, status: 'SUCCESS' };
    } else {
      throw new Error(`Unexpected relayer status: ${txData.status}`);
    }

    return `tx ${result.hash.slice(0, 12)}..., deployed at ${agentContractAddress.slice(0, 12)}...`;
  });

  // Test 6: Verify agent contract exists and is Active
  const agentContract = new StellarSdk.Contract(agentContractAddress);
  await test(6, 'Verify agent contract is Active', async () => {
    const op = agentContract.call(
      'get_agent_status',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(rpcServer, op);
    const status = StellarSdk.scValToNative(result);
    const statusStr = typeof status === 'string' ? status : String(status);
    if (!statusStr.toLowerCase().includes('active')) {
      throw new Error(`Expected Active, got: ${statusStr}`);
    }
    return 'status=Active';
  });

  // Test 7: Verify agent got funded
  await test(7, 'Verify agent balance matches funding (~100 XLM)', async () => {
    const op = xlmContract.call(
      'balance',
      new StellarSdk.Address(agentContractAddress).toScVal(),
    );
    const result = await simulateRead(rpcServer, op);
    const rawBalance = BigInt(StellarSdk.scValToNative(result));
    const balance = fromRawAmount(rawBalance);
    if (rawBalance < FUNDING_AMOUNT - 1_0000000n) {
      throw new Error(`Expected ~100 XLM, got ${balance}`);
    }
    return `balance=${balance} XLM`;
  });

  // ========================================================================
  // Phase C: Agent Transfer via Relayer (real __check_auth!)
  // ========================================================================

  log('');
  log('--- Phase C: Agent Transfer via Relayer ---');

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

  // Test 8: Agent transfers XLM via RELAYER (agent has no funded Stellar account!)
  await test(8, 'Agent transfers 5 XLM via RELAYER (agent has no Stellar account)', async () => {
    const transferAmount = toRawAmount('5', 7);
    const op = agentContract.call(
      'agent_transfer',
      StellarSdk.nativeToScVal(agentPublicKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(xlmSacAddress).toScVal(),
      new StellarSdk.Address(destinationAddress).toScVal(),
      StellarSdk.nativeToScVal(transferAmount, { type: 'i128' }),
    );

    // Agent signs auth entries via __check_auth, relayer pays fees and submits
    const result = await submitViaRelayer(rpcServer, agentKeypair, agentPublicKeyBytes, op);
    return `tx ${result.hash.slice(0, 12)}...`;
  });

  // Test 9: Verify balance after transfer
  await test(9, 'Agent balance reduced after 5 XLM transfer', async () => {
    const op = xlmContract.call(
      'balance',
      new StellarSdk.Address(agentContractAddress).toScVal(),
    );
    const result = await simulateRead(rpcServer, op);
    const rawBalance = BigInt(StellarSdk.scValToNative(result));
    const balance = fromRawAmount(rawBalance);
    const expectedMax = FUNDING_AMOUNT - toRawAmount('5', 7) + 1_0000000n;
    const expectedMin = FUNDING_AMOUNT - toRawAmount('5', 7) - 1_0000000n;
    if (rawBalance > expectedMax || rawBalance < expectedMin) {
      throw new Error(`Expected ~95 XLM, got ${balance}`);
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
