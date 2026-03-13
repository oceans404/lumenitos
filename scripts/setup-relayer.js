#!/usr/bin/env node
/**
 * Setup script for the OpenZeppelin Relayer for Lumenitos.
 *
 * Generates a fresh Stellar keypair for the relayer, funds it via friendbot,
 * creates an encrypted keystore file (Web3 secret storage v3 format compatible
 * with oz-keystore), and writes the .env file.
 *
 * Usage:
 *   node scripts/setup-relayer.js
 *
 * Options:
 *   KEYSTORE_PASSPHRASE — Override the default dev passphrase.
 *   API_KEY             — Override the default dev API key.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

// ============================================================================
// Configuration
// ============================================================================

const RELAYER_DIR = path.resolve(__dirname, '..', 'relayer');
const CONFIG_DIR = path.join(RELAYER_DIR, 'config');
const KEYS_DIR = path.join(CONFIG_DIR, 'keys');
const KEYSTORE_PATH = path.join(KEYS_DIR, 'local-signer.json');
const ENV_PATH = path.join(RELAYER_DIR, '.env');

const DEFAULT_PASSPHRASE = process.env.KEYSTORE_PASSPHRASE || 'LumenitosDevPass123!';
const DEFAULT_API_KEY = process.env.API_KEY || 'test-api-key-lumenitos-dev-32chars!!';
const DEFAULT_WEBHOOK_KEY = process.env.WEBHOOK_SIGNING_KEY || 'test-webhook-key-lumenitos-dev-32ch!!';

// ============================================================================
// Keystore generation (Web3 Secret Storage v3 format)
//
// The OZ Relayer uses oz-keystore which is compatible with the Web3 secret
// storage definition (version 3). This uses scrypt for key derivation and
// aes-128-ctr for encryption.
//
// Reference: https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/
// The format stores the raw 32-byte private key (ed25519 seed for Stellar).
// ============================================================================

function createKeystoreV3(privateKeyBytes, passphrase) {
  // scrypt parameters (matching OZ Relayer defaults from test keystore)
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const n = 8192;
  const r = 8;
  const p = 1;
  const dklen = 32;

  // Derive key using scrypt
  const derivedKey = crypto.scryptSync(
    Buffer.from(passphrase, 'utf-8'),
    salt,
    dklen,
    { N: n, r, p, maxmem: 128 * n * r * 2 }
  );

  // Encrypt with aes-128-ctr using first 16 bytes of derived key
  const encryptionKey = derivedKey.slice(0, 16);
  const cipher = crypto.createCipheriv('aes-128-ctr', encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKeyBytes),
    cipher.final(),
  ]);

  // MAC: keccak256(derivedKey[16:32] + ciphertext)
  // oz-keystore uses SHA-256 for MAC (not keccak), matching the test keystore format
  const macInput = Buffer.concat([derivedKey.slice(16, 32), ciphertext]);
  const mac = crypto.createHash('sha256').update(macInput).digest();

  return {
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: {
        iv: iv.toString('hex'),
      },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: {
        dklen,
        n,
        p,
        r,
        salt: salt.toString('hex'),
      },
      mac: mac.toString('hex'),
    },
    id: crypto.randomUUID(),
    version: 3,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('');
  console.log('======================================================================');
  console.log('  Lumenitos — OZ Relayer Setup');
  console.log('======================================================================');
  console.log('');

  // 1. Generate fresh Stellar keypair
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  console.log(`  Generated relayer keypair:`);
  console.log(`    Public:  ${publicKey}`);
  console.log(`    Secret:  ${secretKey.slice(0, 8)}...${secretKey.slice(-4)}`);
  console.log('');

  // 2. Fund via friendbot
  console.log('  Funding via friendbot...');
  try {
    const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Friendbot returned ${response.status}: ${text.slice(0, 200)}`);
    }
    console.log('  Funded successfully (10,000 XLM on testnet)');
  } catch (err) {
    console.error(`  WARNING: Could not fund via friendbot: ${err.message}`);
    console.error('  You may need to fund the relayer account manually.');
    console.error(`  Visit: https://friendbot.stellar.org?addr=${publicKey}`);
  }
  console.log('');

  // 3. Create keystore file
  // The raw private key for Stellar is the 32-byte ed25519 seed
  const rawSeed = keypair.rawSecretKey();

  const keystore = createKeystoreV3(rawSeed, DEFAULT_PASSPHRASE);

  // Ensure directories exist
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2) + '\n');
  console.log(`  Keystore written to: ${path.relative(process.cwd(), KEYSTORE_PATH)}`);
  console.log(`  Passphrase: ${DEFAULT_PASSPHRASE}`);
  console.log('');

  // 4. Write .env file
  const envContent = [
    '# OZ Relayer environment — generated by setup-relayer.js',
    `# Relayer account: ${publicKey}`,
    `# Generated: ${new Date().toISOString()}`,
    '',
    `API_KEY=${DEFAULT_API_KEY}`,
    `WEBHOOK_SIGNING_KEY=${DEFAULT_WEBHOOK_KEY}`,
    `KEYSTORE_PASSPHRASE=${DEFAULT_PASSPHRASE}`,
    'RUST_LOG=info',
    '',
  ].join('\n');

  fs.writeFileSync(ENV_PATH, envContent);
  console.log(`  .env written to: ${path.relative(process.cwd(), ENV_PATH)}`);
  console.log('');

  // 5. Print instructions
  console.log('======================================================================');
  console.log('  Setup Complete!');
  console.log('======================================================================');
  console.log('');
  console.log('  Relayer public key (save this for your tests):');
  console.log(`    ${publicKey}`);
  console.log('');
  console.log('  To start the relayer:');
  console.log('');
  console.log('    cd relayer');
  console.log('    docker compose up');
  console.log('');
  console.log('  The relayer API will be available at http://localhost:8080');
  console.log('  Relayer ID: stellar-testnet');
  console.log(`  API Key: ${DEFAULT_API_KEY}`);
  console.log('');
  console.log('  To run the E2E test with relayer:');
  console.log('');
  console.log('    OWNER_SECRET=SAELD75GMPL62WT3JRMDB7SMRCBZXO7OSXMJ4KPOF4VME4VPFFB6OP5A \\');
  console.log('      RELAYER_URL=http://localhost:8080 \\');
  console.log(`      RELAYER_API_KEY=${DEFAULT_API_KEY} \\`);
  console.log('      node scripts/e2e-test-relayer.js');
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
