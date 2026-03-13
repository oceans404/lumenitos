/**
 * Generic types for Soroban custom account contracts.
 * No dependency on any specific contract ABI.
 */

import type * as StellarSdk from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';

// ===== Network & Config =====

/** Network configuration — no factory or application-specific fields. */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  friendbotUrl?: string;
}

// ===== Transaction Results =====

export interface TransactionResult {
  hash: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  ledger?: number;
  returnValue?: xdr.ScVal;
}

// ===== Signer Interface =====

/**
 * Interface for signing Soroban custom account auth entries.
 *
 * Implementations provide the signature format that their contract's
 * `__check_auth` expects. The generic layer handles the submission
 * pipeline (simulate → sign → assemble → send).
 */
export interface CustomAccountSigner {
  /** Stellar public key (G...). */
  readonly publicKey: string;
  /** Raw 32-byte ed25519 public key. */
  readonly publicKeyBytes: Uint8Array;
  /** Underlying Stellar Keypair (needed for envelope signing in direct mode). */
  readonly keypair: StellarSdk.Keypair;

  /**
   * Sign all address-credential auth entries from a simulation result.
   * Non-address entries should be passed through unchanged.
   */
  signAllAuthEntries(
    authEntries: (string | xdr.SorobanAuthorizationEntry)[],
    validUntilLedger: number,
    networkPassphrase: string,
  ): xdr.SorobanAuthorizationEntry[];
}

// ===== Submitter Interface =====

/** Strategy interface for transaction submission. */
export interface TransactionSubmitter {
  submit(
    operation: xdr.Operation,
    sourcePublicKey: string,
  ): Promise<TransactionResult>;
}

/**
 * Callback that wraps raw ed25519 signature bytes into the ScVal format
 * that a specific contract's `__check_auth` expects.
 *
 * This is the key customization point. Different contracts expect different
 * signature struct formats.
 *
 * @example
 * // For a contract expecting Signature { public_key: BytesN<32>, signature: BytesN<64> }
 * const builder: SignatureBuilder = (pubKey, sig) => xdr.ScVal.scvMap([
 *   new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(pubKey) }),
 *   new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(sig) }),
 * ]);
 */
export type SignatureBuilder = (
  publicKeyBytes: Buffer,
  signatureBytes: Buffer,
) => xdr.ScVal;
