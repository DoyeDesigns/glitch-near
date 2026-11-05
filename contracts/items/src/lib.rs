//! Glitch items: a small NEP-245 (multi-token) subset. One contract holds every item type:
//! gear (supply 1 each), furniture, shards, food. Minting and admin moves are minter-only
//! (the game server). Players' items are plain balances; the contract pays their storage.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, PanicOnDefault,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Minters,
    Tokens,
    Balances,
}

#[near(serializers = [borsh])]
pub struct TokenInfo {
    pub kind: String,
    pub title: String,
    pub max_supply: Option<u128>,
    pub supply: u128,
}

#[near(serializers = [json])]
pub struct TokenView {
    pub token_id: String,
    pub kind: String,
    pub title: String,
    pub supply: U128,
    pub max_supply: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    minters: IterableSet<AccountId>,
    tokens: IterableMap<String, TokenInfo>,
    balances: LookupMap<String, u128>,
}

fn bal_key(account: &AccountId, token_id: &str) -> String {
    format!("{}|{}", account, token_id)
}

fn log_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"nep245","version":"1.0.0","event":event,"data":[data]})
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        let mut minters = IterableSet::new(StorageKey::Minters);
        minters.insert(owner.clone());
        Self {
            owner,
            minters,
            tokens: IterableMap::new(StorageKey::Tokens),
            balances: LookupMap::new(StorageKey::Balances),
        }
    }

    // ---------- admin ----------
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

    /// Define an item type. kind is free text: "gear", "furniture", "shard", "food".
    pub fn create_token(
        &mut self,
        token_id: String,
        kind: String,
        title: String,
        max_supply: Option<U128>,
    ) {
        self.assert_minter();
        require!(!token_id.is_empty() && !token_id.contains('|'), "Bad token_id");
        require!(!self.tokens.contains_key(&token_id), "Token already exists");
        self.tokens.insert(
            token_id,
            TokenInfo { kind, title, max_supply: max_supply.map(|v| v.0), supply: 0 },
        );
    }

    pub fn mint(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        self.assert_minter();
        require!(amount.0 > 0, "Amount must be positive");
        let info = self.tokens.get_mut(&token_id).unwrap_or_else(|| env::panic_str("Unknown token"));
        let new_supply = info.supply.checked_add(amount.0).unwrap_or_else(|| env::panic_str("Overflow"));
        if let Some(max) = info.max_supply {
            require!(new_supply <= max, "Exceeds max supply");
        }
        info.supply = new_supply;
        let b = self.balance(&account_id, &token_id);
        self.set_balance(&account_id, &token_id, b + amount.0);
        log_event("mt_mint", json!({"owner_id": account_id, "token_ids":[token_id], "amounts":[amount.0.to_string()]}));
    }

    /// Consume items (eat food, spend shards). Server only.
    pub fn burn_from(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        self.assert_minter();
        require!(amount.0 > 0, "Amount must be positive");
        let b = self.balance(&account_id, &token_id);
        require!(b >= amount.0, "Not enough balance");
        self.set_balance(&account_id, &token_id, b - amount.0);
        let info = self.tokens.get_mut(&token_id).unwrap_or_else(|| env::panic_str("Unknown token"));
        info.supply -= amount.0;
        log_event("mt_burn", json!({"owner_id": account_id, "token_ids":[token_id], "amounts":[amount.0.to_string()]}));
    }

    /// Server-signed move between any two accounts (merchant <-> player). Custodial game model.
    pub fn admin_transfer(&mut self, from: AccountId, to: AccountId, token_id: String, amount: U128) {
        self.assert_minter();
        self.internal_transfer(&from, &to, &token_id, amount.0);
        log_event("mt_transfer", json!({"old_owner_id": from, "new_owner_id": to, "token_ids":[token_id], "amounts":[amount.0.to_string()]}));
    }

    // ---------- NEP-245 core subset ----------
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval.is_none(), "Approvals not supported");
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, &token_id, amount.0);
        if let Some(m) = memo { env::log_str(&format!("memo: {}", m)); }
        log_event("mt_transfer", json!({"old_owner_id": sender, "new_owner_id": receiver_id, "token_ids":[token_id], "amounts":[amount.0.to_string()]}));
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approvals.is_none(), "Approvals not supported");
        require!(token_ids.len() == amounts.len() && !token_ids.is_empty(), "Length mismatch");
        let sender = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(amounts.iter()) {
            self.internal_transfer(&sender, &receiver_id, t, a.0);
        }
        if let Some(m) = memo { env::log_str(&format!("memo: {}", m)); }
        let amts: Vec<String> = amounts.iter().map(|a| a.0.to_string()).collect();
        log_event("mt_transfer", json!({"old_owner_id": sender, "new_owner_id": receiver_id, "token_ids": token_ids, "amounts": amts}));
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance(&account_id, t))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.tokens.get(&token_id).map(|i| U128(i.supply))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.iter().map(|t| self.mt_supply(t.clone())).collect()
    }

    // ---------- catalog views ----------
    pub fn get_token(&self, token_id: String) -> Option<TokenView> {
        self.tokens.get(&token_id).map(|i| Self::view(&token_id, i))
    }

    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<TokenView> {
        let from = from_index.map(|v| v.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50) as usize;
        self.tokens.iter().skip(from).take(limit).map(|(k, i)| Self::view(k, i)).collect()
    }
}

