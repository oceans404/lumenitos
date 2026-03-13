/**
 * # Soroban Custom Account Kit
 *
 * Generic TypeScript infrastructure for building SDKs that interact with
 * Soroban custom account contracts on Stellar.
 *
 * Provides:
 * - Ed25519 auth entry signing with pluggable signature format
 * - Direct (self-pay) and relay (fee-sponsored) transaction submission
 * - Pure helper utilities (amount conversion, address derivation, etc.)
 *
 * @module soroban-custom-account
 */

// Signer
export { Ed25519CustomAccountSigner, defaultSignatureBuilder } from './signer';

// Submitters
export { DirectSubmitter } from './direct-submitter';
export { RelayerSubmitter } from './relayer-submitter';

// Helpers
export {
  computeNetworkIdHash,
  toRawAmount,
  fromRawAmount,
  deriveContractAddress,
  resolveTokenContract,
  waitForTransaction,
  submitAndWait,
  bumpInstructionLimit,
  parseAuthEntry,
  simulateRead,
  SIMULATION_ACCOUNT,
  AUTH_EXPIRY_LEDGER_OFFSET,
} from './helpers';

// Types
export type {
  NetworkConfig,
  TransactionResult,
  TransactionSubmitter,
  CustomAccountSigner,
  SignatureBuilder,
} from './types';

export type { RelayerConfig } from './relayer-submitter';
