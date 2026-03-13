#!/usr/bin/env node
/**
 * Create an invite code on the factory contract.
 *
 * The invite code is a random 32-byte value that acts as a one-time key
 * for agent onboarding. The factory stores an InviteConfig with:
 *   - funding: tokens + amounts to transfer on agent creation
 *   - policy: AgentPolicy (token limits, access control, expiry)
 *
 * Usage:
 *   STELLAR_TESTNET_SECRET=SXXX node scripts/create-invite.js <factory-address> [options]
 *
 * Options:
 *   --xlm <amount>       XLM funding per agent (default: 100)
 *   --per-tx-limit <n>   Per-tx XLM limit (default: 100, 0 = unlimited)
 *   --expiry <ledger>    Policy expiry ledger (default: 0 = no expiry)
 *   --count <n>          Number of invite codes to create (default: 1)
 */

const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    factoryAddress: null,
    xlmFunding: 100,
    perTxLimit: 100,
    expiryLedger: 0,
    count: 1,
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--xlm' && args[i + 1]) {
      opts.xlmFunding = parseFloat(args[i + 1]);
      i += 2;
    } else if (args[i] === '--per-tx-limit' && args[i + 1]) {
      opts.perTxLimit = parseFloat(args[i + 1]);
      i += 2;
    } else if (args[i] === '--expiry' && args[i + 1]) {
      opts.expiryLedger = parseInt(args[i + 1], 10);
      i += 2;
    } else if (args[i] === '--count' && args[i + 1]) {
      opts.count = parseInt(args[i + 1], 10);
      i += 2;
    } else if (!args[i].startsWith('--') && !opts.factoryAddress) {
      opts.factoryAddress = args[i];
      i += 1;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
    }
  }

  return opts;
}

/**
 * Build the InviteConfig ScVal matching the Soroban contract type:
 *
 * struct InviteConfig {
 *   funding: Vec<TokenAmount>,   // TokenAmount { token: Address, amount: i128 }
 *   policy: AgentPolicy,         // { token_limits: Vec<TokenLimit>, access: AccessControl, expiry_ledger: u32 }
 * }
 *
 * Soroban structs are encoded as ScVal maps with symbol keys (sorted alphabetically).
 */
function buildInviteConfigScVal(nativeContractId, xlmAmount, perTxLimit, expiryLedger) {
  const xlmStroops = BigInt(Math.round(xlmAmount * 10_000_000));
  const perTxStroops = BigInt(Math.round(perTxLimit * 10_000_000));

  const nativeAddress = new StellarSdk.Address(nativeContractId);

  // TokenAmount { token: Address, amount: i128 }
  const tokenAmountScVal = StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
      val: StellarSdk.nativeToScVal(xlmStroops, { type: 'i128' }),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('token'),
      val: nativeAddress.toScVal(),
    }),
  ]);

  // funding: Vec<TokenAmount>
  const fundingVec = StellarSdk.xdr.ScVal.scvVec([tokenAmountScVal]);

  // TokenLimit { token: Address, per_tx_limit: i128 }
  const tokenLimitScVal = StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('per_tx_limit'),
      val: StellarSdk.nativeToScVal(perTxStroops, { type: 'i128' }),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('token'),
      val: nativeAddress.toScVal(),
    }),
  ]);

  // AccessControl::AllowAll — enum variant with no data
  const accessControlScVal = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol('AllowAll'),
  ]);

  // AgentPolicy { token_limits, access, expiry_ledger }
  const policyScVal = StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('access'),
      val: accessControlScVal,
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('expiry_ledger'),
      val: StellarSdk.nativeToScVal(expiryLedger, { type: 'u32' }),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('token_limits'),
      val: StellarSdk.xdr.ScVal.scvVec([tokenLimitScVal]),
    }),
  ]);

  // InviteConfig { funding, policy } — map keys sorted alphabetically
  const inviteConfigScVal = StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('funding'),
      val: fundingVec,
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('policy'),
      val: policyScVal,
    }),
  ]);

  return inviteConfigScVal;
}

