//! Agent Account Factory for Lumenitos wallet (v3).
//!
//! Deploys agent contract accounts with one-call onboarding:
//! deploy + configure agent + fund — all in one atomic transaction.
//!
//! Invite codes are "agent starter kits" carrying budget + policy.
//! Factory holds a token pool; agents are funded from it on deploy.
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, Vec};

// Shared types — single source of truth across all contracts
pub use agent_types::{AccessControl, AgentPolicy, TokenAmount, TokenLimit};

/// Everything an agent needs to get started.
/// Stored with the invite code in temporary storage.
#[derive(Clone)]
#[contracttype]
pub struct InviteConfig {
    pub funding: Vec<TokenAmount>,      // tokens + amounts to fund
    pub policy: AgentPolicy,            // full policy for the agent
}

#[contract]
pub struct AccountFactory;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    WasmHash,                       // BytesN<32>
    Owner,                          // Address (for require_auth)
    OwnerKey,                       // BytesN<32> (raw ed25519 key for deployed contracts)
    Invite(BytesN<32>),             // InviteConfig (temporary storage)
}

const INVITE_TTL_LEDGERS: u32 = 120_960;   // ~7 days
const MAX_BATCH_SIZE: u32 = 50;

#[contractimpl]
impl AccountFactory {
    /// Initialize with WASM hash, owner address, and owner's raw public key.
    /// The address is used for require_auth. The raw key is passed to deployed contracts.
    pub fn __constructor(env: Env, wasm_hash: BytesN<32>, owner: Address, owner_key: BytesN<32>) {
        env.storage()
            .instance()
            .set(&DataKey::WasmHash, &wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Owner, &owner);
        env.storage()
            .instance()
            .set(&DataKey::OwnerKey, &owner_key);
    }

    // ===== Invite Management (owner only) =====

    /// Create a single invite code with its full config.
    pub fn create_invite(env: Env, invite_code: BytesN<32>, config: InviteConfig) {
        Self::require_owner(&env);

        let key = DataKey::Invite(invite_code);
        env.storage().temporary().set(&key, &config);
        env.storage()
            .temporary()
            .extend_ttl(&key, INVITE_TTL_LEDGERS, INVITE_TTL_LEDGERS);

        env.events()
            .publish((symbol_short!("invite"), symbol_short!("created")), ());
    }

    /// Create multiple invite codes sharing one config.
    pub fn create_invites(env: Env, codes: Vec<BytesN<32>>, config: InviteConfig) {
        Self::require_owner(&env);

        if codes.len() > MAX_BATCH_SIZE {
            panic!("batch too large");
        }

        for code in codes.iter() {
            let key = DataKey::Invite(code.clone());
            env.storage().temporary().set(&key, &config);
            env.storage()
                .temporary()
                .extend_ttl(&key, INVITE_TTL_LEDGERS, INVITE_TTL_LEDGERS);
        }

        env.events()
            .publish((symbol_short!("invite"), symbol_short!("batch")), codes.len());
    }

    // ===== Agent Onboarding =====

