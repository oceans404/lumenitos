/**
 * Transaction submission via a self-hosted OpenZeppelin Relayer for Stellar.
 *
 * The OZ Relayer is a Rust service (Docker + Redis) that accepts operations
 * via HTTP API, builds transactions, pays fees, and submits to the network.
 *
 * Flow:
 * 1. Build a dummy transaction for simulation (using SIMULATION_ACCOUNT)
 * 2. Simulate against RPC to get auth entries and resource estimates
 * 3. Sign auth entries with the agent's ed25519 key
 * 4. Extract the operation details (contract address, function name, args)
 * 5. Convert signed auth entries to base64 XDR strings
 * 6. POST to relayer using operations-based API with auth XDR
 * 7. Poll the relayer for transaction status
 *
 * The agent never needs a funded Stellar account. The relayer's account
 * pays all transaction fees and signs the envelope.
 *
 * @example
 * ```ts
 * const submitter = new RelayerSubmitter(agentSigner, rpc, networkConfig, {
 *   baseUrl: 'http://localhost:8080',
 *   relayerId: 'my-relayer-id',
 *   apiKey: 'my-api-key',
 * });
 * ```
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { SIMULATION_ACCOUNT, AUTH_EXPIRY_LEDGER_OFFSET } from './helpers';
import type { CustomAccountSigner, NetworkConfig, TransactionResult, TransactionSubmitter } from './types';

// ===== Relayer Configuration =====

export interface RelayerConfig {
  /** Base URL of the self-hosted OZ Relayer (e.g., 'http://localhost:8080') */
  baseUrl: string;
  /** Relayer ID from the OZ Relayer configuration */
  relayerId: string;
  /** API key for authentication with the relayer */
  apiKey: string;
  /** Maximum fee in stroops the relayer will pay (default: 10_000_000 = 1 XLM) */
  maxFee?: number;
  /** Polling interval in ms when waiting for transaction confirmation (default: 2000) */
  pollInterval?: number;
  /** Maximum polling attempts before timing out (default: 15) */
  maxPollAttempts?: number;
}

// ===== Relayer API Types =====

/**
 * Auth configuration for the relayer operations API.
 *
 * The OZ Relayer AuthSpec for XDR mode uses:
 *   { "type": "xdr", "entries": ["base64...", ...] }
 *
 * The field is named "entries" (not "xdr") per the Rust source:
 *   AuthSpec::Xdr { entries: Vec<String> }
 * with #[serde(tag = "type", rename_all = "snake_case")]
 */
interface RelayerAuthXdr {
  type: 'xdr';
  entries: string[];
}

/**
 * A single operation in the relayer request payload.
 *
 * Args must be JSON ScVal objects (not base64 XDR strings).
 * The OZ Relayer deserializes args via serde_json::from_value<ScVal>().
 *
 * Supported ScVal JSON formats:
 *   {"address": "GABC..."}
 *   {"i128": {"hi": "0", "lo": "1000000"}}
 *   {"u64": "1000000"}
 *   {"symbol": "transfer"}
 *   {"bool": true}
 *   {"bytes": "deadbeef"}
 *   {"string": "hello"}
 *   {"vec": [{"u32": 1}, {"u32": 2}]}
 *   {"map": [{"key": ..., "val": ...}]}
 */
interface RelayerInvokeContractOperation {
  type: 'invoke_contract';
  contract_address: string;
  function_name: string;
  args: Record<string, unknown>[];
  auth?: RelayerAuthXdr;
}

/** Request body for the relayer transactions endpoint (operations mode). */
interface RelayerTransactionRequest {
  network: string;
  operations: RelayerInvokeContractOperation[];
}

/**
 * OZ Relayer wraps all API responses in:
 *   { success: boolean, data?: T, error?: string, pagination?: ..., metadata?: ... }
 */
interface RelayerApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Stellar-specific transaction response from the OZ Relayer.
 *
 * Field names match StellarTransactionResponse in the Rust source:
 *   id, hash, status, status_reason, created_at, sent_at, confirmed_at,
 *   source_account, fee, sequence_number, relayer_id, transaction_result_xdr
 *
 * Status values (from TransactionStatus enum with rename_all = "lowercase"):
 *   "pending" | "sent" | "submitted" | "mined" | "confirmed" | "failed" | "canceled" | "expired"
 */
