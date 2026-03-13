# Lumenitos TypeScript Libraries

Two TypeScript libraries for interacting with Soroban custom account contracts on Stellar.

## Architecture

```
lib/
  soroban-custom-account/    Generic Soroban infrastructure
  agent-sdk/                 Lumenitos-specific agent wallet SDK
```

**`soroban-custom-account`** is the generic foundation — auth signing, transaction submission (direct self-pay + OZ Relayer fee-sponsored), and pure utilities. It works with **any** Soroban custom account contract, not just Lumenitos.

**`agent-sdk`** is the Lumenitos application layer — wraps the specific `simple_account` and `account_factory` contracts with a high-level `AgentWallet` API for AI agents.

## Which one do I use?

**"I'm building an AI agent that uses Lumenitos wallets."**
Use `agent-sdk`. It gives you `AgentWallet` with one-liner `transfer()`, `swap()`, `supply()`, etc.

```ts
import { AgentWallet } from '@/lib/agent-sdk';

const wallet = AgentWallet.fromSecret('SDXYZ...', { network: 'testnet' });
await wallet.transfer({ token: 'native', to: 'GBXYZ...', amount: '50.0' });
```

**"I wrote my own Soroban custom account contract and need TypeScript client infrastructure."**
Use `soroban-custom-account`. It gives you pluggable auth signing and submission pipelines.

```ts
import { Ed25519CustomAccountSigner, DirectSubmitter } from '@/lib/soroban-custom-account';

const signer = Ed25519CustomAccountSigner.fromSecret('SDXYZ...', mySignatureBuilder);
const submitter = new DirectSubmitter(signer, rpcServer, networkConfig);
await submitter.submit(myOperation, signer.publicKey);
```

## How they relate

```
┌─────────────────────────────────────────────┐
│  agent-sdk (Lumenitos-specific)             │
│                                             │
│  AgentWallet  AccountClient  FactoryClient  │
│  Networks     InviteSystem   AgentPolicy    │
│                                             │
├─────────────────────────────────────────────┤
│  soroban-custom-account (generic)           │
│                                             │
│  Ed25519CustomAccountSigner                 │
│  DirectSubmitter   RelayerSubmitter          │
│  toRawAmount  deriveContractAddress         │
│  simulateRead  waitForTransaction           │
│                                             │
└─────────────────────────────────────────────┘
```

The key abstraction boundary is `SignatureBuilder` — a callback that wraps raw ed25519 signature bytes into the ScVal format your contract's `__check_auth` expects. The generic layer handles everything else (preimage construction, hashing, submission pipeline).

## Documentation

- [soroban-custom-account README](./soroban-custom-account/README.md) — generic layer docs
- [agent-sdk README](./agent-sdk/README.md) — Lumenitos agent SDK docs

## Status

Both libraries are functional but not yet validated on testnet. The Soroban contracts (45 tests passing) are verified at the unit level, but real `__check_auth` with the Signature struct has not been exercised on-chain yet. That is the Phase 3 milestone.
