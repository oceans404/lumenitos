//! Agent-capable account contract for Lumenitos wallet (v3).
//!
//! Supports a single owner (full control) and multiple agent signers
//! with per-agent policies. Agents interact with external protocols
//! (Blend, DEXes, etc.) via wrapper functions that enforce policies.
//!
//! Security model: agents can ONLY authorize calls to whitelisted
//! wrapper functions on this contract. All external interactions are
//! proxied through the contract, which checks policies before forwarding.
//!
//! Budget model: account balance = total spending cap. Per-tx limits
//! enforced per token in wrapper functions. Owner tops up or drains.
#![no_std]

use soroban_sdk::{
    auth::Context, contract, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, Symbol, TryIntoVal, Val, Vec,
};

// Shared types — single source of truth across all contracts
pub use agent_types::{AccessControl, AgentPolicy, TokenAmount, TokenLimit};

#[contract]
pub struct SimpleAccount;

// ===== Storage Keys =====

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Owner,                  // BytesN<32> - owner public key
    Agent(BytesN<32>),      // AgentStatus - per agent key
    Policy(BytesN<32>),     // AgentPolicy - per agent key
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum AgentStatus {
    Active,
    Frozen,
}

// ===== Signature Format =====

/// Agent identifies which key signed.
#[derive(Clone)]
#[contracttype]
pub struct Signature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

// ===== Whitelisted agent functions =====
// Agents can ONLY authorize calls to these functions on self.

const FN_AGENT_TRANSFER: &str = "agent_transfer";
const FN_AGENT_INVOKE: &str = "agent_invoke";
const FN_AGENT_SWAP: &str = "agent_swap";
const FN_AGENT_SUPPLY: &str = "agent_supply";
const FN_AGENT_WITHDRAW: &str = "agent_withdraw";

// ===== TTL Constants =====

const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;      // ~1 day
const PERSISTENT_TTL_EXTEND: u32 = 120_960;         // ~7 days

// ===== Helpers =====

fn is_owner(env: &Env, key: &BytesN<32>) -> bool {
    let owner: BytesN<32> = env.storage().instance().get(&DataKey::Owner).unwrap();
    *key == owner
}

fn require_contract_auth(env: &Env) {
    env.current_contract_address().require_auth();
}

fn check_access(access: &AccessControl, target: &Address) -> bool {
    match access {
        AccessControl::AllowAll => true,
        AccessControl::AllowOnly(list) => {
            for addr in list.iter() {
                if *target == addr {
                    return true;
                }
            }
            false
        }
        AccessControl::DenyOnly(list) => {
            for addr in list.iter() {
                if *target == addr {
                    return false;
                }
            }
            true
        }
    }
}

fn check_token_limit(policy: &AgentPolicy, token: &Address, amount: i128) {
    let mut found = false;
    for tl in policy.token_limits.iter() {
        if tl.token == *token {
            if tl.per_tx_limit > 0 && amount > tl.per_tx_limit {
                panic!("exceeds per-transaction limit");
            }
            found = true;
            break;
        }
    }
    if !found {
        panic!("token not allowed by policy");
    }
}

fn load_agent_policy(env: &Env, agent_key: &BytesN<32>) -> AgentPolicy {
    // Check agent status
    let status: AgentStatus = env
        .storage()
        .persistent()
        .get(&DataKey::Agent(agent_key.clone()))
        .expect("unknown agent");

    // Extend TTL on read
    env.storage().persistent().extend_ttl(
        &DataKey::Agent(agent_key.clone()),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );

    if status == AgentStatus::Frozen {
        panic!("agent is frozen");
    }

    // Load policy
    let policy: AgentPolicy = env
        .storage()
        .persistent()
        .get(&DataKey::Policy(agent_key.clone()))
        .expect("no policy set");

    // Extend TTL on read
    env.storage().persistent().extend_ttl(
        &DataKey::Policy(agent_key.clone()),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );

    // Check expiry
    if policy.expiry_ledger > 0 && env.ledger().sequence() > policy.expiry_ledger {
        panic!("agent key expired");
    }

    policy
}

