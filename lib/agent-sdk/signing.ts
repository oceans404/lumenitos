/**
 * Lumenitos agent signer.
 *
 * Uses the default `{ public_key: BytesN<32>, signature: BytesN<64> }` struct
 * format from the generic Soroban custom account signer — which matches
 * the SimpleAccount contract's `__check_auth` expectation exactly.
 */

export { Ed25519CustomAccountSigner as AgentSigner } from '../soroban-custom-account';