    /// Deploy a fully configured and funded agent contract account.
    ///
    /// One call does everything:
    /// 1. Validates and burns the invite code
    /// 2. Deploys the contract (owner key + agent key + policy via constructor)
    /// 3. Funds the contract from the factory's token pool
    ///
    /// # Panics
    /// - Invalid or expired invite code
    /// - Factory has insufficient token balance for funding
    pub fn create(env: Env, agent_key: BytesN<32>, invite_code: BytesN<32>) -> Address {
        // Load and validate invite
        let invite_key = DataKey::Invite(invite_code);
        let config: InviteConfig = env
            .storage()
            .temporary()
            .get(&invite_key)
            .expect("invalid or expired invite code");

        // Burn invite (atomic with rest of tx)
        env.storage().temporary().remove(&invite_key);

        // Get factory config
        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::WasmHash)
            .expect("wasm_hash not set");
        let owner_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OwnerKey)
            .expect("owner_key not set");

        // Deploy with agent_key as salt (deterministic address)
        // Constructor: (owner_key, Some(agent_key), Some(policy))
        let deployed_address = env
            .deployer()
            .with_current_contract(agent_key.clone())
            .deploy_v2(
                wasm_hash,
                (
                    owner_key,
                    Option::<BytesN<32>>::Some(agent_key.clone()),
                    Option::<AgentPolicy>::Some(config.policy),
                ),
            );

        // Fund the new contract from factory's token pool
        for f in config.funding.iter() {
            let client = token::Client::new(&env, &f.token);
            client.transfer(
                &env.current_contract_address(),
                &deployed_address,
                &f.amount,
            );
        }

        env.events().publish(
            (symbol_short!("agent"), symbol_short!("deployed")),
            (agent_key, deployed_address.clone()),
        );

        deployed_address
    }

    // ===== Owner Admin =====

    /// Rotate the factory owner (address + raw key).
    pub fn rotate_owner(env: Env, new_owner: Address, new_owner_key: BytesN<32>) {
        Self::require_owner(&env);

        env.storage()
            .instance()
            .set(&DataKey::Owner, &new_owner);
        env.storage()
            .instance()
            .set(&DataKey::OwnerKey, &new_owner_key);

        env.events()
            .publish((symbol_short!("owner"), symbol_short!("rotated")), new_owner);
    }

    /// Withdraw tokens from the factory's token pool.
    pub fn drain(env: Env, token_address: Address, destination: Address, amount: i128) {
        Self::require_owner(&env);

        let client = token::Client::new(&env, &token_address);
        client.transfer(&env.current_contract_address(), &destination, &amount);

        env.events()
            .publish((symbol_short!("drain"),), (token_address, destination, amount));
    }

    // ===== Read Functions =====

    pub fn wasm_hash(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::WasmHash)
            .expect("wasm_hash not set")
    }

    pub fn owner(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Owner)
            .expect("owner not set")
    }

    /// Compute deterministic address for an agent key without deploying.
    pub fn get_address(env: Env, agent_key: BytesN<32>) -> Address {
        env.deployer()
            .with_current_contract(agent_key)
            .deployed_address()
    }

    /// Check if an invite code is still valid.
    pub fn is_invite_valid(env: Env, invite_code: BytesN<32>) -> bool {
        env.storage()
            .temporary()
            .has(&DataKey::Invite(invite_code))
    }

    // ===== Internal =====

    fn require_owner(env: &Env) {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .expect("owner not set");
        owner.require_auth();
    }
}

