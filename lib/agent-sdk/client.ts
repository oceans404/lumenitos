/**
 * AgentWallet — the high-level facade for Lumenitos agent operations.
 *
 * @example
 * ```ts
 * import { AgentWallet } from '@/lib/agent-sdk';
 *
 * const wallet = AgentWallet.fromSecret('SDXYZ...', { network: 'testnet' });
 * await wallet.transfer({ token: 'native', to: 'GBXYZ...', amount: '50.0' });
 * const balance = await wallet.getBalance('native');
 * ```
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  deriveContractAddress,
  resolveTokenContract,
  fromRawAmount,
  SIMULATION_ACCOUNT,
  DirectSubmitter,
  RelayerSubmitter,
} from '../soroban-custom-account';
import type { TransactionSubmitter, TransactionResult, RelayerConfig } from '../soroban-custom-account';
import { AgentSigner } from './signing';
import { AccountClient } from './account-client';
import { FactoryClient } from './factory-client';
import { resolveNetwork } from './networks';
import { validateInviteCode } from './helpers';
import type {
  LumenitosNetworkConfig,
  WalletConfig,
  CreateConfig,
  TransferParams,
  InvokeParams,
  SwapParams,
  SupplyParams,
  WithdrawParams,
  AgentStatus,
} from './types';

export class AgentWallet {
  readonly signer: AgentSigner;
  readonly networkConfig: LumenitosNetworkConfig;
  readonly address: string;
  readonly account: AccountClient;
  readonly factory: FactoryClient;

  private rpcServer: StellarSdk.rpc.Server;
  private submitter: TransactionSubmitter;

  constructor(
    signer: AgentSigner,
    networkConfig: LumenitosNetworkConfig,
    options: {
      relayer?: RelayerConfig;
      contractAddress?: string;
    } = {},
  ) {
    this.signer = signer;
    this.networkConfig = networkConfig;
    this.rpcServer = new StellarSdk.rpc.Server(networkConfig.rpcUrl);

    this.address = options.contractAddress ?? deriveContractAddress(
      networkConfig.factoryAddress,
      signer.publicKeyBytes,
      networkConfig.networkPassphrase,
    );

    this.account = new AccountClient(this.address, networkConfig, this.rpcServer);
    this.factory = new FactoryClient(networkConfig, this.rpcServer);

    if (options.relayer) {
      // OZ Relayer mode: self-hosted relayer pays fees, agent only signs auth entries.
      // No private keys are shared — the relayer has its own funded account (KMS-secured).
      this.submitter = new RelayerSubmitter(signer, this.rpcServer, networkConfig, options.relayer);
    } else {
      // Self-pay: signer's account must exist and be funded.
      // Suitable for owner operations and testing.
      this.submitter = new DirectSubmitter(signer, this.rpcServer, networkConfig);
    }
  }

  static fromSecret(secret: string, config: WalletConfig): AgentWallet {
    const signer = AgentSigner.fromSecret(secret);
    const networkConfig = resolveNetwork(config.network);
    if (config.factoryAddress) networkConfig.factoryAddress = config.factoryAddress;
    if (config.rpcUrl) networkConfig.rpcUrl = config.rpcUrl;
    return new AgentWallet(signer, networkConfig, {
      relayer: config.relayer,
    });
  }

  /**
   * Create a new agent wallet via the factory invite system.
   *
   * Generates a fresh keypair, calls `factory.create()` with the invite code,
   * and returns an operational wallet with funds and policy already configured.
   *
   * Requires `relayer` config — a self-hosted OZ Relayer pays fees on behalf
   * of the agent. No private keys are shared between agent and relayer.
   *
   * @example
   * ```ts
   * const wallet = await AgentWallet.create({
   *   network: 'testnet',
   *   inviteCode: 'a3f8c1d2...',
   *   relayer: { baseUrl: 'http://localhost:8080', relayerId: 'stellar-testnet', apiKey: '...' },
   * });
   *
   * // The wallet is immediately operational
   * await wallet.transfer({ token: 'native', to: 'GBXYZ...', amount: '10.0' });
   * ```
   */
  static async create(config: CreateConfig): Promise<AgentWallet> {
    if (!config.relayer) {
      throw new Error(
        'AgentWallet.create() requires relayer config — a newly generated agent has no funded account.\n' +
        '  { relayer: { baseUrl: "http://localhost:8080", relayerId: "stellar-testnet", apiKey: "..." } }'
      );
    }

    const inviteCodeBytes = validateInviteCode(config.inviteCode);
    const signer = AgentSigner.generate();
    const networkConfig = resolveNetwork(config.network);
    if (config.factoryAddress) networkConfig.factoryAddress = config.factoryAddress;
    if (config.rpcUrl) networkConfig.rpcUrl = config.rpcUrl;

    const wallet = new AgentWallet(signer, networkConfig, {
      relayer: config.relayer,
    });
    const operation = wallet.factory.buildCreate(signer.publicKeyBytes, inviteCodeBytes);
    await wallet.submitter.submit(operation, signer.publicKey);

    return wallet;
  }

  get publicKey(): string { return this.signer.publicKey; }
  get secretKey(): string { return this.signer.secretKey; }

  // ===== Agent Operations =====

  async transfer(params: TransferParams): Promise<TransactionResult> {
    const op = this.account.buildTransfer(
      this.signer.publicKeyBytes, params.token, params.to, params.amount, params.decimals,
    );
    return this.submitter.submit(op, this.signer.publicKey);
  }

  async invoke(params: InvokeParams): Promise<TransactionResult> {
    const op = this.account.buildInvoke(
      this.signer.publicKeyBytes, params.contract, params.fnName, params.args,
      params.spendToken ?? 'native', params.spendAmount ?? '0', params.decimals,
    );
    return this.submitter.submit(op, this.signer.publicKey);
  }

  async swap(params: SwapParams): Promise<TransactionResult> {
    const op = this.account.buildSwap(
      this.signer.publicKeyBytes, params.dex, params.fnName, params.args,
      params.tokenIn, params.amountIn, params.decimals,
    );
    return this.submitter.submit(op, this.signer.publicKey);
  }

  async supply(params: SupplyParams): Promise<TransactionResult> {
    const op = this.account.buildSupply(
      this.signer.publicKeyBytes, params.protocol, params.fnName, params.args,
      params.token, params.amount, params.decimals,
    );
    return this.submitter.submit(op, this.signer.publicKey);
  }

  async withdraw(params: WithdrawParams): Promise<TransactionResult> {
    const op = this.account.buildWithdraw(
      this.signer.publicKeyBytes, params.protocol, params.fnName, params.args,
    );
    return this.submitter.submit(op, this.signer.publicKey);
  }

  // ===== Read Functions =====

  async getBalance(token: string = 'native', decimals: number = 7): Promise<string> {
    const tokenContract = resolveTokenContract(token, this.networkConfig.networkPassphrase);
    const account = new StellarSdk.Account(SIMULATION_ACCOUNT, '0');

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkConfig.networkPassphrase,
    })
      .addOperation(tokenContract.call('balance', new StellarSdk.Address(this.address).toScVal()))
      .setTimeout(30)
      .build();

    const sim = await this.rpcServer.simulateTransaction(tx);

    if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const errorSim = sim as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
      throw new Error(`Balance query failed: ${errorSim.error || 'Unknown simulation error'}`);
    }

    const raw = BigInt(StellarSdk.scValToNative(sim.result!.retval));
    return fromRawAmount(raw, decimals);
  }

  async getStatus(): Promise<AgentStatus> {
    return this.account.getAgentStatus(this.signer.publicKeyBytes);
  }

  async getPolicy(): Promise<Record<string, unknown>> {
    return this.account.getPolicy(this.signer.publicKeyBytes);
  }

  async isInviteValid(inviteCodeHex: string): Promise<boolean> {
    const inviteCodeBytes = validateInviteCode(inviteCodeHex);
    return this.factory.isInviteValid(inviteCodeBytes);
  }

  predictAddress(publicKey?: string): string {
    const keyBytes = publicKey
      ? StellarSdk.StrKey.decodeEd25519PublicKey(publicKey)
      : this.signer.publicKeyBytes;
    return this.factory.getAddress(keyBytes);
  }
}
