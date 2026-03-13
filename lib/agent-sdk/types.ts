/**
 * Lumenitos-specific types for the Agent SDK.
 * Extends the generic Soroban custom account types.
 */

import type { xdr } from '@stellar/stellar-sdk';
import type { NetworkConfig as BaseNetworkConfig, RelayerConfig } from '../soroban-custom-account';

// Re-export generic types for convenience
export type { TransactionResult, TransactionSubmitter } from '../soroban-custom-account';
export type { RelayerConfig } from '../soroban-custom-account/relayer-submitter';

// ===== Contract Types (mirror Rust agent-types crate) =====

export interface TokenLimit {
  token: string;
  perTxLimit: bigint;
}

export type AccessControl =
  | { type: 'allowAll' }
  | { type: 'allowOnly'; addresses: string[] }
  | { type: 'denyOnly'; addresses: string[] };

export interface AgentPolicy {
  tokenLimits: TokenLimit[];
  access: AccessControl;
  expiryLedger: number;
}

export interface TokenAmount {
  token: string;
  amount: bigint;
}

export type AgentStatus = 'active' | 'frozen';

// ===== Lumenitos Network Config (extends generic with factoryAddress) =====

export interface LumenitosNetworkConfig extends BaseNetworkConfig {
  factoryAddress: string;
}

// ===== SDK Configuration =====

export interface WalletConfig {
  network: 'testnet' | 'mainnet' | LumenitosNetworkConfig;
  factoryAddress?: string;
  rpcUrl?: string;

  /**
   * Self-hosted OpenZeppelin Relayer config. The relayer pays fees via its own
   * funded account (secured by KMS). The agent only signs auth entries —
   * no private keys are shared between agent and relayer.
   *
   * This is the recommended mode for production agents.
   */
  relayer?: RelayerConfig;
}

export interface CreateConfig extends WalletConfig {
  /** Hex-encoded 32-byte invite code (64 hex characters). */
  inviteCode: string;

  /**
   * `relayer` is required for create() — a new agent has no funded account.
   * The self-hosted OZ Relayer pays fees on behalf of the agent.
   *
   * @example
   * ```ts
   * AgentWallet.create({
   *   inviteCode: '...',
   *   network: 'testnet',
   *   relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: '...' },
   * })
   * ```
   */
  relayer: RelayerConfig;
}

// ===== Operation Parameters =====

export interface TransferParams {
  token: string;
  to: string;
  amount: string;
  decimals?: number;
}

export interface InvokeParams {
  contract: string;
  fnName: string;
  args: xdr.ScVal[];
  spendToken?: string;
  spendAmount?: string;
  decimals?: number;
}

export interface SwapParams {
  dex: string;
  fnName: string;
  args: xdr.ScVal[];
  tokenIn: string;
  amountIn: string;
  decimals?: number;
}

export interface SupplyParams {
  protocol: string;
  fnName: string;
  args: xdr.ScVal[];
  token: string;
  amount: string;
  decimals?: number;
}

export interface WithdrawParams {
  protocol: string;
  fnName: string;
  args: xdr.ScVal[];
}
