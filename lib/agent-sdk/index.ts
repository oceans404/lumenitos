/**
 * # Lumenitos Agent SDK
 *
 * TypeScript SDK for AI agents to own and operate Soroban smart contract
 * wallets on Stellar, built on top of the generic Soroban Custom Account Kit.
 *
 * @example
 * ```ts
 * import { AgentWallet } from '@/lib/agent-sdk';
 *
 * const wallet = AgentWallet.fromSecret('SDXYZ...', { network: 'testnet' });
 * await wallet.transfer({ token: 'native', to: 'GBXYZ...', amount: '50.0' });
 * ```
 *
 * @module agent-sdk
 */

// High-level facade
export { AgentWallet } from './client';

// Lumenitos-specific components
export { AgentSigner } from './signing';
export { AccountClient } from './account-client';
export { FactoryClient } from './factory-client';

// Lumenitos network presets
export * as Networks from './networks';

// Lumenitos helpers
export { validateInviteCode } from './helpers';

// Re-export generic components from soroban-custom-account
export {
  DirectSubmitter,
  RelayerSubmitter,
  Ed25519CustomAccountSigner,
  defaultSignatureBuilder,
  toRawAmount,
  fromRawAmount,
  deriveContractAddress,
  resolveTokenContract,
  waitForTransaction,
  simulateRead,
  SIMULATION_ACCOUNT,
} from '../soroban-custom-account';

// Lumenitos types
export type {
  LumenitosNetworkConfig,
  WalletConfig,
  CreateConfig,
  TransferParams,
  InvokeParams,
  SwapParams,
  SupplyParams,
  WithdrawParams,
  TokenLimit,
  AccessControl,
  AgentPolicy,
  TokenAmount,
  AgentStatus,
  RelayerConfig,
} from './types';

// Re-export generic types
export type {
  NetworkConfig,
  TransactionResult,
  TransactionSubmitter,
  CustomAccountSigner,
  SignatureBuilder,
} from '../soroban-custom-account';
