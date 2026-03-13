# Lumenitos

> **This repo is a fork of [tomerweller/lumenitos](https://github.com/tomerweller/lumenitos)**, a minimalist Stellar smart wallet. The original wallet and scan features are documented below.
>
> **Active development** on my fork here is focused on the **Agent Wallet System** — autonomous Soroban smart wallets with owner-defined policies, invite-based onboarding, and fee-sponsored transactions via a self-hosted OZ Relayer.
>
> **Start here:**
> - **[AgentFlow.md](AgentFlow.md)** — Design document: architecture, security model, policy system, onboarding flow
> - **[AgentFlowStatus.md](AgentFlowStatus.md)** — Current status, what's built, what's next
> - **[docs/how-it-works.md](docs/how-it-works.md)** — How it all works: transaction flow, setup tutorial, troubleshooting
>
> **Check out experimental implementation on Testnet** — deployed and verified with real `__check_auth` ed25519 verification and fee sponsorship via OZ Relayer:
>
> | Step | Transaction |
> |------|------------|
> | Owner creates invite for agent | [`d39e8cb3...`](https://stellar.expert/explorer/testnet/tx/d39e8cb3fb055a7cccf537282b77ef829eba1d02bfde03b6a3e70d5f2333d740) |
> | Agent onboards via relayer | [`014e5401...`](https://stellar.expert/explorer/testnet/tx/014e54012b241601dfb7ef92a2bba7d35bd436a9e9e407473f93fd5444d92b88) |
> | Agent transfers 5 XLM via relayer | [`993eb520...`](https://stellar.expert/explorer/testnet/tx/993eb5209511c746a10e44e29afec26927ce3b98b6518517d9eda2c86fd0a2be) |
>
> | Account | Explorer |
> |---------|----------|
> | Factory contract | [`CBBOC65D...`](https://stellar.expert/explorer/testnet/contract/CBBOC65D5RRPYJWRULZCRR6OTPSZ4IV6MPPB2PHWOHIMHTSWRRC2IPJR) |
> | Agent contract | [`CBJS5QGO...`](https://stellar.expert/explorer/testnet/contract/CBJS5QGOHVSEQU6X6CVALHVRLBR36T5BQGHKWP6ELGOKOXTPGPZPM53D) |
> | Owner | [`GA3MN25S...`](https://stellar.expert/explorer/testnet/account/GA3MN25S4J3F4FTYA64354XOOL4HAB3ENOOSRPRECYXIMI4KMZC6OIWT) |

---

A minimalist Stellar smart wallet and token explorer built with Next.js and Soroban.

**Live Demo:**
- **Testnet:** https://lumenitos-testnet.vercel.app/
- **Mainnet:** https://lumenitos.vercel.app/ ⚠️ **REAL FUNDS - USE AT YOUR OWN RISK**

## Features

Lumenitos includes two main features:

- **Wallet** (`/wallet`) - Self-custodied smart wallet with local key management
- **Scan** (`/scan`) - Mini token explorer for viewing balances and transfer history

## Wallet

Lumenitos Wallet is an experimental Stellar smart wallet that combines local key management with a custom Soroban contract account. It provides a simple, text-based interface for creating and managing Stellar wallets.

### Dual Account Architecture

Lumenitos manages two accounts from a single keypair:

- **Classic Account (G...)**: A standard Stellar account that holds the keypair. Supports traditional Stellar operations and can send XLM to both classic and contract addresses.
- **Contract Account (C...)**: A custom `simple_account` Soroban contract that uses ed25519 signature verification. Enables self-custodied smart wallet functionality with programmable features.

Both accounts can send and receive XLM independently, with balances fetched directly from Stellar RPC.

### Key Features

- **Dual Account Management**: Manage both classic and contract accounts from one keypair
- **Self-Custodied Smart Wallet**: Custom Soroban contract with ed25519 signature verification
- **Local Key Storage**: Private keys stored in browser localStorage with cached state for instant loading
- **12-Word Recovery Phrase**: BIP39 mnemonic support with SEP-0005 derivation path
- **Simple UX**: Minimalist text-based interface with dark/light theme toggle (bottom-right corner)
- **QR Code Support**: Generate QR codes for receiving and scan QR codes for sending
- **Muxed ID Support**: Optional muxed account IDs for both sending and receiving
- **Auto-refresh**: Balances automatically refresh when window gains focus
- **Core Operations**:
  - Generate new Stellar keypair with associated smart wallet
  - Export/import wallet using 12-word recovery phrase
  - Send and receive XLM on both classic and contract accounts
  - View balances for both accounts with last updated timestamp
  - View transfer history for both accounts (last 5 XLM transfers via Soroban RPC)
  - View and extend contract TTLs (time-to-live) for instance, code, and balance entries
  - Fund testnet accounts via Friendbot
  - Progressive Web App (PWA) support for mobile
- **Gasless Transactions** (optional): Fee-free transfers via [OpenZeppelin Channels](https://docs.openzeppelin.com/relayer/1.2.x/plugins/channels) (works for both classic and contract accounts)

## Scan

Lumenitos Scan is a mini token explorer for viewing any Stellar address's token balances and transfer history.

### Scan Features

- **Account View** (`/scan/account/[address]`) - View balances and transfers for any G... or C... address
- **Token View** (`/scan/token/[address]`) - View token metadata and recent transfers for any SEP-41 token
- **SEP-41 Support** - Works with any SEP-41 compliant token (XLM, USDC, custom tokens)
- **Auto-Discovery** - Automatically discovers tokens from transfer history
- **Manual Asset Tracking** - Add any token contract to track its balance
- **Metadata Caching** - Token metadata (name, symbol, decimals) cached in localStorage
- **Proper Decimals** - Displays amounts using each token's actual decimal precision

### Scan Routes

| Route | Description |
|-------|-------------|
| `/scan` | Search page - enter any address |
| `/scan/account/[address]` | Account view - balances and transfers |
| `/scan/token/[address]` | Token view - token info and recent transfers |

## Architecture

### Frontend
- **Framework**: Next.js 16 (App Router)
- **UI**: Custom minimalist CSS with dark/light theme support
- **Components**:
  - `WalletSetup` - Initial wallet creation flow
  - `WalletDashboard` - Main wallet interface

### Smart Contracts
- **Language**: Rust (Soroban SDK)
- **Contracts**:
  - `simple_account` - implements `__check_auth` for custom account authentication (location: `contracts/simple_account/`)
  - `account_factory` - factory contract that deploys new simple_account instances (location: `contracts/account_factory/`)

### Wallet Flow

1. **Local Keypair Generation**: Creates a Stellar keypair from a 12-word mnemonic stored in browser
2. **Contract Deployment**: Calls the factory contract to deploy a `simple_account` contract with the keypair's public key as owner. The contract address is deterministically derived from the factory address + public key bytes as salt.
3. **Transaction Signing**: Transactions are signed locally using ed25519
4. **On-Chain Verification**: The contract's `__check_auth` verifies signatures before authorizing operations

## Getting Started

### Prerequisites

- Node.js 18+

### Installation

1. Clone the repository:
```bash
git clone https://github.com/tomerweller/lumenitos.git
cd lumenitos
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

### Production Build

```bash
npm run build
npm start
```

### Running Tests

```bash
# Run all Jest tests
npm test

# Run specific test suites
npm run test:unit        # Unit tests (pure functions)
npm run test:integration # Integration tests (testnet RPC)
npm run test:components  # React component tests

# Watch mode for development
npm run test:watch

# Generate coverage report
npm run test:coverage

# Run E2E tests with Playwright
npm run test:e2e         # Headless
npm run test:e2e:ui      # Interactive UI mode
npm run test:e2e:headed  # Headed browser
```

## Usage

### Creating a Wallet

1. Click "Create Wallet" on the setup page
2. A 12-word recovery phrase is generated and a Stellar keypair is derived
3. The `simple_account` contract is deployed with your public key as the owner
4. You'll see your wallet dashboard with balance and addresses

### Importing a Wallet

1. Click "Import" on the setup page
2. Enter your 12-word recovery phrase
3. The same keypair and contract address will be derived

### Funding Your Wallet (Testnet)

Click the "fund" link to use Stellar's Friendbot to add testnet XLM to your wallet.

### Sending XLM

1. Click "send" on the dashboard
2. Enter the destination Stellar address
3. Enter the amount in XLM
4. Click "send" to sign and submit the transaction

### Receiving XLM

1. Click "receive" to display a QR code with your wallet address
2. Share the address or QR code with the sender

## Project Structure

```
lumenitos/
├── app/
│   ├── page.jsx              # Root redirect to /wallet
│   ├── layout.js             # Root layout with PWA support
│   ├── globals.css           # Global styles
│   ├── wallet/               # Wallet feature
│   │   ├── page.jsx          # Wallet main page
│   │   └── App.css           # Wallet styles
│   ├── scan/                 # Scan feature
│   │   ├── page.jsx          # Scan search page
│   │   ├── scan.css          # Scan styles
│   │   ├── [address]/page.jsx        # Redirect to /scan/account/[address]
│   │   ├── account/[address]/page.jsx # Account view
│   │   └── token/[address]/page.jsx   # Token view
│   └── api/
│       └── health/route.js   # Health check endpoint
├── components/
│   ├── WalletSetup.jsx       # Initial setup component
│   ├── WalletDashboard.jsx   # Main wallet interface
│   └── WalletDashboard.css   # Dashboard styles
├── contracts/
│   ├── simple_account/       # Custom account contract
│   │   ├── src/lib.rs        # Contract with __check_auth
│   │   └── out/              # Compiled WASM artifact
│   └── account_factory/      # Factory for deploying accounts
│       ├── src/lib.rs        # Factory with create() function
│       └── out/              # Compiled WASM artifact
├── utils/
│   ├── config.js             # Configuration management
│   ├── stellar/              # Wallet Stellar utilities
│   │   ├── index.js          # Public API exports
│   │   ├── storage.js        # Storage abstraction
│   │   ├── rpc.js            # RPC client factory
│   │   ├── keypair.js        # Keypair derivation and management
│   │   ├── helpers.js        # Conversion utilities
│   │   ├── balance.js        # Balance queries
│   │   ├── transfer.js       # Transfer operations
│   │   ├── contract.js       # Contract deployment and auth
│   │   ├── ttl.js            # TTL management
│   │   └── gasless.js        # Gasless transfers via OZ Channels
│   └── scan/                 # Scan utilities
│       └── index.js          # Token balances, transfers, metadata
├── scripts/
│   └── compute-wasm-hash.js  # Compute WASM hash at build time
├── __tests__/
│   ├── unit/                 # Unit tests for pure functions
│   ├── integration/          # Integration tests (testnet RPC)
│   └── components/           # React component tests
├── e2e/                      # Playwright E2E tests
└── public/
    ├── sw.js                 # Service worker
    └── icon-*.png            # PWA icons
```

## Technology Stack

- **Next.js 16** - React framework with App Router
- **Stellar SDK** - Stellar blockchain integration
- **Soroban SDK** - Smart contract development (Rust)
- **Soroban RPC** - Direct Stellar RPC for balance queries and transactions
- **QRCode.react** - QR code generation
- **@yudiel/react-qr-scanner** - QR code scanning
- **bip39** - Mnemonic phrase generation
- **ed25519-hd-key** - HD key derivation
- **localStorage** - Client-side key storage

### Testing

- **Jest** - Unit and integration testing
- **React Testing Library** - Component testing
- **Playwright** - End-to-end browser testing

## Security Notes

**THIS IS AN EXPERIMENTAL WALLET - NOT SECURE FOR PRODUCTION USE**

- **This wallet is NOT secure** - it is a proof of concept only
- Private keys are stored in browser localStorage (not production-ready)
- No encryption, no secure enclave, no hardware wallet support
- Only use with testnet XLM
- Do not use for real funds
- This is a demonstration of custom Soroban contract account architecture

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_STELLAR_NETWORK` | Network to use (`testnet` or `mainnet`) | No (default: `testnet`) |
| `NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL` | Soroban RPC endpoint | No (default: testnet RPC) |
| `NEXT_PUBLIC_STELLAR_FRIENDBOT_URL` | Friendbot URL for testnet funding | No (default: testnet Friendbot) |
| `NEXT_PUBLIC_STELLAR_EXPLORER_URL` | Block explorer URL | No (default: stellar.expert testnet) |
| `NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS` | Factory contract address for deploying new wallets | No (default: testnet factory) |
| `NEXT_PUBLIC_OZ_CHANNELS_API_KEY` | OpenZeppelin Channels API key for gasless transactions | No (gasless disabled if not set) |
| `STELLAR_WASM_ADMIN_SECRET` | Server-side Stellar secret for WASM lifecycle (install/restore/TTL bump) | No (WASM auto-management disabled if not set) |

### Gasless Transactions Setup

To enable gasless (fee-free) transactions using [OpenZeppelin Channels](https://docs.openzeppelin.com/relayer/1.1.x/guides/stellar-channels-guide):

> **Important**: Gasless transfers only work for **contract account** (C...) sends, not classic account (G...) sends. This is because OZ Channels requires "address credentials" which only contract accounts provide.

1. Get a free API key from:
   - **Testnet**: https://channels.openzeppelin.com/testnet/gen
   - **Mainnet**: https://channels.openzeppelin.com/gen

2. Add to your `.env.local`:
   ```
   NEXT_PUBLIC_OZ_CHANNELS_API_KEY=your-api-key-here
   ```

3. When sending XLM from the **contract account**, check the "gasless (no fee)" checkbox to use fee-free transactions

## Deployment

### Deploy to Vercel

The easiest way to deploy Lumenitos:

1. Push your code to GitHub
2. Import the project to [Vercel](https://vercel.com)
3. Deploy

Vercel will automatically configure Next.js and build the application.

## Contributing

Contributions are welcome! This is an experimental project demonstrating custom Soroban contract account integration.

## License

ISC

## Links

- [Stellar Documentation](https://developers.stellar.org)
- [Soroban Documentation](https://soroban.stellar.org)
- [Next.js Documentation](https://nextjs.org/docs)
