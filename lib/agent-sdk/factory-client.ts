/**
 * AccountFactory contract client.
 * Handles agent onboarding: invite redemption + contract deployment.
 * Lumenitos-specific — tied to the account_factory contract ABI.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { deriveContractAddress, simulateRead } from '../soroban-custom-account';
import type { LumenitosNetworkConfig } from './types';

export class FactoryClient {
  readonly networkConfig: LumenitosNetworkConfig;
  readonly rpcServer: StellarSdk.rpc.Server;
  private contract: StellarSdk.Contract;

  constructor(networkConfig: LumenitosNetworkConfig, rpcServer: StellarSdk.rpc.Server) {
    this.networkConfig = networkConfig;
    this.rpcServer = rpcServer;
    this.contract = new StellarSdk.Contract(networkConfig.factoryAddress);
  }

  buildCreate(agentKeyBytes: Uint8Array, inviteCodeBytes: Uint8Array): StellarSdk.xdr.Operation {
    return this.contract.call(
      'create',
      StellarSdk.nativeToScVal(agentKeyBytes, { type: 'bytes' }),
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );
  }

  getAddress(agentKeyBytes: Uint8Array): string {
    return deriveContractAddress(
      this.networkConfig.factoryAddress,
      agentKeyBytes,
      this.networkConfig.networkPassphrase,
    );
  }

  async isInviteValid(inviteCodeBytes: Uint8Array): Promise<boolean> {
    const op = this.contract.call(
      'is_invite_valid',
      StellarSdk.nativeToScVal(inviteCodeBytes, { type: 'bytes' }),
    );
    const result = await simulateRead(this.rpcServer, op, this.networkConfig.networkPassphrase);
    return StellarSdk.scValToNative(result) as boolean;
  }
}