interface RelayerTransactionResponse {
  id: string;
  hash?: string;
  status: string;
  status_reason?: string;
  created_at: string;
  sent_at?: string;
  confirmed_at?: string;
  source_account: string;
  fee: number;
  sequence_number: number;
  relayer_id: string;
  transaction_result_xdr?: string;
}

// ===== Helper: Convert ScVal XDR to JSON ScVal for the OZ Relayer API =====

/**
 * Convert a Stellar SDK ScVal to the JSON ScVal format expected by the OZ Relayer.
 *
 * The relayer uses `serde_json::from_value::<ScVal>(json)` from the stellar-xdr crate,
 * which expects the standard XDR JSON representation. This function converts the binary
 * XDR ScVal into that JSON format.
 *
 * Approach: Serialize the ScVal to XDR bytes, then convert to the JSON representation
 * that stellar-xdr's serde Deserialize expects. The stellar-xdr crate uses a tagged
 * format where the variant name is the key.
 */
function scValToJson(scVal: StellarSdk.xdr.ScVal): Record<string, unknown> {
  const type = scVal.switch();

  switch (type.value) {
    // Boolean
    case StellarSdk.xdr.ScValType.scvBool().value:
      return { bool: scVal.b() };

    // Void
    case StellarSdk.xdr.ScValType.scvVoid().value:
      return { void: null };

    // Integers - u32, i32
    case StellarSdk.xdr.ScValType.scvU32().value:
      return { u32: scVal.u32() };

    case StellarSdk.xdr.ScValType.scvI32().value:
      return { i32: scVal.i32() };

    // u64, i64 - stellar-xdr expects these as numbers (with the fix_u64_format hack, strings also work)
    case StellarSdk.xdr.ScValType.scvU64().value:
      return { u64: scVal.u64().toString() };

    case StellarSdk.xdr.ScValType.scvI64().value:
      return { i64: scVal.i64().toString() };

    // u128, i128 - parts format
    case StellarSdk.xdr.ScValType.scvU128().value: {
      const parts = scVal.u128();
      return { u128: { hi: parts.hi().toString(), lo: parts.lo().toString() } };
    }

    case StellarSdk.xdr.ScValType.scvI128().value: {
      const parts = scVal.i128();
      return { i128: { hi: parts.hi().toString(), lo: parts.lo().toString() } };
    }

    // u256, i256 - parts format
    case StellarSdk.xdr.ScValType.scvU256().value: {
      const parts = scVal.u256();
      return {
        u256: {
          hi_hi: parts.hiHi().toString(),
          hi_lo: parts.hiLo().toString(),
          lo_hi: parts.loHi().toString(),
          lo_lo: parts.loLo().toString(),
        },
      };
    }

    case StellarSdk.xdr.ScValType.scvI256().value: {
      const parts = scVal.i256();
      return {
        i256: {
          hi_hi: parts.hiHi().toString(),
          hi_lo: parts.hiLo().toString(),
          lo_hi: parts.loHi().toString(),
          lo_lo: parts.loLo().toString(),
        },
      };
    }

    // Bytes, String, Symbol
    case StellarSdk.xdr.ScValType.scvBytes().value:
      return { bytes: Buffer.from(scVal.bytes()).toString('hex') };

    case StellarSdk.xdr.ScValType.scvString().value:
      return { string: scVal.str().toString() };

    case StellarSdk.xdr.ScValType.scvSymbol().value:
      return { symbol: scVal.sym().toString() };

    // Address
    case StellarSdk.xdr.ScValType.scvAddress().value: {
      const addr = StellarSdk.Address.fromScAddress(scVal.address());
      return { address: addr.toString() };
    }

    // Vec
    case StellarSdk.xdr.ScValType.scvVec().value: {
      const vec = scVal.vec() ?? [];
      return { vec: vec.map(v => scValToJson(v)) };
    }

    // Map
    case StellarSdk.xdr.ScValType.scvMap().value: {
      const map = scVal.map() ?? [];
      return {
        map: map.map(entry => ({
          key: scValToJson(entry.key()),
          val: scValToJson(entry.val()),
        })),
      };
    }

    // Timepoint, Duration
    case StellarSdk.xdr.ScValType.scvTimepoint().value:
      return { timepoint: scVal.timepoint().toString() };

    case StellarSdk.xdr.ScValType.scvDuration().value:
      return { duration: scVal.duration().toString() };

    // Error
    case StellarSdk.xdr.ScValType.scvError().value:
      // Fall through to XDR fallback for complex error types
      break;

    // LedgerKeyContractInstance, LedgerKeyNonce - unlikely in args but handle gracefully
    default:
      break;
  }

  // Fallback: for any type we can't cleanly convert, the stellar-xdr serde format
  // is complex. Throw an error so we catch unsupported types early.
  throw new Error(
    `scValToJson: unsupported ScVal type "${type.name}" (value=${type.value}). ` +
    `This ScVal type cannot be converted to the JSON format expected by the OZ Relayer.`
  );
}

