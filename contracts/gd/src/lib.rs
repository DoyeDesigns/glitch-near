//! GD: Glitch's in-game currency. Standard NEP-141 plus role-gated mint and public burn.
//! Mint = faucet (skill pay, merchant seeding, prizes). Burn = sinks (fees, losses, rent).
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::IterableSet;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Metadata,
    Minters,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner: AccountId,
    minters: IterableSet<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Glitch Dollar".to_string(),
            symbol: "GD".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 0,
        };
        let mut minters = IterableSet::new(StorageKey::Minters);
        minters.insert(owner.clone());
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner,
            minters,
        }
    }

    pub fn add_minter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.minters.insert(account_id);
    }

    pub fn remove_minter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.minters.remove(&account_id);
    }

    pub fn is_minter(&self, account_id: AccountId) -> bool {
        self.minters.contains(&account_id)
    }

    /// Faucet. Only minters (server oracle, treasury). Auto-registers the receiver.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            self.minters.contains(&env::predecessor_account_id()),
            "Only minters can mint"
        );
        require!(amount.0 > 0, "Amount must be positive");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
    }

    /// Sink. Anyone can burn their own GD (fees, losses, rent are burned by the server on their behalf via a minter-signed call).
    pub fn burn(&mut self, amount: U128) {
        let account_id = env::predecessor_account_id();
        self.token.internal_withdraw(&account_id, amount.0);
    }

    /// Sink on behalf of a player. Only minters (server). Keeps the custodial-gasless flow simple.
    pub fn burn_from(&mut self, account_id: AccountId, amount: U128) {
        require!(
            self.minters.contains(&env::predecessor_account_id()),
            "Only minters can burn_from"
        );
        self.token.internal_withdraw(&account_id, amount.0);
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(pred: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred);
        b
    }

    #[test]
    fn mint_registers_and_burns() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0));
        c.mint(accounts(1), U128(1000));
        assert_eq!(c.ft_balance_of(accounts(1)).0, 1000);
        testing_env!(ctx(accounts(1)).build());
        c.burn(U128(400));
        assert_eq!(c.ft_balance_of(accounts(1)).0, 600);
        assert_eq!(c.ft_total_supply().0, 600);
    }

    #[test]
    #[should_panic(expected = "Only minters can mint")]
    fn non_minter_cannot_mint() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0));
        testing_env!(ctx(accounts(2)).build());
        c.mint(accounts(2), U128(1));
    }

    #[test]
    fn burn_from_by_minter() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0));
        c.mint(accounts(1), U128(500));
        c.burn_from(accounts(1), U128(200));
        assert_eq!(c.ft_balance_of(accounts(1)).0, 300);
        assert_eq!(c.ft_total_supply().0, 300);
    }
}
