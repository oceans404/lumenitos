/**
 * Direct transaction submission (self-pay) for any Soroban custom account.
 *
 * The signer's keypair is used as both the transaction source (pays fees)
 * and the auth entry signer. Requires the signer's Stellar account to
 * exist and be funded.
 *
 * For agents that should not pay their own fees, use `RelayerSubmitter`
 * with a self-hosted OpenZeppelin Relayer instead.
 *
 * @example
 * ```ts
 * const submitter = new DirectSubmitter(signer, rpc, networkConfig);
 * const result = await submitter.submit(operation, signer.publicKey);
 * ```
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { submitAndWait, bumpInstructionLimit, AUTH_EXPIRY_LEDGER_OFFSET } from './helpers';
import type { CustomAccountSigner, NetworkConfig, TransactionResult, TransactionSubmitter } from './types';

export class DirectSubmitter implements TransactionSubmitter {
  private signer: CustomAccountSigner;
  private rpcServer: StellarSdk.rpc.Server;
  private networkConfig: NetworkConfig;

  constructor(
    signer: CustomAccountSigner,
    rpcServer: StellarSdk.rpc.Server,
    networkConfig: NetworkConfig,
  ) {
    this.signer = signer;
    this.rpcServer = rpcServer;
    this.networkConfig = networkConfig;
  }

  async submit(
    operation: StellarSdk.xdr.Operation,
    sourcePublicKey: string,
  ): Promise<TransactionResult> {
    const sourceAccount = await this.rpcServer.getAccount(this.signer.keypair.publicKey());

    let tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '10000',
      networkPassphrase: this.networkConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.rpcServer.simulateTransaction(tx);

    if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
      const errorSim = simResult as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
      throw new Error(`Simulation failed: ${errorSim.error || 'Unknown error'}`);
    }

    const authEntries = simResult.result?.auth ?? [];
    const validUntilLedger = simResult.latestLedger + AUTH_EXPIRY_LEDGER_OFFSET;

    const signedAuthEntries = this.signer.signAllAuthEntries(
      authEntries,
      validUntilLedger,
      this.networkConfig.networkPassphrase,
    );

    tx = StellarSdk.rpc.assembleTransaction(tx, simResult).build();

    const txXdr = tx.toXDR();
    const txEnvelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(txXdr, 'base64');
    const ops = txEnvelope.v1().tx().operations();

    if (ops.length > 0 && ops[0].body().switch().name === 'invokeHostFunction') {
      ops[0].body().invokeHostFunctionOp().auth(signedAuthEntries);
    }

    bumpInstructionLimit(txEnvelope);

    tx = new StellarSdk.Transaction(txEnvelope, this.networkConfig.networkPassphrase);
    tx.sign(this.signer.keypair);

    const response = await submitAndWait(this.rpcServer, tx);

    return {
      hash: response.txHash,
      status: 'SUCCESS',
      ledger: response.ledger,
      returnValue: response.returnValue,
    };
  }
}
