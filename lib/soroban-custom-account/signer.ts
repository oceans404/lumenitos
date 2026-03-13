/**
 * Ed25519 signer for Soroban custom account contracts.
 *
 * Handles the universal part of auth entry signing:
 *   1. Build HashIdPreimage for Soroban authorization
 *   2. Hash with SHA-256
 *   3. Sign with ed25519
 *
 * The contract-specific part — how to wrap the signature bytes into an ScVal —
 * is delegated to a `SignatureBuilder` callback. The default produces the
 * canonical `{ public_key: BytesN<32>, signature: BytesN<64> }` struct used
 * by the Soroban examples and many custom account contracts.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { computeNetworkIdHash, parseAuthEntry } from './helpers';
import type { CustomAccountSigner, SignatureBuilder } from './types';

/**
 * Default signature builder: produces the canonical Soroban custom account
 * Signature struct as an ScVal map:
 *   { public_key: BytesN<32>, signature: BytesN<64> }
 *
 * Fields are sorted alphabetically (Soroban #[contracttype] convention).
 */
export const defaultSignatureBuilder: SignatureBuilder = (publicKeyBytes, signatureBytes) =>
  StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('public_key'),
      val: StellarSdk.xdr.ScVal.scvBytes(publicKeyBytes),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol('signature'),
      val: StellarSdk.xdr.ScVal.scvBytes(signatureBytes),
    }),
  ]);

/**
 * Ed25519 signer for Soroban custom account contracts.
 *
 * @example
 * ```ts
 * // Using the default { public_key, signature } struct format:
 * const signer = Ed25519CustomAccountSigner.fromSecret('SDXYZ...');
 *
 * // Using a custom signature format:
 * const signer = new Ed25519CustomAccountSigner(keypair, (pubKey, sig) =>
 *   xdr.ScVal.scvBytes(sig) // raw bytes only
 * );
 * ```
 */
export class Ed25519CustomAccountSigner implements CustomAccountSigner {
  private _keypair: StellarSdk.Keypair;
  private _publicKeyBytes: Buffer;
  private _buildSignature: SignatureBuilder;

  constructor(keypair: StellarSdk.Keypair, buildSignature?: SignatureBuilder) {
    this._keypair = keypair;
    this._publicKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(keypair.publicKey());
    this._buildSignature = buildSignature ?? defaultSignatureBuilder;
  }

  static fromSecret(secret: string, buildSignature?: SignatureBuilder): Ed25519CustomAccountSigner {
    return new Ed25519CustomAccountSigner(StellarSdk.Keypair.fromSecret(secret), buildSignature);
  }

  static generate(buildSignature?: SignatureBuilder): Ed25519CustomAccountSigner {
    return new Ed25519CustomAccountSigner(StellarSdk.Keypair.random(), buildSignature);
  }

  get publicKey(): string {
    return this._keypair.publicKey();
  }

  get secretKey(): string {
    return this._keypair.secret();
  }

  get publicKeyBytes(): Buffer {
    return this._publicKeyBytes;
  }

  get keypair(): StellarSdk.Keypair {
    return this._keypair;
  }

  /**
   * Sign a single Soroban auth entry.
   *
   * 1. Extract nonce + rootInvocation from the auth entry
   * 2. Build HashIdPreimage for Soroban authorization (protocol-standard)
   * 3. Hash + sign with ed25519
   * 4. Wrap via SignatureBuilder (contract-specific)
   * 5. Return new auth entry with signed credentials
   */
  signAuthEntry(
    auth: StellarSdk.xdr.SorobanAuthorizationEntry,
    validUntilLedger: number,
    networkIdHash: Buffer,
  ): StellarSdk.xdr.SorobanAuthorizationEntry {
    const addressCreds = auth.credentials().address();
    const nonce = addressCreds.nonce();

    const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new StellarSdk.xdr.HashIdPreimageSorobanAuthorization({
        networkId: networkIdHash,
        nonce,
        signatureExpirationLedger: validUntilLedger,
        invocation: auth.rootInvocation(),
      })
    );

    const payload = StellarSdk.hash(preimage.toXDR());
    const signatureBytes = this._keypair.sign(payload);
    const signatureScVal = this._buildSignature(this._publicKeyBytes, signatureBytes);

    const newAddressCreds = new StellarSdk.xdr.SorobanAddressCredentials({
      address: addressCreds.address(),
      nonce,
      signatureExpirationLedger: validUntilLedger,
      signature: signatureScVal,
    });

    return new StellarSdk.xdr.SorobanAuthorizationEntry({
      credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(newAddressCreds),
      rootInvocation: auth.rootInvocation(),
    });
  }

  /** Sign all address-credential auth entries. Non-address entries pass through unchanged. */
  signAllAuthEntries(
    authEntries: (string | StellarSdk.xdr.SorobanAuthorizationEntry)[],
    validUntilLedger: number,
    networkPassphrase: string,
  ): StellarSdk.xdr.SorobanAuthorizationEntry[] {
    const networkIdHash = computeNetworkIdHash(networkPassphrase);

    return authEntries.map(entry => {
      const auth = parseAuthEntry(entry);
      if (auth.credentials().switch().name === 'sorobanCredentialsAddress') {
        return this.signAuthEntry(auth, validUntilLedger, networkIdHash);
      }
      return auth;
    });
  }
}