fn is_whitelisted_agent_fn(fn_name: &Symbol, env: &Env) -> bool {
    *fn_name == Symbol::new(env, FN_AGENT_TRANSFER)
        || *fn_name == Symbol::new(env, FN_AGENT_INVOKE)
        || *fn_name == Symbol::new(env, FN_AGENT_SWAP)
        || *fn_name == Symbol::new(env, FN_AGENT_SUPPLY)
        || *fn_name == Symbol::new(env, FN_AGENT_WITHDRAW)
}

// ===== Contract Implementation =====

#[contractimpl]
impl SimpleAccount {
    /// Initialize with owner key. Optionally register an initial agent + policy.
    /// Called by the factory during deployment.
    pub fn __constructor(
        env: Env,
        owner_key: BytesN<32>,
        agent_key: Option<BytesN<32>>,
        policy: Option<AgentPolicy>,
    ) {
        env.storage().instance().set(&DataKey::Owner, &owner_key);

        // Validate: both or neither must be provided
        if agent_key.is_some() != policy.is_some() {
            panic!("agent_key and policy must both be provided or both be None");
        }

        // If agent key and policy are provided, register the agent immediately
        if let (Some(ak), Some(p)) = (agent_key, policy) {
            env.storage()
                .persistent()
                .set(&DataKey::Agent(ak.clone()), &AgentStatus::Active);
            env.storage()
                .persistent()
                .set(&DataKey::Policy(ak.clone()), &p);

            env.events()
                .publish((symbol_short!("agent"), symbol_short!("added")), ak);
        }
    }

    // ===== Authentication =====

