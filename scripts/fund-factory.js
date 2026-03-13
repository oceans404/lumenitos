#!/usr/bin/env node
/**
 * Fund the factory contract with testnet XLM.
 *
 * Friendbot can only fund Stellar accounts, not Soroban contracts.
 * This script transfers XLM from the owner account to the factory contract
 * using the native SAC (Stellar Asset Contract) token transfer.
 *
 * Usage:
 *   STELLAR_TESTNET_SECRET=SXXX node scripts/fund-factory.js <factory-address> [amount]
 *
 * Arguments:
 *   factory-address  — the C... contract address of the factory
 *   amount           — XLM to transfer (default: 1000, i.e. 1000 XLM)
 */

const StellarSdk = require('@stellar/stellar-sdk');

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

// The native XLM SAC address on testnet
// Derived from the native asset using the testnet passphrase
function getNativeContractId() {
  const asset = StellarSdk.Asset.native();
  return asset.contractId(NETWORK_PASSPHRASE);
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

async function fundViaFriendbot(publicKey) {
  const url = `${FRIENDBOT_URL}?addr=${publicKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    // Friendbot returns error if already funded — that's OK
    if (body.includes('createAccountAlreadyExist')) {
      console.log(`  Account already funded`);
      return;
    }
    throw new Error(`Friendbot funding failed (${res.status}): ${body}`);
  }
  console.log(`  Funded ${publicKey} via friendbot`);
}

async function main() {
  console.log('============================================================');
  console.log('  Lumenitos — Fund Factory Contract');
  console.log('============================================================\n');

  // Parse args
  const factoryAddress = process.argv[2];
  const amountXLM = parseFloat(process.argv[3] || '1000');

  if (!factoryAddress) {
    console.error('Usage: STELLAR_TESTNET_SECRET=SXXX node scripts/fund-factory.js <factory-address> [amount-xlm]');
    console.error('');
    console.error('  factory-address  — C... contract address');
    console.error('  amount-xlm       — XLM to transfer (default: 1000)');
    process.exit(1);
  }

  if (!factoryAddress.startsWith('C') || factoryAddress.length !== 56) {
    console.error(`Error: Invalid contract address format: ${factoryAddress}`);
    console.error('  Expected a C... address (56 characters)');
    process.exit(1);
  }

  if (!process.env.STELLAR_TESTNET_SECRET) {
    console.error('Error: STELLAR_TESTNET_SECRET environment variable not set');
    console.error('  This should be the secret key of the factory owner.');
    process.exit(1);
  }

  const keypair = StellarSdk.Keypair.fromSecret(process.env.STELLAR_TESTNET_SECRET);
  const rpcServer = new StellarSdk.rpc.Server(TESTNET_RPC, { allowHttp: false });

  console.log(`[1/3] Configuration`);
  console.log(`  Owner:            ${keypair.publicKey()}`);
  console.log(`  Factory:          ${factoryAddress}`);
  console.log(`  Amount:           ${amountXLM} XLM`);

  // Ensure owner account is funded
  console.log(`\n[2/3] Ensuring owner account is funded`);
  try {
    await rpcServer.getAccount(keypair.publicKey());
    console.log(`  Owner account exists`);
  } catch (_) {
    console.log(`  Owner account not found — funding via friendbot...`);
    await fundViaFriendbot(keypair.publicKey());
  }

  // If we need more than 10000 XLM, we'd need multiple friendbot calls
  // For now, friendbot gives 10000 XLM which should be plenty

  // Transfer XLM to factory via native SAC
  console.log(`\n[3/3] Transferring ${amountXLM} XLM to factory`);

  const nativeContractId = getNativeContractId();
  console.log(`  Native SAC address: ${nativeContractId}`);

  const nativeContract = new StellarSdk.Contract(nativeContractId);

  // Amount in stroops (7 decimals)
  const amountStroops = BigInt(Math.round(amountXLM * 10_000_000));

  const transferOp = nativeContract.call(
    'transfer',
    new StellarSdk.Address(keypair.publicKey()).toScVal(),   // from
    new StellarSdk.Address(factoryAddress).toScVal(),         // to
    StellarSdk.nativeToScVal(amountStroops, { type: 'i128' }), // amount
  );

  const sourceAccount = await rpcServer.getAccount(keypair.publicKey());

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '10000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(transferOp)
    .setTimeout(300)
    .build();

  tx = await rpcServer.prepareTransaction(tx);
  tx.sign(keypair);

  console.log(`  Submitting transfer tx...`);
  const response = await rpcServer.sendTransaction(tx);

  if (response.status === 'PENDING') {
    await waitForTx(rpcServer, response.hash, 'XLM transfer');
  } else if (response.status === 'ERROR') {
    console.error('  Transaction error:', JSON.stringify(response, null, 2));
    throw new Error('XLM transfer failed');
  } else {
    throw new Error(`Unexpected status: ${response.status}`);
  }

  console.log('\n============================================================');
  console.log('  Factory funded successfully!');
  console.log('============================================================');
  console.log(`  Factory:  ${factoryAddress}`);
  console.log(`  Amount:   ${amountXLM} XLM`);
  console.log('');
}

main().catch(err => {
  console.error('\nFunding failed:', err.message || err);
  process.exit(1);
});
