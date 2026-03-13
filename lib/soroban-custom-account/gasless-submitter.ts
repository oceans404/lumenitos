/**
 * @deprecated GaslessSubmitter (OpenZeppelin Channels) has been removed.
 *
 * OZ Defender is shutting down (new sign-ups disabled June 2025, full shutdown July 2026).
 * Use `RelayerSubmitter` with a self-hosted OpenZeppelin Relayer instead.
 *
 * Migration:
 *   // Before (gasless via hosted OZ Channels):
 *   new GaslessSubmitter(signer, rpc, network, { apiKey: '...' });
 *
 *   // After (self-hosted OZ Relayer):
 *   new RelayerSubmitter(signer, rpc, network, {
 *     baseUrl: 'http://localhost:8080',
 *     relayerId: 'stellar-testnet',
 *     apiKey: '...',
 *   });
 *
 * The relayer has its own funded account (KMS-secured). The agent only signs
 * Soroban auth entries via __check_auth. No private keys are shared.
 *
 * See: https://docs.openzeppelin.com/relayer/1.4.x/stellar
 */

export {};