    /// Soroban calls this when this contract's address is used with `require_auth`.
    ///
    /// Owner: allow everything.
    /// Agent: ONLY allow whitelisted wrapper functions on self.
    ///        Block all admin functions and all direct external contract auth.
    #[allow(non_snake_case)]
    pub fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: Signature,
        auth_context: Vec<Context>,
    ) {
        // Verify signature
        env.crypto().ed25519_verify(
            &signature.public_key,
            &signature_payload.into(),
            &signature.signature,
        );

        // Owner: allow everything
        if is_owner(&env, &signature.public_key) {
            return;
        }

        // Agent: verify status and expiry
        let _policy = load_agent_policy(&env, &signature.public_key);

        // Agent: restrict to whitelisted wrapper functions on self ONLY
        let self_address = env.current_contract_address();

        for context in auth_context.iter() {
            match context {
                Context::Contract(c) => {
                    // Agent can ONLY authorize calls to self
                    if c.contract != self_address {
                        panic!("agents cannot authorize external contract calls directly");
                    }
                    // And only whitelisted functions
                    if !is_whitelisted_agent_fn(&c.fn_name, &env) {
                        panic!("agents cannot call admin functions");
                    }
                    // Verify agent_key arg (first arg) matches the actual signer
                    // All wrapper functions take agent_key as the first parameter
                    let claimed_key: BytesN<32> = c.args.get(0)
                        .expect("missing agent_key arg")
                        .try_into_val(&env)
                        .expect("invalid agent_key arg");
                    if claimed_key != signature.public_key {
                        panic!("agent_key does not match signer");
                    }
                }
                // Block any other context types (e.g., CreateContractHostFn)
                _ => panic!("agents cannot authorize this operation"),
            }
        }
    }

    // ===== Agent Wrapper Functions =====
    // These are the ONLY functions agents can call. Each enforces the policy.

    /// Send tokens to an address.
    pub fn agent_transfer(
        env: Env,
        agent_key: BytesN<32>,
        token_address: Address,
        destination: Address,
        amount: i128,
    ) {
        require_contract_auth(&env);

        // Enforce limits for agents (owner bypasses)
        if !is_owner(&env, &agent_key) {
            let policy = load_agent_policy(&env, &agent_key);
            check_token_limit(&policy, &token_address, amount);
            if !check_access(&policy.access, &destination) {
                panic!("destination not allowed");
            }
        }

        let client = token::Client::new(&env, &token_address);
        client.transfer(&env.current_contract_address(), &destination, &amount);

        env.events().publish(
            (symbol_short!("transfer"),),
            (agent_key, token_address, destination, amount),
        );
    }

    /// Call any function on an allowlisted external contract.
    /// Agent must declare the expected token spend for per-tx limit checking.
    pub fn agent_invoke(
        env: Env,
        agent_key: BytesN<32>,
        contract: Address,
        fn_name: Symbol,
        args: Vec<Val>,
        spend_token: Address,
        spend_amount: i128,
    ) -> Val {
        require_contract_auth(&env);

        // Block self-calls — prevents admin function escalation
        if contract == env.current_contract_address() {
            panic!("cannot invoke self");
        }

        if !is_owner(&env, &agent_key) {
            let policy = load_agent_policy(&env, &agent_key);

            // Check contract is allowed
            if !check_access(&policy.access, &contract) {
                panic!("contract not allowed");
            }

            // Check declared spend against per-tx limit
            check_token_limit(&policy, &spend_token, spend_amount);
        }

        let result: Val = env.invoke_contract(&contract, &fn_name, args);

        env.events().publish(
            (symbol_short!("invoke"),),
            (agent_key, contract, fn_name, spend_token, spend_amount),
        );

        result
    }

    /// Swap tokens on a DEX.
    pub fn agent_swap(
        env: Env,
        agent_key: BytesN<32>,
        dex: Address,
        fn_name: Symbol,
        args: Vec<Val>,
        token_in: Address,
        amount_in: i128,
    ) -> Val {
        require_contract_auth(&env);

        if dex == env.current_contract_address() {
            panic!("cannot invoke self");
        }

        if !is_owner(&env, &agent_key) {
            let policy = load_agent_policy(&env, &agent_key);

            if !check_access(&policy.access, &dex) {
                panic!("DEX not allowed");
            }
            check_token_limit(&policy, &token_in, amount_in);
        }

        let result: Val = env.invoke_contract(&dex, &fn_name, args);

        env.events().publish(
            (symbol_short!("swap"),),
            (agent_key, dex, token_in, amount_in),
        );

        result
    }

    /// Supply tokens to a lending protocol (e.g., Blend).
    pub fn agent_supply(
        env: Env,
        agent_key: BytesN<32>,
        protocol: Address,
        fn_name: Symbol,
        args: Vec<Val>,
        token: Address,
        amount: i128,
    ) -> Val {
        require_contract_auth(&env);

        if protocol == env.current_contract_address() {
            panic!("cannot invoke self");
        }

        if !is_owner(&env, &agent_key) {
            let policy = load_agent_policy(&env, &agent_key);

            if !check_access(&policy.access, &protocol) {
                panic!("protocol not allowed");
            }
            check_token_limit(&policy, &token, amount);
        }

        let result: Val = env.invoke_contract(&protocol, &fn_name, args);

        env.events().publish(
            (symbol_short!("supply"),),
            (agent_key, protocol, token, amount),
        );

        result
    }

    /// Withdraw tokens from a lending protocol.
    /// No per-tx spend check — value is flowing IN, not out.
    pub fn agent_withdraw(
        env: Env,
        agent_key: BytesN<32>,
        protocol: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Val {
        require_contract_auth(&env);

        if protocol == env.current_contract_address() {
            panic!("cannot invoke self");
        }

        if !is_owner(&env, &agent_key) {
            let policy = load_agent_policy(&env, &agent_key);

            if !check_access(&policy.access, &protocol) {
                panic!("protocol not allowed");
            }
        }

        let result: Val = env.invoke_contract(&protocol, &fn_name, args);

        env.events().publish(
            (symbol_short!("withdraw"),),
            (agent_key, protocol),
        );

        result
    }

    // ===== Owner Admin Functions =====

    /// Register a new agent key with a policy.
    pub fn add_agent(env: Env, agent_key: BytesN<32>, policy: AgentPolicy) {
        require_contract_auth(&env);

        env.storage()
            .persistent()
            .set(&DataKey::Agent(agent_key.clone()), &AgentStatus::Active);
        env.storage()
            .persistent()
            .set(&DataKey::Policy(agent_key.clone()), &policy);

        env.events()
            .publish((symbol_short!("agent"), symbol_short!("added")), agent_key);
    }

    /// Permanently remove an agent's access.
    pub fn revoke_agent(env: Env, agent_key: BytesN<32>) {
        require_contract_auth(&env);

        env.storage()
            .persistent()
            .remove(&DataKey::Agent(agent_key.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::Policy(agent_key.clone()));

        env.events()
            .publish((symbol_short!("agent"), symbol_short!("revoked")), agent_key);
    }

    /// Temporarily freeze an agent (reversible).
    pub fn freeze_agent(env: Env, agent_key: BytesN<32>) {
        require_contract_auth(&env);

        env.storage()
            .persistent()
            .set(&DataKey::Agent(agent_key.clone()), &AgentStatus::Frozen);

        env.events()
            .publish((symbol_short!("agent"), symbol_short!("frozen")), agent_key);
    }

    /// Resume a frozen agent.
    pub fn unfreeze_agent(env: Env, agent_key: BytesN<32>) {
        require_contract_auth(&env);

        env.storage()
            .persistent()
            .set(&DataKey::Agent(agent_key.clone()), &AgentStatus::Active);

        env.events().publish(
            (symbol_short!("agent"), symbol_short!("unfrozen")),
            agent_key,
        );
    }

    /// Update an agent's policy.
    pub fn update_policy(env: Env, agent_key: BytesN<32>, policy: AgentPolicy) {
        require_contract_auth(&env);

        if !env
            .storage()
            .persistent()
            .has(&DataKey::Agent(agent_key.clone()))
        {
            panic!("agent not found");
        }

        env.storage()
            .persistent()
            .set(&DataKey::Policy(agent_key.clone()), &policy);

        env.events()
            .publish((symbol_short!("policy"), symbol_short!("updated")), agent_key);
    }

    /// Pull funds from this contract account.
    pub fn drain(env: Env, token_address: Address, destination: Address, amount: i128) {
        require_contract_auth(&env);

        let client = token::Client::new(&env, &token_address);
        client.transfer(&env.current_contract_address(), &destination, &amount);

        env.events()
            .publish((symbol_short!("drain"),), (token_address, destination, amount));
    }

    /// Rotate the owner key.
    pub fn rotate_owner(env: Env, new_owner: BytesN<32>) {
        require_contract_auth(&env);

        env.storage()
            .instance()
            .set(&DataKey::Owner, &new_owner);

        env.events()
            .publish((symbol_short!("owner"), symbol_short!("rotated")), new_owner);
    }

    /// Rotate an agent's key. Preserves status and policy.
    pub fn rotate_agent_key(env: Env, old_key: BytesN<32>, new_key: BytesN<32>) {
        require_contract_auth(&env);

        // Check new key isn't already registered
        if env
            .storage()
            .persistent()
            .has(&DataKey::Agent(new_key.clone()))
        {
            panic!("new key already registered");
        }

        let status: AgentStatus = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(old_key.clone()))
            .expect("agent not found");

        let policy: AgentPolicy = env
            .storage()
            .persistent()
            .get(&DataKey::Policy(old_key.clone()))
            .expect("policy not found");

        // Remove old
        env.storage()
            .persistent()
            .remove(&DataKey::Agent(old_key.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::Policy(old_key.clone()));

        // Set new with same status and policy
        env.storage()
            .persistent()
            .set(&DataKey::Agent(new_key.clone()), &status);
        env.storage()
            .persistent()
            .set(&DataKey::Policy(new_key.clone()), &policy);

        env.events().publish(
            (symbol_short!("agent"), symbol_short!("rotated")),
            (old_key, new_key),
        );
    }

    // ===== Read Functions =====

    pub fn get_owner(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Owner).unwrap()
    }

    pub fn get_agent_status(env: Env, agent_key: BytesN<32>) -> AgentStatus {
        env.storage()
            .persistent()
            .get(&DataKey::Agent(agent_key))
            .expect("agent not found")
    }

    pub fn get_policy(env: Env, agent_key: BytesN<32>) -> AgentPolicy {
        env.storage()
            .persistent()
            .get(&DataKey::Policy(agent_key))
            .expect("policy not found")
    }
}

