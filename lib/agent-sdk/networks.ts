/**
 * Lumenitos network presets (include factoryAddress).
 */

import type { LumenitosNetworkConfig } from './types';

export const testnet: LumenitosNetworkConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  factoryAddress: 'CDUIY5ADZ6MXJFKWMCTU2W3LN3UZJM3UNUTXPZBFA7FRB4UN22IETNIP',
  friendbotUrl: 'https://friendbot.stellar.org',
};

export const mainnet: LumenitosNetworkConfig = {
  rpcUrl: 'https://soroban.stellar.org',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  factoryAddress: '', // Not yet deployed
};

/** Resolve a network name or config to a LumenitosNetworkConfig. */
export function resolveNetwork(
  network: 'testnet' | 'mainnet' | LumenitosNetworkConfig,
): LumenitosNetworkConfig {
  if (typeof network === 'string') {
    if (network === 'testnet') return { ...testnet };
    if (network === 'mainnet') {
      if (!mainnet.factoryAddress) {
        throw new Error('Mainnet factory not yet deployed. Use testnet or provide a custom NetworkConfig.');
      }
      return { ...mainnet };
    }
    throw new Error(`Unknown network: ${network}`);
  }
  if (!network.factoryAddress) {
    throw new Error('factoryAddress is required in NetworkConfig');
  }
  return { ...network };
}
