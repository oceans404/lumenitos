#!/usr/bin/env node
/**
 * Deploy simple_account WASM and account_factory contract to Stellar testnet.
 *
 * Usage:
 *   STELLAR_TESTNET_SECRET=SXXX node scripts/deploy-testnet.js
 *
 * If STELLAR_TESTNET_SECRET is not set, a fresh keypair is generated and funded via friendbot.
 */

const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fundViaFriendbot(publicKey) {
  const url = `${FRIENDBOT_URL}?addr=${publicKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Friendbot funding failed (${res.status}): ${body}`);
  }
  console.log(`  Funded ${publicKey} via friendbot`);
}

async function waitForTx(rpcServer, txHash, label) {
  console.log(`  Waiting for ${label} confirmation...`);
  let result;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    result = await rpcServer.getTransaction(txHash);
    if (result.status !== 'NOT_FOUND') break;
  }
  if (result.status === 'SUCCESS') {
    console.log(`  ${label} confirmed!`);
    return result;
  }
  if (result.status === 'NOT_FOUND') {
    throw new Error(`${label} timed out after 120s — transaction ${txHash} not found on ledger`);
  }
  console.error(`  ${label} failed:`, JSON.stringify(result, null, 2));
  throw new Error(`${label} failed with status: ${result.status}`);
}

