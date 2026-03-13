#!/usr/bin/env node
/**
 * Deploy simple_account WASM and account_factory contract to Stellar mainnet
 */

const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const MAINNET_RPC = 'https://rpc.lightsail.network';
const NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const ADMIN_SECRET = process.env.STELLAR_WASM_ADMIN_SECRET;

if (!ADMIN_SECRET) {
  console.error('Error: STELLAR_WASM_ADMIN_SECRET environment variable not set');
  process.exit(1);
}

const adminKeypair = StellarSdk.Keypair.fromSecret(ADMIN_SECRET);
const rpcServer = new StellarSdk.rpc.Server(MAINNET_RPC, { allowHttp: false });

async function uploadWasm(wasmPath, name) {
  console.log(`\nUploading ${name} WASM...`);

  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmHash = StellarSdk.hash(wasmBuffer).toString('hex');
  console.log(`WASM hash: ${wasmHash}`);
  console.log(`WASM size: ${wasmBuffer.length} bytes`);

  // Check if WASM is already installed
  try {
    const ledgerKey = StellarSdk.xdr.LedgerKey.contractCode(
      new StellarSdk.xdr.LedgerKeyContractCode({
        hash: Buffer.from(wasmHash, 'hex'),
      })
    );
    const entries = await rpcServer.getLedgerEntries(ledgerKey);
    if (entries.entries && entries.entries.length > 0) {
      console.log(`${name} WASM already installed on mainnet!`);
      return wasmHash;
    }
  } catch (e) {
    // WASM not found, proceed with upload
  }

  const sourceAccount = await rpcServer.getAccount(adminKeypair.publicKey());

  const uploadOp = StellarSdk.Operation.invokeHostFunction({
    func: StellarSdk.xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasmBuffer),
    auth: [],
  });

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '100000', // Higher fee for mainnet
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(uploadOp)
    .setTimeout(300)
    .build();

  tx = await rpcServer.prepareTransaction(tx);
  tx.sign(adminKeypair);

  console.log('Submitting WASM upload transaction...');
  const response = await rpcServer.sendTransaction(tx);

  if (response.status === 'PENDING') {
    console.log('Transaction pending, waiting for confirmation...');
    let result;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      result = await rpcServer.getTransaction(response.hash);
      if (result.status !== 'NOT_FOUND') {
        break;
      }
    }
    if (result.status === 'SUCCESS') {
      console.log(`${name} WASM uploaded successfully!`);
      return wasmHash;
    } else {
      console.error('Transaction failed:', result);
      throw new Error(`WASM upload failed: ${result.status}`);
    }
  } else if (response.status === 'ERROR') {
    console.error('Transaction error:', response);
    throw new Error('WASM upload failed');
  }

  return wasmHash;
}

async function deployFactory(simpleAccountWasmHash) {
  console.log('\nDeploying account_factory contract...');

  const factoryWasmPath = path.join(__dirname, '../contracts/account_factory/out/account_factory.wasm');
  const factoryWasmBuffer = fs.readFileSync(factoryWasmPath);
  const factoryWasmHash = StellarSdk.hash(factoryWasmBuffer).toString('hex');

  // First upload factory WASM if needed
  await uploadWasm(factoryWasmPath, 'account_factory');

  const sourceAccount = await rpcServer.getAccount(adminKeypair.publicKey());

  // Create a salt from the admin's public key for deterministic deployment
  const salt = StellarSdk.hash(Buffer.from(adminKeypair.publicKey()));

  // Deploy with constructor args: (wasm_hash: BytesN<32>, owner: Address, owner_key: BytesN<32>)
  const wasmHashScVal = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(simpleAccountWasmHash, 'hex'));
  const ownerScVal = new StellarSdk.Address(adminKeypair.publicKey()).toScVal();
  const ownerKeyScVal = StellarSdk.xdr.ScVal.scvBytes(
    StellarSdk.StrKey.decodeEd25519PublicKey(adminKeypair.publicKey())
  );

  // Use invokeHostFunction with createContractV2 for constructor support
  const createContractArgs = new StellarSdk.xdr.CreateContractArgsV2({
    contractIdPreimage: StellarSdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new StellarSdk.xdr.ContractIdPreimageFromAddress({
        address: new StellarSdk.Address(adminKeypair.publicKey()).toScAddress(),
        salt: salt,
      })
    ),
    executable: StellarSdk.xdr.ContractExecutable.contractExecutableWasm(Buffer.from(factoryWasmHash, 'hex')),
    constructorArgs: [wasmHashScVal, ownerScVal, ownerKeyScVal],
  });

  const deployOp = StellarSdk.Operation.invokeHostFunction({
    func: StellarSdk.xdr.HostFunction.hostFunctionTypeCreateContractV2(createContractArgs),
    auth: [],
  });

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '100000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(deployOp)
    .setTimeout(300)
    .build();

  tx = await rpcServer.prepareTransaction(tx);
  tx.sign(adminKeypair);

  console.log('Submitting factory deployment transaction...');
  const response = await rpcServer.sendTransaction(tx);

  if (response.status === 'PENDING') {
    console.log('Transaction pending, waiting for confirmation...');
    let result;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      result = await rpcServer.getTransaction(response.hash);
      if (result.status !== 'NOT_FOUND') {
        break;
      }
    }
    if (result.status === 'SUCCESS') {
      // Extract contract address from result
      const meta = result.resultMetaXdr;
      const contractId = extractContractIdFromMeta(meta);
      console.log(`Factory deployed successfully!`);
      console.log(`Factory contract address: ${contractId}`);
      return { contractId, wasmHash: factoryWasmHash };
    } else {
      console.error('Transaction failed:', result);
      throw new Error(`Factory deployment failed: ${result.status}`);
    }
  } else if (response.status === 'ERROR') {
    console.error('Transaction error:', response);
    throw new Error('Factory deployment failed');
  }
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
              const contractIdBuffer = contract.contractId();
              return StellarSdk.StrKey.encodeContract(contractIdBuffer);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Error extracting contract ID:', e);
  }
  return null;
}

async function main() {
  console.log('=== Deploying to Stellar Mainnet ===');
  console.log(`Admin account: ${adminKeypair.publicKey()}`);
  console.log(`RPC: ${MAINNET_RPC}`);

  // Check admin balance
  const account = await rpcServer.getAccount(adminKeypair.publicKey());
  console.log('Admin account loaded');

  try {
    // 1. Upload simple_account WASM
    const simpleAccountPath = path.join(__dirname, '../contracts/simple_account/out/simple_account.wasm');
    const simpleAccountWasmHash = await uploadWasm(simpleAccountPath, 'simple_account');
    console.log(`\nSimple account WASM hash: ${simpleAccountWasmHash}`);

    // 2. Deploy account_factory
    const factoryResult = await deployFactory(simpleAccountWasmHash);

    console.log('\n=== Deployment Complete ===');
    console.log(`Simple account WASM hash: ${simpleAccountWasmHash}`);
    console.log(`Factory contract address: ${factoryResult.contractId}`);
    console.log(`Factory WASM hash: ${factoryResult.wasmHash}`);

    console.log('\n=== Vercel Environment Variables ===');
    console.log(`NEXT_PUBLIC_SIMPLE_ACCOUNT_WASM_HASH=${simpleAccountWasmHash}`);
    console.log(`NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS=${factoryResult.contractId}`);
    console.log(`NEXT_PUBLIC_ACCOUNT_FACTORY_WASM_HASH=${factoryResult.wasmHash}`);

  } catch (error) {
    console.error('Deployment failed:', error);
    process.exit(1);
  }
}

main();