// ===== Helper: Extract InvokeHostFunction details from an xdr.Operation =====

interface InvokeContractDetails {
  contractAddress: string;
  functionName: string;
  args: StellarSdk.xdr.ScVal[];
}

/**
 * Extract contract address, function name, and args from an invokeHostFunction operation.
 * Throws if the operation is not an invokeHostFunction with invokeContract host function type.
 */
function extractInvokeContractDetails(operation: StellarSdk.xdr.Operation): InvokeContractDetails {
  const body = operation.body();
  if (body.switch().name !== 'invokeHostFunction') {
    throw new Error(
      `RelayerSubmitter only supports invokeHostFunction operations, got: ${body.switch().name}`
    );
  }

  const hostFn = body.invokeHostFunctionOp().hostFunction();
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Error(
      `RelayerSubmitter only supports invokeContract host functions, got: ${hostFn.switch().name}`
    );
  }

  const invokeArgs = hostFn.invokeContract();
  const contractAddress = StellarSdk.Address.fromScAddress(invokeArgs.contractAddress()).toString();
  const functionName = invokeArgs.functionName().toString();
  const args = invokeArgs.args();

  return { contractAddress, functionName, args };
}

// ===== RelayerSubmitter Class =====

export class RelayerSubmitter implements TransactionSubmitter {
  private signer: CustomAccountSigner;
  private rpcServer: StellarSdk.rpc.Server;
  private networkConfig: NetworkConfig;
  private relayerConfig: RelayerConfig;
  private networkName: string;

  constructor(
    signer: CustomAccountSigner,
    rpcServer: StellarSdk.rpc.Server,
    networkConfig: NetworkConfig,
    relayerConfig: RelayerConfig,
  ) {
    this.signer = signer;
    this.rpcServer = rpcServer;
    this.networkConfig = networkConfig;
    this.relayerConfig = relayerConfig;

    // Determine network name for the relayer API
    if (networkConfig.networkPassphrase.includes('Test')) {
      this.networkName = 'testnet';
    } else if (networkConfig.networkPassphrase.includes('Public')) {
      this.networkName = 'mainnet';
    } else {
      this.networkName = 'testnet';
    }
  }