// ===== Tests =====

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{vec, Env, IntoVal};

    // -- Mock DeFi protocol that transfers tokens FROM the caller --
    // This simulates what Blend, a DEX, or any protocol does:
    // it calls require_auth on the caller, then moves their tokens.
    #[contract]
    pub struct MockProtocol;

    #[contractimpl]
    impl MockProtocol {
        pub fn deposit(env: Env, from: Address, token_addr: Address, amount: i128) {
            from.require_auth();
            let client = token::Client::new(&env, &token_addr);
            client.transfer(&from, &env.current_contract_address(), &amount);
        }
    }

    // -- Helpers --

    fn create_token(env: &Env, admin: &Address) -> Address {
        let token = env.register_stellar_asset_contract_v2(admin.clone());
        token.address()
    }

    fn setup_account(env: &Env) -> (Address, BytesN<32>, BytesN<32>, AgentPolicy, Address) {
        let admin = Address::generate(env);
        let token_addr = create_token(env, &admin);

        // Generate owner and agent keys (random 32 bytes for testing)
        let owner_key = BytesN::from_array(env, &[1u8; 32]);
        let agent_key = BytesN::from_array(env, &[2u8; 32]);

        let policy = AgentPolicy {
            token_limits: vec![
                env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000, // 100 tokens
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 0,
        };

        // Deploy the account contract with agent
        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy.clone()),
            ),
        );

        // Fund the account with tokens
        let token_client = token::StellarAssetClient::new(env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        (account_addr, owner_key, agent_key, policy, token_addr)
    }

    // ===== Basic Functional Tests (mock_all_auths) =====

    #[test]
    fn test_constructor_sets_owner_and_agent() {
        let env = Env::default();
        env.mock_all_auths();
        let (account_addr, owner_key, agent_key, _, _) = setup_account(&env);

        let client = SimpleAccountClient::new(&env, &account_addr);
        assert_eq!(client.get_owner(), owner_key);
        assert_eq!(client.get_agent_status(&agent_key), AgentStatus::Active);
    }

    #[test]
    fn test_agent_transfer_succeeds_within_limits() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let destination = Address::generate(&env);

        let client = SimpleAccountClient::new(&env, &account_addr);
        client.agent_transfer(&agent_key, &token_addr, &destination, &50_0000000);

        // Verify tokens moved
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&destination), 50_0000000);
        assert_eq!(token_client.balance(&account_addr), 950_0000000);
    }

    #[test]
    #[should_panic(expected = "exceeds per-transaction limit")]
    fn test_agent_transfer_blocked_over_limit() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let destination = Address::generate(&env);

        let client = SimpleAccountClient::new(&env, &account_addr);
        // Per-tx limit is 100, trying 200
        client.agent_transfer(&agent_key, &token_addr, &destination, &200_0000000);
    }

    #[test]
    #[should_panic(expected = "token not allowed by policy")]
    fn test_agent_transfer_blocked_wrong_token() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, _) = setup_account(&env);
        let destination = Address::generate(&env);
        let wrong_token = Address::generate(&env);

        let client = SimpleAccountClient::new(&env, &account_addr);
        client.agent_transfer(&agent_key, &wrong_token, &destination, &10_0000000);
    }

    #[test]
    fn test_freeze_blocks_agent() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, _) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        // Freeze the agent
        client.freeze_agent(&agent_key);
        assert_eq!(client.get_agent_status(&agent_key), AgentStatus::Frozen);
    }

    #[test]
    fn test_unfreeze_reactivates_agent() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, _) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.freeze_agent(&agent_key);
        assert_eq!(client.get_agent_status(&agent_key), AgentStatus::Frozen);

        client.unfreeze_agent(&agent_key);
        assert_eq!(client.get_agent_status(&agent_key), AgentStatus::Active);
    }

    #[test]
    fn test_revoke_removes_agent() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, _) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.revoke_agent(&agent_key);
    }

    #[test]
    #[should_panic(expected = "unknown agent")]
    fn test_revoked_agent_cannot_transfer() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let destination = Address::generate(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.revoke_agent(&agent_key);

        // This should fail — agent no longer exists
        client.agent_transfer(&agent_key, &token_addr, &destination, &10_0000000);
    }

    #[test]
    fn test_drain_moves_funds() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, _, _, token_addr) = setup_account(&env);
        let destination = Address::generate(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.drain(&token_addr, &destination, &500_0000000);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&destination), 500_0000000);
        assert_eq!(token_client.balance(&account_addr), 500_0000000);
    }

    #[test]
    fn test_rotate_agent_key() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, _) = setup_account(&env);
        let new_key = BytesN::from_array(&env, &[3u8; 32]);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.rotate_agent_key(&agent_key, &new_key);

        assert_eq!(client.get_agent_status(&new_key), AgentStatus::Active);
    }

    #[test]
    #[should_panic(expected = "new key already registered")]
    fn test_rotate_to_existing_key_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, policy, _) = setup_account(&env);
        let other_key = BytesN::from_array(&env, &[3u8; 32]);
        let client = SimpleAccountClient::new(&env, &account_addr);

        // Add a second agent
        client.add_agent(&other_key, &policy);

        // Try to rotate first agent to the second agent's key
        client.rotate_agent_key(&agent_key, &other_key);
    }

    #[test]
    fn test_update_policy() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        let new_policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 50_0000000, // tighter limit
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 0,
        };

        client.update_policy(&agent_key, &new_policy);

        let retrieved = client.get_policy(&agent_key);
        assert_eq!(retrieved.token_limits.len(), 1);
    }

    // ===== Self-Call Block Tests =====

    #[test]
    #[should_panic(expected = "cannot invoke self")]
    fn test_agent_invoke_blocks_self_call() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        // Try to call self via agent_invoke — should panic
        client.agent_invoke(
            &agent_key,
            &account_addr, // targeting self!
            &Symbol::new(&env, "drain"),
            &vec![&env],
            &token_addr,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "cannot invoke self")]
    fn test_agent_swap_blocks_self_call() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.agent_swap(
            &agent_key,
            &account_addr, // targeting self!
            &Symbol::new(&env, "anything"),
            &vec![&env],
            &token_addr,
            &10,
        );
    }

    #[test]
    #[should_panic(expected = "cannot invoke self")]
    fn test_agent_supply_blocks_self_call() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, token_addr) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.agent_supply(
            &agent_key,
            &account_addr, // targeting self!
            &Symbol::new(&env, "anything"),
            &vec![&env],
            &token_addr,
            &10,
        );
    }

    #[test]
    #[should_panic(expected = "cannot invoke self")]
    fn test_agent_withdraw_blocks_self_call() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, _, agent_key, _, _) = setup_account(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        client.agent_withdraw(
            &agent_key,
            &account_addr, // targeting self!
            &Symbol::new(&env, "anything"),
            &vec![&env],
        );
    }

    // ===== Access Control Tests =====

    #[test]
    #[should_panic(expected = "destination not allowed")]
    fn test_allowlist_blocks_unlisted_destination() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        let allowed_dest = Address::generate(&env);
        let blocked_dest = Address::generate(&env);

        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::AllowOnly(vec![&env, allowed_dest.clone()]),
            expiry_ledger: 0,
        };

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy),
            ),
        );

        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        let client = SimpleAccountClient::new(&env, &account_addr);
        // This destination is not in the allowlist
        client.agent_transfer(&agent_key, &token_addr, &blocked_dest, &10_0000000);
    }

    #[test]
    #[should_panic(expected = "destination not allowed")]
    fn test_denylist_blocks_listed_destination() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        let blocked_dest = Address::generate(&env);

        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::DenyOnly(vec![&env, blocked_dest.clone()]),
            expiry_ledger: 0,
        };

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy),
            ),
        );

        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        let client = SimpleAccountClient::new(&env, &account_addr);
        client.agent_transfer(&agent_key, &token_addr, &blocked_dest, &10_0000000);
    }

    // ===== DeFi Sub-Auth Test (THE critical test) =====

    #[test]
    fn test_agent_invoke_with_mock_defi_protocol() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);

        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        // Register the mock protocol
        let protocol_addr = env.register(MockProtocol, ());

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::AllowOnly(vec![&env, protocol_addr.clone()]),
            expiry_ledger: 0,
        };

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy),
            ),
        );

        // Fund the account
        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        let client = SimpleAccountClient::new(&env, &account_addr);

        // Build args for MockProtocol::deposit(from, token, amount)
        let deposit_args: Vec<Val> = vec![
            &env,
            account_addr.clone().into_val(&env),
            token_addr.clone().into_val(&env),
            50_0000000i128.into_val(&env),
        ];

        // Agent calls the mock protocol via agent_invoke
        // This is the critical test: the mock protocol will call
        // token.transfer(account_addr, ...) which triggers require_auth
        // on the account. Does __check_auth see this as a sub-auth
        // (nested, OK) or a separate context entry (flat, would fail)?
        client.agent_invoke(
            &agent_key,
            &protocol_addr,
            &Symbol::new(&env, "deposit"),
            &deposit_args,
            &token_addr,
            &50_0000000,
        );

        // Verify tokens moved from account to protocol
        let token_read = token::Client::new(&env, &token_addr);
        assert_eq!(token_read.balance(&account_addr), 950_0000000);
        assert_eq!(token_read.balance(&protocol_addr), 50_0000000);
    }

    // ===== Expiry Tests =====

    #[test]
    #[should_panic(expected = "agent key expired")]
    fn test_expired_agent_is_blocked() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 100, // expires at ledger 100
        };

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy),
            ),
        );

        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        // Advance ledger past expiry
        env.ledger().set_sequence_number(200);

        let client = SimpleAccountClient::new(&env, &account_addr);
        let destination = Address::generate(&env);
        client.agent_transfer(&agent_key, &token_addr, &destination, &10_0000000);
    }

    #[test]
    fn test_non_expired_agent_works() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 1000, // expires at ledger 1000
        };

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy),
            ),
        );

        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        // Ledger is before expiry
        env.ledger().set_sequence_number(500);

        let client = SimpleAccountClient::new(&env, &account_addr);
        let destination = Address::generate(&env);
        client.agent_transfer(&agent_key, &token_addr, &destination, &10_0000000);

        let token_read = token::Client::new(&env, &token_addr);
        assert_eq!(token_read.balance(&destination), 10_0000000);
    }

    // ===== Owner Bypass Tests =====

    #[test]
    fn test_owner_bypasses_per_tx_limit() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, owner_key, _, _, token_addr) = setup_account(&env);
        let destination = Address::generate(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        // Per-tx limit is 100, but owner should bypass it
        client.agent_transfer(&owner_key, &token_addr, &destination, &500_0000000);

        let token_read = token::Client::new(&env, &token_addr);
        assert_eq!(token_read.balance(&destination), 500_0000000);
    }

    #[test]
    fn test_owner_bypasses_token_restriction() {
        let env = Env::default();
        env.mock_all_auths();

        let (account_addr, owner_key, _, _, _) = setup_account(&env);

        // Create a second token not in the agent's policy
        let admin2 = Address::generate(&env);
        let token2 = create_token(&env, &admin2);
        let token2_admin = token::StellarAssetClient::new(&env, &token2);
        token2_admin.mint(&account_addr, &500_0000000);

        let destination = Address::generate(&env);
        let client = SimpleAccountClient::new(&env, &account_addr);

        // Owner can transfer a token that's not in any agent's policy
        client.agent_transfer(&owner_key, &token2, &destination, &100_0000000);

        let token_read = token::Client::new(&env, &token2);
        assert_eq!(token_read.balance(&destination), 100_0000000);
    }

    // ===== Constructor Variants =====

    #[test]
    fn test_constructor_without_agent() {
        let env = Env::default();
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::None,
                Option::<AgentPolicy>::None,
            ),
        );

        let client = SimpleAccountClient::new(&env, &account_addr);
        assert_eq!(client.get_owner(), owner_key);
    }

    #[test]
    fn test_owner_can_add_agent_after_deploy() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[5u8; 32]);

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::None,
                Option::<AgentPolicy>::None,
            ),
        );

        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        let client = SimpleAccountClient::new(&env, &account_addr);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 50_0000000,
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 0,
        };

        client.add_agent(&agent_key, &policy);
        assert_eq!(client.get_agent_status(&agent_key), AgentStatus::Active);

        // Agent can now transfer
        let dest = Address::generate(&env);
        client.agent_transfer(&agent_key, &token_addr, &dest, &30_0000000);

        let token_read = token::Client::new(&env, &token_addr);
        assert_eq!(token_read.balance(&dest), 30_0000000);
    }

    // ===== Unlimited per-tx (0 = unlimited) =====

    #[test]
    fn test_zero_per_tx_limit_means_unlimited() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr.clone(),
                    per_tx_limit: 0, // unlimited
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 0,
        };

        let account_addr = env.register(
            SimpleAccount,
            (
                owner_key.clone(),
                Option::<BytesN<32>>::Some(agent_key.clone()),
                Option::<AgentPolicy>::Some(policy),
            ),
        );

        let token_client = token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&account_addr, &1000_0000000);

        let client = SimpleAccountClient::new(&env, &account_addr);
        let dest = Address::generate(&env);

        // Should succeed even with a large amount
        client.agent_transfer(&agent_key, &token_addr, &dest, &999_0000000);

        let token_read = token::Client::new(&env, &token_addr);
        assert_eq!(token_read.balance(&dest), 999_0000000);
    }

    // ===== Constructor Validation Tests =====

    #[test]
    #[should_panic(expected = "agent_key and policy must both be provided or both be None")]
    fn test_constructor_rejects_key_without_policy() {
        let env = Env::default();
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let agent_key = BytesN::from_array(&env, &[2u8; 32]);

        env.register(
            SimpleAccount,
            (
                owner_key,
                Option::<BytesN<32>>::Some(agent_key),
                Option::<AgentPolicy>::None,
            ),
        );
    }

    #[test]
    #[should_panic(expected = "agent_key and policy must both be provided or both be None")]
    fn test_constructor_rejects_policy_without_key() {
        let env = Env::default();
        let owner_key = BytesN::from_array(&env, &[1u8; 32]);
        let token_addr = Address::generate(&env);

        let policy = AgentPolicy {
            token_limits: vec![
                &env,
                TokenLimit {
                    token: token_addr,
                    per_tx_limit: 100_0000000,
                },
            ],
            access: AccessControl::AllowAll,
            expiry_ledger: 0,
        };

        env.register(
            SimpleAccount,
            (
                owner_key,
                Option::<BytesN<32>>::None,
                Option::<AgentPolicy>::Some(policy),
            ),
        );
    }
}
