/**
 * Lumenitos-specific helpers.
 * Generic helpers are re-exported from soroban-custom-account.
 */

// Re-export all generic helpers for backward compatibility
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
} from '../soroban-custom-account';

/**
 * Derive agent contract address from factory + agent public key.
 * Convenience wrapper around the generic deriveContractAddress.
 */
export { deriveContractAddress as deriveAgentAddress } from '../soroban-custom-account';

/**
 * Validate a hex-encoded invite code.
 * Must be exactly 64 hex characters (32 bytes).
 */
export function validateInviteCode(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Invalid invite code: expected 64 hex characters (32 bytes), got "${hex.length > 70 ? hex.slice(0, 20) + '...' : hex}"`
    );
  }
  return Buffer.from(hex, 'hex');
}