function extractContractIdFromMeta(metaXdr) {
  try {
    const meta = StellarSdk.xdr.TransactionMeta.fromXDR(metaXdr, 'base64');
    const v3 = meta.v3();
    const ops = v3.operations();
    for (const op of ops) {
      const changes = op.changes();
      for (const change of changes) {
        if (change.switch().name === 'ledgerEntryCreated') {
          const entry = change.created();
          const data = entry.data();
          if (data.switch().name === 'contractData') {
            const contractData = data.contractData();
            const contract = contractData.contract();
            if (contract.switch().name === 'scAddressTypeContract') {
              const contractIdRaw = contract.contractId();
              // contractId() may return a Buffer or an XDR wrapper — ensure it's a Buffer
              const buf = Buffer.isBuffer(contractIdRaw) ? contractIdRaw : Buffer.from(contractIdRaw);
              return StellarSdk.StrKey.encodeContract(buf);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('  Error extracting contract ID:', e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async function uploadWasm(rpcServer, keypair, wasmPath, name) {
  console.log(`\n[UPLOAD] ${name}`);

  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmHash = StellarSdk.hash(wasmBuffer).toString('hex');
  console.log(`  WASM hash: ${wasmHash}`);
  console.log(`  WASM size: ${wasmBuffer.length} bytes`);

  // Check if already installed
  try {
    const ledgerKey = StellarSdk.xdr.LedgerKey.contractCode(
      new StellarSdk.xdr.LedgerKeyContractCode({
        hash: Buffer.from(wasmHash, 'hex'),
      })
    );
    const entries = await rpcServer.getLedgerEntries(ledgerKey);
    if (entries.entries && entries.entries.length > 0) {
      console.log(`  Already installed on testnet — skipping upload`);
      return wasmHash;
    }
  } catch (_) {
    // Not found, proceed
  }

  const sourceAccount = await rpcServer.getAccount(keypair.publicKey());

  const uploadOp = StellarSdk.Operation.invokeHostFunction({
    func: StellarSdk.xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasmBuffer),
    auth: [],
  });

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '10000000', // 1 XLM fee budget for testnet (generous)
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(uploadOp)
    .setTimeout(300)
    .build();

  tx = await rpcServer.prepareTransaction(tx);
  tx.sign(keypair);

  console.log(`  Submitting upload tx...`);
  const response = await rpcServer.sendTransaction(tx);

  if (response.status === 'PENDING') {
    await waitForTx(rpcServer, response.hash, `${name} upload`);
    return wasmHash;
  } else if (response.status === 'ERROR') {
    console.error('  Transaction error:', JSON.stringify(response, null, 2));
    throw new Error(`${name} WASM upload failed`);
  }

  return wasmHash;
}

async function deployFactory(rpcServer, keypair, simpleAccountWasmHash) {
  console.log(`\n[DEPLOY] account_factory`);

  // 1. Upload factory WASM
  const factoryWasmPath = path.join(__dirname, '../contracts/account_factory/target/wasm32v1-none/release/account_factory.wasm');
  const factoryWasmHash = await uploadWasm(rpcServer, keypair, factoryWasmPath, 'account_factory');

  // 2. Build constructor args
  //    __constructor(env, wasm_hash: BytesN<32>, owner: Address, owner_key: BytesN<32>)
  const wasmHashScVal = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(simpleAccountWasmHash, 'hex'));
  const ownerScVal = new StellarSdk.Address(keypair.publicKey()).toScVal();
  const ownerKeyScVal = StellarSdk.xdr.ScVal.scvBytes(
    StellarSdk.StrKey.decodeEd25519PublicKey(keypair.publicKey())
  );

  // 3. Create deterministic salt from deployer key
  const salt = StellarSdk.hash(Buffer.from(keypair.publicKey()));

  const createContractArgs = new StellarSdk.xdr.CreateContractArgsV2({
    contractIdPreimage: StellarSdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new StellarSdk.xdr.ContractIdPreimageFromAddress({
        address: new StellarSdk.Address(keypair.publicKey()).toScAddress(),
        salt: salt,
      })
    ),
    executable: StellarSdk.xdr.ContractExecutable.contractExecutableWasm(
      Buffer.from(factoryWasmHash, 'hex')
    ),
    constructorArgs: [wasmHashScVal, ownerScVal, ownerKeyScVal],
  });

  const deployOp = StellarSdk.Operation.invokeHostFunction({
    func: StellarSdk.xdr.HostFunction.hostFunctionTypeCreateContractV2(createContractArgs),
    auth: [],
  });

  const sourceAccount = await rpcServer.getAccount(keypair.publicKey());

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '10000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(deployOp)
    .setTimeout(300)
    .build();

  tx = await rpcServer.prepareTransaction(tx);
  tx.sign(keypair);

  console.log(`  Submitting deploy tx...`);
  const response = await rpcServer.sendTransaction(tx);

  if (response.status === 'PENDING') {
    const result = await waitForTx(rpcServer, response.hash, 'factory deploy');
    // Try returnValue first (createContractV2 returns the contract address as ScVal)
    let contractId = null;
    if (result.returnValue) {
      try {
        const addr = StellarSdk.Address.fromScVal(result.returnValue);
        contractId = addr.toString();
      } catch (_) {}
    }
    // Fallback to metadata extraction
    if (!contractId) {
      contractId = extractContractIdFromMeta(result.resultMetaXdr);
    }
    if (!contractId) {
      throw new Error('Could not extract factory contract address from transaction metadata');
    }
    return { contractId, factoryWasmHash };
  } else if (response.status === 'ERROR') {
    console.error('  Transaction error:', JSON.stringify(response, null, 2));
    throw new Error('Factory deployment failed');
  }

  throw new Error('Unexpected transaction response status: ' + response.status);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('============================================================');
  console.log('  Lumenitos Agent Wallet — Testnet Deployment');
  console.log('============================================================\n');

  // Step 1: Keypair
  console.log('[1/4] Setting up deployer keypair');
  let keypair;
  let generated = false;

  if (process.env.STELLAR_TESTNET_SECRET) {
    keypair = StellarSdk.Keypair.fromSecret(process.env.STELLAR_TESTNET_SECRET);
    console.log(`  Using existing keypair from STELLAR_TESTNET_SECRET`);
  } else {
    keypair = StellarSdk.Keypair.random();
    generated = true;
    console.log(`  Generated fresh keypair`);
    console.log(`  Funding via friendbot...`);
    await fundViaFriendbot(keypair.publicKey());
  }

  console.log(`  Public key:  ${keypair.publicKey()}`);
  if (generated) {
    console.log(`  Secret key:  ${keypair.secret()}`);
    console.log(`  WARNING: Save this secret key securely! You need it as factory owner.`);
    console.log(`  It will not be shown again.`);
  }

  const rpcServer = new StellarSdk.rpc.Server(TESTNET_RPC, { allowHttp: false });

  // Verify account exists
  try {
    await rpcServer.getAccount(keypair.publicKey());
    console.log(`  Account verified on testnet`);
  } catch (e) {
    if (!generated) {
      console.log(`  Account not found — funding via friendbot...`);
      await fundViaFriendbot(keypair.publicKey());
    } else {
      throw new Error(`Account not found after friendbot funding: ${e.message}`);
    }
  }

  // Step 2: Upload simple_account WASM
  console.log('\n[2/4] Uploading simple_account WASM');
  const simpleAccountPath = path.join(__dirname, '../contracts/simple_account/target/wasm32v1-none/release/simple_account.wasm');
  if (!fs.existsSync(simpleAccountPath)) {
    throw new Error(`simple_account WASM not found at ${simpleAccountPath}\n  Run: cd contracts/simple_account && stellar contract build`);
  }
  const simpleAccountWasmHash = await uploadWasm(rpcServer, keypair, simpleAccountPath, 'simple_account');

  // Step 3: Deploy factory
  console.log('\n[3/4] Deploying account_factory');
  const factoryWasmPath2 = path.join(__dirname, '../contracts/account_factory/target/wasm32v1-none/release/account_factory.wasm');
  if (!fs.existsSync(factoryWasmPath2)) {
    throw new Error(`account_factory WASM not found at ${factoryWasmPath2}\n  Run: cd contracts/account_factory && stellar contract build`);
  }
  const { contractId: factoryAddress, factoryWasmHash } = await deployFactory(
    rpcServer, keypair, simpleAccountWasmHash
  );

  // Step 4: Summary
  console.log('\n[4/4] Deployment complete!');
  console.log('\n============================================================');
  console.log('  DEPLOYMENT SUMMARY');
  console.log('============================================================');
  console.log(`  Network:                   Stellar Testnet`);
  console.log(`  RPC:                       ${TESTNET_RPC}`);
  console.log(`  Owner (deployer) address:  ${keypair.publicKey()}`);
  console.log(`  Owner raw key (hex):       ${Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(keypair.publicKey())).toString('hex')}`);
  console.log(`  simple_account WASM hash:  ${simpleAccountWasmHash}`);
  console.log(`  account_factory WASM hash: ${factoryWasmHash}`);
  console.log(`  Factory contract address:  ${factoryAddress}`);

  console.log('\n============================================================');
  console.log('  ENVIRONMENT VARIABLES');
  console.log('============================================================');
  console.log(`  NEXT_PUBLIC_SIMPLE_ACCOUNT_WASM_HASH=${simpleAccountWasmHash}`);
  console.log(`  NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS=${factoryAddress}`);
  console.log(`  NEXT_PUBLIC_ACCOUNT_FACTORY_WASM_HASH=${factoryWasmHash}`);

  console.log('\n============================================================');
  console.log('  NEXT STEPS');
  console.log('============================================================');
  console.log(`  1. Fund the factory with XLM:`);
  console.log(`     STELLAR_TESTNET_SECRET=<your-secret> node scripts/fund-factory.js ${factoryAddress}`);
  console.log(`  2. Create an invite code:`);
  console.log(`     STELLAR_TESTNET_SECRET=<your-secret> node scripts/create-invite.js ${factoryAddress}`);
  console.log('');
}

main().catch(err => {
  console.error('\nDeployment failed:', err.message || err);
  process.exit(1);
});
