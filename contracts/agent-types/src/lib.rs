//! Shared types for the Lumenitos agent wallet system.
//!
//! Used by both simple_account and account_factory to ensure
//! XDR-compatible type serialization across contracts.
#![no_std]

use soroban_sdk::{contracttype, Address, Vec};

/// Per-token spending limit.
#[derive(Clone)]
#[contracttype]
pub struct TokenLimit {
    pub token: Address,
    pub per_tx_limit: i128, // max per transaction, 0 = unlimited
}

/// Controls which contracts an agent can interact with.
#[derive(Clone, PartialEq)]
#[contracttype]
pub enum AccessControl {
    AllowAll,
    AllowOnly(Vec<Address>),
    DenyOnly(Vec<Address>),
}

/// Agent policy. Controls what an agent can do.
/// Tokens not in `token_limits` are blocked entirely.
#[derive(Clone)]
#[contracttype]
pub struct AgentPolicy {
    pub token_limits: Vec<TokenLimit>,
    pub access: AccessControl,
    pub expiry_ledger: u32, // 0 = no expiry
}

/// Token + amount pair for funding.
#[derive(Clone)]
#[contracttype]
pub struct TokenAmount {
    pub token: Address,
    pub amount: i128,
}