impl Contract {
    fn view(token_id: &str, i: &TokenInfo) -> TokenView {
        TokenView {
            token_id: token_id.to_string(),
            kind: i.kind.clone(),
            title: i.title.clone(),
            supply: U128(i.supply),
            max_supply: i.max_supply.map(U128),
        }
    }
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }
    fn assert_minter(&self) {
        require!(self.minters.contains(&env::predecessor_account_id()), "Minter only");
    }
    fn balance(&self, account: &AccountId, token_id: &str) -> u128 {
        self.balances.get(&bal_key(account, token_id)).copied().unwrap_or(0)
    }
    fn set_balance(&mut self, account: &AccountId, token_id: &str, v: u128) {
        let k = bal_key(account, token_id);
        if v == 0 { self.balances.remove(&k); } else { self.balances.insert(k, v); }
    }
    fn internal_transfer(&mut self, from: &AccountId, to: &AccountId, token_id: &str, amount: u128) {
        require!(amount > 0, "Amount must be positive");
        require!(from != to, "Sender and receiver must differ");
        require!(self.tokens.contains_key(token_id), "Unknown token");
        let fb = self.balance(from, token_id);
        require!(fb >= amount, "Not enough balance");
        let tb = self.balance(to, token_id);
        self.set_balance(from, token_id, fb - amount);
        self.set_balance(to, token_id, tb + amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn ctx(pred: AccountId, one_yocto: bool) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred);
        if one_yocto { b.attached_deposit(NearToken::from_yoctonear(1)); }
        b
    }

    fn setup() -> Contract {
        testing_env!(ctx(accounts(0), false).build());
        let mut c = Contract::new(accounts(0));
        c.create_token("shard".into(), "shard".into(), "Shard".into(), None);
        c.create_token("crown".into(), "gear".into(), "Crown".into(), Some(U128(1)));
        c
    }

    #[test]
    fn mint_transfer_burn() {
        let mut c = setup();
        c.mint(accounts(1), "shard".into(), U128(10));
        assert_eq!(c.mt_balance_of(accounts(1), "shard".into()).0, 10);
        testing_env!(ctx(accounts(1), true).build());
        c.mt_transfer(accounts(2), "shard".into(), U128(4), None, None);
        assert_eq!(c.mt_balance_of(accounts(2), "shard".into()).0, 4);
        assert_eq!(c.mt_balance_of(accounts(1), "shard".into()).0, 6);
        testing_env!(ctx(accounts(0), false).build());
        c.burn_from(accounts(2), "shard".into(), U128(4));
        assert_eq!(c.mt_supply("shard".into()).unwrap().0, 6);
    }

    #[test]
    #[should_panic(expected = "Exceeds max supply")]
    fn gear_max_supply_enforced() {
        let mut c = setup();
        c.mint(accounts(1), "crown".into(), U128(1));
        c.mint(accounts(2), "crown".into(), U128(1));
    }

    #[test]
    #[should_panic(expected = "Minter only")]
    fn non_minter_cannot_mint() {
        let mut c = setup();
        testing_env!(ctx(accounts(3), false).build());
        c.mint(accounts(3), "shard".into(), U128(1));
    }

    #[test]
    #[should_panic(expected = "Not enough balance")]
    fn cannot_overspend() {
        let mut c = setup();
        c.mint(accounts(1), "shard".into(), U128(1));
        testing_env!(ctx(accounts(1), true).build());
        c.mt_transfer(accounts(2), "shard".into(), U128(2), None, None);
    }

    #[test]
    fn admin_transfer_and_batch_views() {
        let mut c = setup();
        c.mint(accounts(1), "shard".into(), U128(5));
        c.admin_transfer(accounts(1), accounts(2), "shard".into(), U128(3));
        let b = c.mt_batch_balance_of(accounts(2), vec!["shard".into(), "crown".into()]);
        assert_eq!(b[0].0, 3);
        assert_eq!(b[1].0, 0);
        assert_eq!(c.mt_tokens(None, None).len(), 2);
    }
}