async function main() {
  console.log('============================================================');
  console.log('  Lumenitos — Create Invite Code');
  console.log('============================================================\n');

  const opts = parseArgs();

  if (!opts.factoryAddress) {
    console.error('Usage: STELLAR_TESTNET_SECRET=SXXX node scripts/create-invite.js <factory-address> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --xlm <amount>       XLM funding per agent (default: 100)');
    console.error('  --per-tx-limit <n>   Per-tx XLM limit (default: 100, 0 = unlimited)');
    console.error('  --expiry <ledger>    Policy expiry ledger (default: 0 = no expiry)');
    console.error('  --count <n>          Number of invite codes (default: 1)');
    process.exit(1);
  }

  if (!opts.factoryAddress.startsWith('C') || opts.factoryAddress.length !== 56) {
    console.error(`Error: Invalid contract address format: ${opts.factoryAddress}`);
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

  console.log('[1/3] Configuration');
  console.log(`  Owner:          ${keypair.publicKey()}`);
  console.log(`  Factory:        ${opts.factoryAddress}`);
  console.log(`  XLM funding:    ${opts.xlmFunding} XLM per agent`);
  console.log(`  Per-tx limit:   ${opts.perTxLimit} XLM`);
  console.log(`  Expiry ledger:  ${opts.expiryLedger} (0 = no expiry)`);
  console.log(`  Count:          ${opts.count}`);

  // Generate invite codes
  console.log(`\n[2/3] Generating ${opts.count} invite code(s)`);
  const inviteCodes = [];
  for (let i = 0; i < opts.count; i++) {
    const codeBytes = crypto.randomBytes(32);
    inviteCodes.push(codeBytes);
    console.log(`  Code ${i + 1}: ${codeBytes.toString('hex')}`);
  }

  // Build the InviteConfig
  const nativeContractId = getNativeContractId();
  console.log(`  Native SAC: ${nativeContractId}`);

  const inviteConfigScVal = buildInviteConfigScVal(
    nativeContractId,
    opts.xlmFunding,
    opts.perTxLimit,
    opts.expiryLedger,
  );

  // Call factory.create_invite or factory.create_invites
  console.log(`\n[3/3] Submitting invite creation to factory`);

  const factoryContract = new StellarSdk.Contract(opts.factoryAddress);
  let callOp;

  if (opts.count === 1) {
    // create_invite(invite_code: BytesN<32>, config: InviteConfig)
    callOp = factoryContract.call(
      'create_invite',
      StellarSdk.xdr.ScVal.scvBytes(inviteCodes[0]),
      inviteConfigScVal,
    );
  } else {
    // create_invites(codes: Vec<BytesN<32>>, config: InviteConfig)
    const codesScVal = StellarSdk.xdr.ScVal.scvVec(
      inviteCodes.map(c => StellarSdk.xdr.ScVal.scvBytes(c))
    );
    callOp = factoryContract.call(
      'create_invites',
      codesScVal,
      inviteConfigScVal,
    );
  }

  const sourceAccount = await rpcServer.getAccount(keypair.publicKey());

  let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: '10000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOp)
    .setTimeout(300)
    .build();

  tx = await rpcServer.prepareTransaction(tx);
  tx.sign(keypair);

  console.log(`  Submitting tx...`);
  const response = await rpcServer.sendTransaction(tx);

  if (response.status === 'PENDING') {
    await waitForTx(rpcServer, response.hash, 'create_invite');
  } else if (response.status === 'ERROR') {
    console.error('  Transaction error:', JSON.stringify(response, null, 2));
    throw new Error('Invite creation failed');
  } else {
    throw new Error(`Unexpected status: ${response.status}`);
  }

  console.log('\n============================================================');
  console.log('  Invite Code(s) Created Successfully!');
  console.log('============================================================');
  console.log(`  Policy: AllowAll, ${opts.xlmFunding} XLM funding, ${opts.perTxLimit} XLM/tx limit`);
  console.log('');
  for (let i = 0; i < inviteCodes.length; i++) {
    const hex = inviteCodes[i].toString('hex');
    console.log(`  Invite ${i + 1}: ${hex}`);
  }
  console.log('');
  console.log('  Agents can use these codes to onboard via AgentWallet.create()');
  console.log('  Each code is single-use and expires after ~7 days.');
  console.log('');
}

main().catch(err => {
  console.error('\nInvite creation failed:', err.message || err);
  process.exit(1);
});