  async submit(
    operation: StellarSdk.xdr.Operation,
    sourcePublicKey: string,
  ): Promise<TransactionResult> {
    // 1. Build a dummy transaction for simulation
    const dummyAccount = new StellarSdk.Account(SIMULATION_ACCOUNT, '0');

    const tx = new StellarSdk.TransactionBuilder(dummyAccount, {
      fee: '100',
      networkPassphrase: this.networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    // 2. Simulate against RPC
    const simResult = await this.rpcServer.simulateTransaction(tx);

    if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
      const errorSim = simResult as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
      throw new Error(`Simulation failed: ${errorSim.error || 'Unknown error'}`);
    }

    // 3. Sign auth entries
    const authEntries = simResult.result?.auth ?? [];
    const validUntilLedger = simResult.latestLedger + AUTH_EXPIRY_LEDGER_OFFSET;

    const signedAuthEntries = this.signer.signAllAuthEntries(
      authEntries,
      validUntilLedger,
      this.networkConfig.networkPassphrase,
    );

    // 4. Extract operation details from the XDR
    const details = extractInvokeContractDetails(operation);

    // 5. Convert signed auth entries to base64 XDR strings
    const authXdrStrings = signedAuthEntries.map(entry => entry.toXDR('base64'));

    // 6. Convert args to JSON ScVal objects (the OZ Relayer expects JSON, not base64 XDR)
    const argsJson = details.args.map(arg => scValToJson(arg));

    // 7. POST to relayer
    const requestBody: RelayerTransactionRequest = {
      network: this.networkName,
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

    const relayerResponse = await this.postTransaction(requestBody);

    // 8. Poll for confirmation if the transaction is pending.
    //    OZ Relayer status values: pending, sent, submitted, mined, confirmed, failed, canceled, expired
    if (relayerResponse.status === 'pending' || relayerResponse.status === 'sent' || relayerResponse.status === 'submitted') {
      return this.pollForConfirmation(relayerResponse.id);
    }

    // If already complete, map the response
    return this.mapResponse(relayerResponse);
  }

  // ===== Private Methods =====

  /**
   * POST a transaction to the relayer API.
   * Unwraps the ApiResponse wrapper: { success, data, error }.
   */
  private async postTransaction(body: RelayerTransactionRequest): Promise<RelayerTransactionResponse> {
    const url = `${this.relayerConfig.baseUrl}/api/v1/relayers/${this.relayerConfig.relayerId}/transactions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.relayerConfig.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Relayer API error (${response.status}): ${errorText}`
      );
    }

    const apiResponse = await response.json() as RelayerApiResponse<RelayerTransactionResponse>;

    if (!apiResponse.success || !apiResponse.data) {
      throw new Error(
        `Relayer API returned error: ${apiResponse.error || 'Unknown error (success=false, no data)'}`
      );
    }

    return apiResponse.data;
  }

  /**
   * GET transaction status from the relayer API.
   * Unwraps the ApiResponse wrapper: { success, data, error }.
   */
  private async getTransactionStatus(transactionId: string): Promise<RelayerTransactionResponse> {
    const url = `${this.relayerConfig.baseUrl}/api/v1/relayers/${this.relayerConfig.relayerId}/transactions/${transactionId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.relayerConfig.apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Relayer status check error (${response.status}): ${errorText}`
      );
    }

    const apiResponse = await response.json() as RelayerApiResponse<RelayerTransactionResponse>;

    if (!apiResponse.success || !apiResponse.data) {
      throw new Error(
        `Relayer status API returned error: ${apiResponse.error || 'Unknown error'}`
      );
    }

    return apiResponse.data;
  }

  private async pollForConfirmation(transactionId: string): Promise<TransactionResult> {
    const interval = this.relayerConfig.pollInterval ?? 2000;
    const maxAttempts = this.relayerConfig.maxPollAttempts ?? 15;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, interval));

      const status = await this.getTransactionStatus(transactionId);

      // Final success states
      if (status.status === 'confirmed') {
        return this.mapResponse(status);
      }

      // Final failure states
      if (status.status === 'failed' || status.status === 'canceled' || status.status === 'expired') {
        throw new Error(
          `Relayer transaction ${status.status}: ${status.status_reason || 'Unknown error'} (tx: ${transactionId})`
        );
      }

      // Still in progress (pending, sent, submitted, mined) — continue polling
    }

    throw new Error(
      `Relayer transaction timed out after ${maxAttempts} attempts (tx: ${transactionId})`
    );
  }

  private mapResponse(response: RelayerTransactionResponse): TransactionResult {
    // Map OZ Relayer status to our TransactionResult status
    const status = (response.status === 'confirmed')
      ? 'SUCCESS' as const
      : (response.status === 'failed' || response.status === 'canceled' || response.status === 'expired')
        ? 'FAILED' as const
        : 'PENDING' as const;

    const result: TransactionResult = {
      hash: response.hash ?? response.id,
      status,
    };

    // Parse returnValue from transaction_result_xdr if present
    // Note: The return value is in the transaction meta, not the transaction result XDR.
    // The relayer only provides transaction_result_xdr. For now, returnValue stays undefined.
    // To get the return value, we would need to query the RPC for the full transaction
    // meta using the hash, which is a potential future enhancement.

    return result;
  }
}
