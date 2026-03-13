/**
 * Pure helper functions for Soroban custom account interactions.
 * No external config imports — all values are passed explicitly.
 */

import * as StellarSdk from '@stellar/stellar-sdk';

/** Dummy account address for simulation-only transactions (read-only queries). */
export const SIMULATION_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** How many ledgers into the future auth signatures remain valid (~5 min at 5s/ledger). */
export const AUTH_EXPIRY_LEDGER_OFFSET = 60;

/**
 * Compute network ID hash from passphrase.
 */
export function computeNetworkIdHash(networkPassphrase: string): Buffer {
  return StellarSdk.hash(Buffer.from(networkPassphrase));
}

/**
 * Convert human-readable amount to raw units using string-based math.
 * Avoids floating-point precision loss (e.g., '0.1' at 7 decimals → 1000000n exactly).
 *
 * Note: Excess decimal places beyond `decimals` are silently truncated (not rounded).
 */
export function toRawAmount(amount: string, decimals: number = 7): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;

  const [intPart, fracPart = ''] = abs.split('.');
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const raw = BigInt(intPart + padded);

  return negative ? -raw : raw;
}

/**
 * Convert raw units to human-readable amount using string-based math.
 * Handles arbitrarily large bigints without precision loss.
 */
export function fromRawAmount(raw: bigint | number, decimals: number = 7): string {
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

/**
 * Derive deterministic contract address from deployer + salt.
 * Works with any Soroban factory that uses `deployer().with_current_contract(salt).deploy_v2()`.
 */
export function deriveContractAddress(
  deployerAddress: string,
  salt: Uint8Array,
  networkPassphrase: string,
): string {
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
 * Resolve a token identifier to a Contract instance.
 * 'native' resolves to the XLM Stellar Asset Contract for the given network.
 */
export function resolveTokenContract(
  token: string,
  networkPassphrase: string,
): StellarSdk.Contract {
  if (token === 'native') {
    const xlmContractId = StellarSdk.Asset.native().contractId(networkPassphrase);
    return new StellarSdk.Contract(xlmContractId);
  }
  return new StellarSdk.Contract(token);
}

/**
 * Wait for a transaction to be confirmed on-chain.
 */
export async function waitForTransaction(
  rpcServer: StellarSdk.rpc.Server,
  hash: string,
  options: { maxAttempts?: number; interval?: number } = {},
): Promise<StellarSdk.rpc.Api.GetSuccessfulTransactionResponse> {
  const { maxAttempts = 10, interval = 2000 } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const response = await rpcServer.getTransaction(hash);

    if (response.status === 'SUCCESS') {
      return response as StellarSdk.rpc.Api.GetSuccessfulTransactionResponse;
    }
    if (response.status === 'FAILED') {
      throw new Error(`Transaction failed: ${(response as StellarSdk.rpc.Api.GetFailedTransactionResponse).resultXdr || response.status}`);
    }
  }
  throw new Error('Transaction timed out waiting for confirmation');
}

/**
 * Submit a transaction and wait for confirmation.
 */
export async function submitAndWait(
  rpcServer: StellarSdk.rpc.Server,
  transaction: StellarSdk.Transaction,
): Promise<StellarSdk.rpc.Api.GetSuccessfulTransactionResponse> {
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
 * Bump instruction limit on a transaction envelope.
 * Needed for any `__check_auth` that performs ed25519 verification.
 */
export function bumpInstructionLimit(
  txEnvelope: StellarSdk.xdr.TransactionEnvelope,
  additional: number = 1_000_000,
): void {
  const sorobanData = txEnvelope.v1().tx().ext().sorobanData();
  const resources = sorobanData.resources();
  resources.instructions(resources.instructions() + additional);
}

/**
 * Parse an auth entry from various formats (base64 string or XDR object).
 */
export function parseAuthEntry(
  authEntry: string | StellarSdk.xdr.SorobanAuthorizationEntry,
): StellarSdk.xdr.SorobanAuthorizationEntry {
  if (typeof authEntry === 'string') {
    return StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(authEntry, 'base64');
  }
  return authEntry;
}

/**
 * Simulate a read-only contract call using a dummy account.
 * Useful for querying contract state without a funded account.
 */
export async function simulateRead(
  rpcServer: StellarSdk.rpc.Server,
  operation: StellarSdk.xdr.Operation,
  networkPassphrase: string,
): Promise<StellarSdk.xdr.ScVal> {
  const account = new StellarSdk.Account(SIMULATION_ACCOUNT, '0');

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);

  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    const errorSim = sim as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${errorSim.error || 'Unknown error'}`);
  }

  return sim.result!.retval;
}