// ===== Tests =====

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{vec, Env};

    // simple_account WASM — must build simple_account first: `stellar contract build`
    const ACCOUNT_WASM: &[u8] = include_bytes!(
        "../../simple_account/target/wasm32v1-none/release/simple_account.wasm"
    );

    // Import simple_account client from WASM for integration tests
    mod simple_account {
        use soroban_sdk::auth::Context;
        soroban_sdk::contractimport!(
            file = "../simple_account/target/wasm32v1-none/release/simple_account.wasm"
        );
    }

    // -- Helpers --

    fn create_token(env: &Env, admin: &Address) -> Address {
        env.register_stellar_asset_contract_v2(admin.clone())
            .address()
    }

    fn make_policy(env: &Env, token_addr: &Address) -> AgentPolicy {
        AgentPolicy {
            token_limits: vec![
                env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 0,
        }
    }

    fn make_invite_config(env: &Env, token_addr: &Address, amount: i128) -> InviteConfig {
        InviteConfig {
            funding: vec![
                env,
                TokenAmount {
                    token: token_addr.clone(),
                    amount,
                },
            ],
            policy: make_policy(env, token_addr),
        }
    }

    /// Set up factory with a token, funded factory, and invite config ready to go.
    fn setup_factory(
        env: &Env,
    ) -> (
        Address,                    // factory address
        AccountFactoryClient<'_>,  // factory client
        Address,                    // owner address
        BytesN<32>,                // owner key
        Address,                    // token address
        InviteConfig,              // invite config
    ) {
        let owner = Address::generate(env);
        let owner_key = BytesN::from_array(env, &[1u8; 32]);

        // Upload simple_account WASM to test env
        let wasm_hash = env.deployer().upload_contract_wasm(ACCOUNT_WASM);

        // Register factory
        let factory_addr = env.register(
            AccountFactory,
            (wasm_hash, owner.clone(), owner_key.clone()),
        );
        let factory = AccountFactoryClient::new(env, &factory_addr);

        // Create and fund a token
        let admin = Address::generate(env);
        let token_addr = create_token(env, &admin);

        // Fund the factory with tokens
        let token_admin = token::StellarAssetClient::new(env, &token_addr);
        token_admin.mint(&factory_addr, &10_000_0000000);

        let config = make_invite_config(env, &token_addr, 100_0000000);

        (factory_addr, factory, owner, owner_key, token_addr, config)
    }

    // ===== Constructor Tests =====

    #[test]
    fn test_constructor_stores_config() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, owner, _, _, _) = setup_factory(&env);

        assert_eq!(factory.owner(), owner);
        // wasm_hash should be set (non-zero)
        let hash = factory.wasm_hash();
        assert_ne!(hash, BytesN::from_array(&env, &[0u8; 32]));
    }

    // ===== Invite Management Tests =====

    #[test]
    fn test_create_invite_and_check_valid() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);

        // Before creating, invite should be invalid
        assert!(!factory.is_invite_valid(&invite_code));

        // Create invite
        factory.create_invite(&invite_code, &config);

        // Now it should be valid
        assert!(factory.is_invite_valid(&invite_code));
    }

    #[test]
    fn test_batch_create_invites() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);

        let code1 = BytesN::from_array(&env, &[10u8; 32]);
        let code2 = BytesN::from_array(&env, &[11u8; 32]);
        let code3 = BytesN::from_array(&env, &[12u8; 32]);
        let codes = vec![&env, code1.clone(), code2.clone(), code3.clone()];

        factory.create_invites(&codes, &config);

        assert!(factory.is_invite_valid(&code1));
        assert!(factory.is_invite_valid(&code2));
        assert!(factory.is_invite_valid(&code3));
    }

    #[test]
    #[should_panic(expected = "batch too large")]
    fn test_batch_over_limit_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);

        // Create 51 codes (over MAX_BATCH_SIZE of 50)
        let mut codes = Vec::new(&env);
        for i in 0u8..51 {
            let mut arr = [0u8; 32];
            arr[0] = i;
            codes.push_back(BytesN::from_array(&env, &arr));
        }

        factory.create_invites(&codes, &config);
    }

    // ===== Create (Deploy + Fund) Tests =====

    #[test]
    fn test_create_deploys_and_funds_agent() {
        let env = Env::default();
        env.mock_all_auths();

        let (factory_addr, factory, _, _, token_addr, config) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        factory.create_invite(&invite_code, &config);

        let factory_balance_before = token::Client::new(&env, &token_addr).balance(&factory_addr);

        // Deploy agent
        let agent_addr = factory.create(&agent_key, &invite_code);

        // Verify funding: factory lost 100 tokens, agent gained 100 tokens
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(
            token_client.balance(&factory_addr),
            factory_balance_before - 100_0000000
        );
        assert_eq!(token_client.balance(&agent_addr), 100_0000000);

        // Invite should be burned
        assert!(!factory.is_invite_valid(&invite_code));
    }

    #[test]
    fn test_create_address_is_deterministic() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        // Predict address before deploy
        let predicted = factory.get_address(&agent_key);

        factory.create_invite(&invite_code, &config);
        let actual = factory.create(&agent_key, &invite_code);

        assert_eq!(predicted, actual);
    }

    #[test]
    #[should_panic(expected = "invalid or expired invite code")]
    fn test_create_with_invalid_invite_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, _) = setup_factory(&env);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);
        let bad_code = BytesN::from_array(&env, &[99u8; 32]);

        // No invite created — should panic
        factory.create(&agent_key, &bad_code);
    }

    #[test]
    #[should_panic(expected = "invalid or expired invite code")]
    fn test_invite_double_use_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);

        factory.create_invite(&invite_code, &config);

        // First use succeeds
        let agent_key1 = BytesN::from_array(&env, &[2u8; 32]);
        factory.create(&agent_key1, &invite_code);

        // Second use with different agent key should panic — invite is burned
        let agent_key2 = BytesN::from_array(&env, &[3u8; 32]);
        factory.create(&agent_key2, &invite_code);
    }

    // ===== Owner Admin Tests =====

    #[test]
    fn test_drain_withdraws_tokens() {
        let env = Env::default();
        env.mock_all_auths();

        let (factory_addr, factory, _, _, token_addr, _) = setup_factory(&env);
        let destination = Address::generate(&env);

        factory.drain(&token_addr, &destination, &500_0000000);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&destination), 500_0000000);
        assert_eq!(token_client.balance(&factory_addr), 9_500_0000000);
    }

    #[test]
    fn test_rotate_owner() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, _) = setup_factory(&env);

        let new_owner = Address::generate(&env);
        let new_owner_key = BytesN::from_array(&env, &[9u8; 32]);

        factory.rotate_owner(&new_owner, &new_owner_key);

        assert_eq!(factory.owner(), new_owner);
    }

    // ===== Multi-token Funding Test =====

    #[test]
    fn test_create_with_multiple_tokens() {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);

        let wasm_hash = env.deployer().upload_contract_wasm(ACCOUNT_WASM);

        let factory_addr = env.register(
            AccountFactory,
            (wasm_hash, owner.clone(), owner_key.clone()),
        );
        let factory = AccountFactoryClient::new(&env, &factory_addr);

        // Create two tokens
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let token1 = create_token(&env, &admin1);
        let token2 = create_token(&env, &admin2);

        // Fund factory with both
        token::StellarAssetClient::new(&env, &token1).mint(&factory_addr, &5_000_0000000);
        token::StellarAssetClient::new(&env, &token2).mint(&factory_addr, &5_000_0000000);

        // Invite with multi-token funding
        let config = InviteConfig {
            funding: vec![
                &env,
                TokenAmount {
                    token: token1.clone(),
                    amount: 100_0000000,
                },
                TokenAmount {
                    token: token2.clone(),
                    amount: 200_0000000,
                },
            ],
            policy: AgentPolicy {
                token_limits: vec![
                    &env,
                    TokenLimit {
                        token: token1.clone(),
                        per_tx_limit: 50_0000000,
                    },
                    TokenLimit {
                        token: token2.clone(),
                        per_tx_limit: 100_0000000,
                    },
                ],
                access: AccessControl::AllowAll,
                expiry_ledger: 0,
            },
        };

        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        factory.create_invite(&invite_code, &config);
        let agent_addr = factory.create(&agent_key, &invite_code);

        // Verify both tokens funded
        assert_eq!(token::Client::new(&env, &token1).balance(&agent_addr), 100_0000000);
        assert_eq!(token::Client::new(&env, &token2).balance(&agent_addr), 200_0000000);
    }

    // ===== Integration Test: Factory → Deployed Contract Is Functional =====

    #[test]
    fn test_deployed_agent_can_transfer() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, token_addr, config) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        factory.create_invite(&invite_code, &config);
        let agent_addr = factory.create(&agent_key, &invite_code);

        // Use the deployed contract — agent_transfer should work immediately
        let account_client = simple_account::Client::new(&env, &agent_addr);
        let destination = Address::generate(&env);

        account_client.agent_transfer(&agent_key, &token_addr, &destination, &50_0000000);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&destination), 50_0000000);
        assert_eq!(token_client.balance(&agent_addr), 50_0000000); // 100 - 50
    }

    // ===== Duplicate Agent Key Test =====

    #[test]
    #[should_panic]
    fn test_duplicate_agent_key_deploy_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        let code1 = BytesN::from_array(&env, &[10u8; 32]);
        let code2 = BytesN::from_array(&env, &[11u8; 32]);

        factory.create_invite(&code1, &config);
        factory.create_invite(&code2, &config);

        // First deploy succeeds
        factory.create(&agent_key, &code1);

        // Second deploy with same agent_key panics — address already occupied
        factory.create(&agent_key, &code2);
    }

    // ===== Edge Case Tests =====

    #[test]
    fn test_create_with_empty_funding() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, token_addr, _) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        // Invite with no funding — agent deploys but receives nothing
        let config = InviteConfig {
            funding: vec![&env],
            policy: make_policy(&env, &token_addr),
        };

        factory.create_invite(&invite_code, &config);
        let agent_addr = factory.create(&agent_key, &invite_code);

        // Agent exists but has zero balance
        assert_eq!(token::Client::new(&env, &token_addr).balance(&agent_addr), 0);
    }

    #[test]
    fn test_batch_exactly_at_limit() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, _, config) = setup_factory(&env);

        // Create exactly MAX_BATCH_SIZE (50) codes — should succeed
        let mut codes = Vec::new(&env);
        for i in 0u8..50 {
            let mut arr = [0u8; 32];
            arr[0] = i;
            codes.push_back(BytesN::from_array(&env, &arr));
        }

        factory.create_invites(&codes, &config);

        // Verify first and last are valid
        let mut first = [0u8; 32];
        first[0] = 0;
        let mut last = [0u8; 32];
        last[0] = 49;
        assert!(factory.is_invite_valid(&BytesN::from_array(&env, &first)));
        assert!(factory.is_invite_valid(&BytesN::from_array(&env, &last)));
    }

    #[test]
    fn test_create_with_empty_token_limits() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, token_addr, _) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        // Policy with no token limits — agent has no spending rules
        let config = InviteConfig {
            funding: vec![
                &env,
                TokenAmount {
                    token: token_addr.clone(),
                    amount: 100_0000000,
                },
            ],
            policy: AgentPolicy {
                token_limits: vec![&env],
                access: AccessControl::AllowAll,
                expiry_ledger: 0,
            },
        };

        factory.create_invite(&invite_code, &config);
        let agent_addr = factory.create(&agent_key, &invite_code);

        // Funded but with empty token limits
        assert_eq!(token::Client::new(&env, &token_addr).balance(&agent_addr), 100_0000000);
    }

    #[test]
    fn test_create_with_expiry_policy() {
        let env = Env::default();
        env.mock_all_auths();

        let (_, factory, _, _, token_addr, _) = setup_factory(&env);
        let invite_code = BytesN::from_array(&env, &[10u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        // Policy with non-zero expiry
        let config = InviteConfig {
            funding: vec![
                &env,
                TokenAmount {
                    token: token_addr.clone(),
                    amount: 100_0000000,
                },
            ],
            policy: AgentPolicy {
                token_limits: vec![
                    &env,
                    TokenLimit {
                        token: token_addr.clone(),
                        per_tx_limit: 50_0000000,
                    },
                ],
                access: AccessControl::AllowAll,
                expiry_ledger: 5000,
            },
        };

        factory.create_invite(&invite_code, &config);
        let agent_addr = factory.create(&agent_key, &invite_code);

        // Verify the policy expiry was correctly passed through deploy_v2
        let account_client = simple_account::Client::new(&env, &agent_addr);
        let stored_policy = account_client.get_policy(&agent_key);
        assert_eq!(stored_policy.expiry_ledger, 5000);
    }
}
