/**
 * SimpleAccount contract client.
 * Wraps the 5 agent wrapper functions + read functions.
 * Lumenitos-specific — tied to the simple_account contract ABI.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { toRawAmount, resolveTokenContract, simulateRead } from '../soroban-custom-account';
import type { LumenitosNetworkConfig, AgentStatus } from './types';

export class AccountClient {
  readonly contractAddress: string;
  readonly networkConfig: LumenitosNetworkConfig;
  readonly rpcServer: StellarSdk.rpc.Server;
  private contract: StellarSdk.Contract;

  constructor(
    contractAddress: string,
    networkConfig: LumenitosNetworkConfig,
    rpcServer: StellarSdk.rpc.Server,
  ) {
    this.contractAddress = contractAddress;
    this.networkConfig = networkConfig;
    this.rpcServer = rpcServer;
    this.contract = new StellarSdk.Contract(contractAddress);
  }

  // ===== Operation Builders =====

  buildTransfer(
    agentKeyBytes: Uint8Array, token: string, destination: string,
    amount: string, decimals: number = 7,
  ): StellarSdk.xdr.Operation {
    const tokenContract = resolveTokenContract(token, this.networkConfig.networkPassphrase);
    const rawAmount = toRawAmount(amount, decimals);

    return this.contract.call('agent_transfer',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(tokenContract.contractId()).toScVal(),
      new StellarSdk.Address(destination).toScVal(),
      StellarSdk.nativeToScVal(rawAmount, { type: 'i128' }),
    );
  }

  buildInvoke(
    agentKeyBytes: Uint8Array, contract: string, fnName: string,
    args: StellarSdk.xdr.ScVal[], spendToken: string, spendAmount: string,
    decimals: number = 7,
  ): StellarSdk.xdr.Operation {
    const tokenContract = resolveTokenContract(spendToken, this.networkConfig.networkPassphrase);
    const rawAmount = toRawAmount(spendAmount, decimals);

    return this.contract.call('agent_invoke',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(contract).toScVal(),
      StellarSdk.nativeToScVal(fnName, { type: 'symbol' }),
      StellarSdk.xdr.ScVal.scvVec(args),
      new StellarSdk.Address(tokenContract.contractId()).toScVal(),
      StellarSdk.nativeToScVal(rawAmount, { type: 'i128' }),
    );
  }

  buildSwap(
    agentKeyBytes: Uint8Array, dex: string, fnName: string,
    args: StellarSdk.xdr.ScVal[], tokenIn: string, amountIn: string,
    decimals: number = 7,
  ): StellarSdk.xdr.Operation {
    const tokenContract = resolveTokenContract(tokenIn, this.networkConfig.networkPassphrase);
    const rawAmount = toRawAmount(amountIn, decimals);

    return this.contract.call('agent_swap',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(dex).toScVal(),
      StellarSdk.nativeToScVal(fnName, { type: 'symbol' }),
      StellarSdk.xdr.ScVal.scvVec(args),
      new StellarSdk.Address(tokenContract.contractId()).toScVal(),
      StellarSdk.nativeToScVal(rawAmount, { type: 'i128' }),
    );
  }

  buildSupply(
    agentKeyBytes: Uint8Array, protocol: string, fnName: string,
    args: StellarSdk.xdr.ScVal[], token: string, amount: string,
    decimals: number = 7,
  ): StellarSdk.xdr.Operation {
    const tokenContract = resolveTokenContract(token, this.networkConfig.networkPassphrase);
    const rawAmount = toRawAmount(amount, decimals);

    return this.contract.call('agent_supply',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(protocol).toScVal(),
      StellarSdk.nativeToScVal(fnName, { type: 'symbol' }),
      StellarSdk.xdr.ScVal.scvVec(args),
      new StellarSdk.Address(tokenContract.contractId()).toScVal(),
      StellarSdk.nativeToScVal(rawAmount, { type: 'i128' }),
    );
  }

  buildWithdraw(
    agentKeyBytes: Uint8Array, protocol: string, fnName: string,
    args: StellarSdk.xdr.ScVal[],
  ): StellarSdk.xdr.Operation {
    return this.contract.call('agent_withdraw',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
      new StellarSdk.Address(protocol).toScVal(),
      StellarSdk.nativeToScVal(fnName, { type: 'symbol' }),
      StellarSdk.xdr.ScVal.scvVec(args),
    );
  }

  // ===== Read Functions =====

  async getAgentStatus(agentKeyBytes: Uint8Array): Promise<AgentStatus> {
    const op = this.contract.call(
      'get_agent_status',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(this.rpcServer, op, this.networkConfig.networkPassphrase);
    const native = StellarSdk.scValToNative(result);
    return (typeof native === 'string' ? native.toLowerCase() : String(native).toLowerCase()) as AgentStatus;
  }

  async getPolicy(agentKeyBytes: Uint8Array): Promise<Record<string, unknown>> {
    const op = this.contract.call(
      'get_policy',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(this.rpcServer, op, this.networkConfig.networkPassphrase);
    return StellarSdk.scValToNative(result) as Record<string, unknown>;
  }

  async getOwner(): Promise<Buffer> {
    const op = this.contract.call('get_owner');
    const result = await simulateRead(this.rpcServer, op, this.networkConfig.networkPassphrase);
    return StellarSdk.scValToNative(result) as Buffer;
  }
}
