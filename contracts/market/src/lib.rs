//! Glitch market: billboard ad slots (time-based queue with expiry) and event-triggered cycles.
//! Ads are paid in NEAR by advertisers (normal wallets) and forwarded to the treasury.
//! Cycles are recorded here; prizes are minted in GD by the game server.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

const ATTENTION_MIN_BPS: u32 = 5_000; // 0.5x
const ATTENTION_MAX_BPS: u32 = 25_000; // 2.5x
const ATTENTION_MIN_INTERVAL_NS: u64 = 10_000_000_000; // 10 s
const MAX_EXTENSIONS: u8 = 3;
const MAX_WINNERS: usize = 20;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Operators,
    Slots,
    Records,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Booking {
    pub advertiser: AccountId,
    pub project_name: String,
    pub creative_url: String,
    pub start_ns: U64,
    pub end_ns: U64,
    pub paid: U128,
}

#[near(serializers = [json])]
pub struct SlotAd {
    pub slot_id: u8,
    pub ad: Option<Booking>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub treasury: AccountId,
    pub unit_ms: U64,
    pub max_units: u32,
    pub max_horizon_units: u32,
    pub base_price: U128,
    pub slot_count: u8,
    pub attention_bps: u32,
    pub cycle_cooldown_ms: U64,
    pub cycle_max_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Cycle {
    pub id: U64,
    pub trigger: String,
    pub severity_bps: u32,
    pub ruleset_hash: String,
    pub prize_pool: U128,
    pub opened_ns: U64,
    pub closes_by_ns: U64,
    pub hard_cap_ns: U64,
    pub extensions: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Winner {
    pub category: String,
    pub account_id: AccountId,
    pub score_bps: i64,
    pub prize: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CycleRecord {
    pub id: U64,
    pub trigger: String,
    pub severity_bps: u32,
    pub ruleset_hash: String,
    pub prize_pool: U128,
    pub opened_ns: U64,
    pub closed_ns: U64,
    pub winners: Vec<Winner>,
    pub forced: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    treasury: AccountId,
    operators: IterableSet<AccountId>,
    // ads
    slot_count: u8,
    slots: LookupMap<u8, Vec<Booking>>,
    unit_ns: u64,
    max_units: u32,
    max_horizon_units: u32,
    base_price: u128,
    attention_bps: u32,
    last_attention_ns: u64,
    // cycles
    cycle_cooldown_ns: u64,
    cycle_max_ns: u64,
    last_close_ns: u64,
    current_cycle: Option<Cycle>,
    cycle_count: u64,
    records: Vector<CycleRecord>,
}

fn log_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"glitch","version":"1.0.0","event":event,"data":data})
    ));
}

#[near]
impl Contract {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        treasury: AccountId,
        unit_ms: u64,
        max_units: u32,
        max_horizon_units: u32,
        base_price_yocto: U128,
        slot_count: u8,
        cycle_cooldown_ms: u64,
        cycle_max_ms: u64,
    ) -> Self {
        require!(unit_ms > 0 && max_units > 0 && max_horizon_units >= max_units, "Bad ad config");
        require!(base_price_yocto.0 > 0 && slot_count > 0, "Bad price or slot count");
        require!(cycle_max_ms > 0, "Bad cycle config");
        let mut operators = IterableSet::new(StorageKey::Operators);
        operators.insert(owner.clone());
        Self {
            owner,
            treasury,
            operators,
            slot_count,
            slots: LookupMap::new(StorageKey::Slots),
            unit_ns: unit_ms * 1_000_000,
            max_units,
            max_horizon_units,
            base_price: base_price_yocto.0,
            attention_bps: 10_000,
            last_attention_ns: 0,
            cycle_cooldown_ns: cycle_cooldown_ms * 1_000_000,
            cycle_max_ns: cycle_max_ms * 1_000_000,
            last_close_ns: 0,
            current_cycle: None,
            cycle_count: 0,
            records: Vector::new(StorageKey::Records),
        }
    }

    // ---------- admin ----------
    pub fn add_operator(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.operators.insert(account_id);
    }
    pub fn remove_operator(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.operators.remove(&account_id);
    }
    pub fn is_operator(&self, account_id: AccountId) -> bool {
        self.operators.contains(&account_id)
    }
    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.assert_owner();
        self.treasury = treasury;
    }
    pub fn set_base_price(&mut self, base_price_yocto: U128) {
        self.assert_owner();
        require!(base_price_yocto.0 > 0, "Bad price");
        self.base_price = base_price_yocto.0;
    }

    // ---------- ads ----------
    /// Book consecutive time units on a slot. Starts when the slot is free (queue), runs for `units`.
    #[payable]
    pub fn book_ad(
        &mut self,
        slot_id: u8,
        units: u32,
        creative_url: String,
        project_name: String,
    ) -> Booking {
        require!(slot_id < self.slot_count, "Unknown slot");
        require!(units >= 1 && units <= self.max_units, "Units out of range");
        require!(
            creative_url.starts_with("https://") && creative_url.len() <= 300,
            "Creative must be an https URL (max 300 chars)"
        );
        let name = project_name.trim().to_string();
        require!(!name.is_empty() && name.len() <= 40, "Project name must be 1 to 40 chars");

        let now = env::block_timestamp();
        let mut q: Vec<Booking> = self.slots.get(&slot_id).cloned().unwrap_or_default();
        q.retain(|b| b.end_ns.0 > now);

        let start = q.last().map(|b| b.end_ns.0).unwrap_or(now).max(now);
        let end = start + units as u64 * self.unit_ns;
        require!(
            end - now <= self.max_horizon_units as u64 * self.unit_ns,
            "Beyond the booking horizon"
        );

        let price = self.quote(&q, now, units);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= price, "Attached deposit is below the price");

        let booking = Booking {
            advertiser: env::predecessor_account_id(),
            project_name: name,
            creative_url,
            start_ns: U64(start),
            end_ns: U64(end),
            paid: U128(price),
        };
        q.push(booking.clone());
        self.slots.insert(slot_id, q);

        Promise::new(self.treasury.clone())
            .transfer(NearToken::from_yoctonear(price))
            .detach();
        if deposit > price {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(deposit - price))
                .detach();
        }
        log_event("ad_booked", json!({
            "slot_id": slot_id, "advertiser": booking.advertiser, "project": booking.project_name,
            "start_ns": start.to_string(), "end_ns": end.to_string(), "paid": price.to_string()
        }));
        booking
    }

    /// Oracle posts the city-wide attention multiplier (10000 = 1.0x). Bounded and rate limited.
    pub fn set_attention(&mut self, bps: u32) {
        self.assert_operator();
        require!(
            (ATTENTION_MIN_BPS..=ATTENTION_MAX_BPS).contains(&bps),
            "Attention multiplier out of range"
        );
        let now = env::block_timestamp();
        require!(
            now >= self.last_attention_ns + ATTENTION_MIN_INTERVAL_NS,
            "Attention updated too recently"
        );
        self.attention_bps = bps;
        self.last_attention_ns = now;
        log_event("attention_set", json!({"bps": bps}));
    }

    /// Hide a booking's content (moderation). No refund; terms must say so.
    pub fn moderate_remove(&mut self, slot_id: u8, advertiser: AccountId) {
        self.assert_operator();
        let now = env::block_timestamp();
        let mut q: Vec<Booking> = self.slots.get(&slot_id).cloned().unwrap_or_default();
        q.retain(|b| b.end_ns.0 > now);
        for b in q.iter_mut().filter(|b| b.advertiser == advertiser) {
            b.creative_url = String::new();
            b.project_name = "[removed]".to_string();
        }
        self.slots.insert(slot_id, q);
        log_event("ad_moderated", json!({"slot_id": slot_id, "advertiser": advertiser}));
    }

    // ---------- ad views ----------
    pub fn get_current_ad(&self, slot_id: u8) -> Option<Booking> {
        let now = env::block_timestamp();
        self.slots
            .get(&slot_id)
            .and_then(|q| q.iter().find(|b| b.start_ns.0 <= now && now < b.end_ns.0).cloned())
    }

    pub fn get_all_current(&self) -> Vec<SlotAd> {
        (0..self.slot_count)
            .map(|s| SlotAd { slot_id: s, ad: self.get_current_ad(s) })
            .collect()
    }

    pub fn get_queue(&self, slot_id: u8) -> Vec<Booking> {
        let now = env::block_timestamp();
        self.slots
            .get(&slot_id)
            .map(|q| q.iter().filter(|b| b.end_ns.0 > now).cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_price(&self, slot_id: u8, units: u32) -> U128 {
        require!(slot_id < self.slot_count, "Unknown slot");
        let now = env::block_timestamp();
        let q = self.get_queue(slot_id);
        U128(self.quote(&q, now, units))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            treasury: self.treasury.clone(),
            unit_ms: U64(self.unit_ns / 1_000_000),
            max_units: self.max_units,
            max_horizon_units: self.max_horizon_units,
            base_price: U128(self.base_price),
            slot_count: self.slot_count,
            attention_bps: self.attention_bps,
            cycle_cooldown_ms: U64(self.cycle_cooldown_ns / 1_000_000),
            cycle_max_ms: U64(self.cycle_max_ns / 1_000_000),
        }
    }

    // ---------- cycles ----------
    pub fn open_cycle(
        &mut self,
        trigger: String,
        severity_bps: u32,
        ruleset_hash: String,
        prize_pool: U128,
    ) -> Cycle {
        self.assert_operator();
        require!(self.current_cycle.is_none(), "A cycle is already open");
        require!(severity_bps <= 10_000, "Severity out of range");
        let now = env::block_timestamp();
        require!(
            self.last_close_ns == 0 || now >= self.last_close_ns + self.cycle_cooldown_ns,
            "Cooldown has not passed"
        );
        self.cycle_count += 1;
        let c = Cycle {
            id: U64(self.cycle_count),
            trigger,
            severity_bps,
            ruleset_hash,
            prize_pool,
            opened_ns: U64(now),
            closes_by_ns: U64(now + self.cycle_max_ns),
            hard_cap_ns: U64(now + 2 * self.cycle_max_ns),
            extensions: 0,
        };
        self.current_cycle = Some(c.clone());
        log_event("cycle_opened", json!({"id": c.id.0.to_string(), "trigger": c.trigger, "severity_bps": c.severity_bps}));
        c
    }

    /// A major aftershock during an open cycle extends it, bounded by the hard cap.
    pub fn extend_cycle(&mut self, reason: String) -> Cycle {
        self.assert_operator();
        let half = self.cycle_max_ns / 2;
        let c = self.current_cycle.as_mut().unwrap_or_else(|| env::panic_str("No open cycle"));
        require!(c.extensions < MAX_EXTENSIONS, "Extension limit reached");
        c.closes_by_ns = U64((c.closes_by_ns.0 + half).min(c.hard_cap_ns.0));
        c.extensions += 1;
        let out = c.clone();
        log_event("cycle_extended", json!({"id": out.id.0.to_string(), "reason": reason}));
        out
    }

    pub fn close_cycle(&mut self, winners: Vec<Winner>) -> CycleRecord {
        self.assert_operator();
        let c = self.current_cycle.clone().unwrap_or_else(|| env::panic_str("No open cycle"));
        require!(winners.len() <= MAX_WINNERS, "Too many winners");
        let total = winners.iter().try_fold(0u128, |a, w| a.checked_add(w.prize.0));
        require!(total.is_some() && total.unwrap() <= c.prize_pool.0, "Prizes exceed the pool");
        self.finish_cycle(c, winners, false)
    }

    /// Safety valve: anyone can close a cycle that has passed its deadline, with no winners.
    pub fn force_close_expired(&mut self) -> CycleRecord {
        let c = self.current_cycle.clone().unwrap_or_else(|| env::panic_str("No open cycle"));
        require!(env::block_timestamp() > c.closes_by_ns.0, "Cycle has not expired");
        self.finish_cycle(c, vec![], true)
    }

    pub fn get_cycle(&self) -> Option<Cycle> {
        self.current_cycle.clone()
    }

    pub fn get_cycle_record(&self, id: U64) -> Option<CycleRecord> {
        self.records.iter().find(|r| r.id.0 == id.0).cloned()
    }

    pub fn get_cycle_history(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<CycleRecord> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(20) as usize;
        self.records.iter().skip(from).take(limit).cloned().collect()
    }
}

impl Contract {
    fn quote(&self, q: &[Booking], now: u64, units: u32) -> u128 {
        let ahead_ns = q.last().map(|b| b.end_ns.0.saturating_sub(now)).unwrap_or(0);
        let ahead_units = ahead_ns.div_ceil(self.unit_ns) as u128;
        let occ_bps = (ahead_units * 10_000 / self.max_horizon_units as u128).min(10_000);
        let per_unit =
            self.base_price * (10_000 + occ_bps) / 10_000 * self.attention_bps as u128 / 10_000;
        per_unit * units as u128
    }

    fn finish_cycle(&mut self, c: Cycle, winners: Vec<Winner>, forced: bool) -> CycleRecord {
        let now = env::block_timestamp();
        let rec = CycleRecord {
            id: c.id,
            trigger: c.trigger,
            severity_bps: c.severity_bps,
            ruleset_hash: c.ruleset_hash,
            prize_pool: c.prize_pool,
            opened_ns: c.opened_ns,
            closed_ns: U64(now),
            winners,
            forced,
        };
        self.records.push(rec.clone());
        self.current_cycle = None;
        self.last_close_ns = now;
        log_event("cycle_closed", json!({"id": rec.id.0.to_string(), "winners": rec.winners.len(), "forced": forced}));
        rec
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }
    fn assert_operator(&self) {
        require!(self.operators.contains(&env::predecessor_account_id()), "Operator only");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const UNIT_MS: u64 = 300_000; // 5 minutes
    const UNIT_NS: u64 = UNIT_MS * 1_000_000;
    const PRICE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR per unit

    fn ctx(pred: AccountId, ts_ns: u64, deposit: u128) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred)
            .block_timestamp(ts_ns)
            .attached_deposit(NearToken::from_yoctonear(deposit));
        b
    }

    fn setup() -> Contract {
        testing_env!(ctx(accounts(0), 1_000, 0).build());
        Contract::new(accounts(0), accounts(5), UNIT_MS, 12, 24, U128(PRICE), 5, 600_000, 1_200_000)
    }

    fn book(c: &mut Contract, who: usize, ts: u64, units: u32, dep: u128) -> Booking {
        testing_env!(ctx(accounts(who), ts, dep).build());
        c.book_ad(0, units, "https://x.test/a.png".into(), "Proj".into())
    }

    #[test]
    fn first_booking_starts_now_and_second_queues() {
        let mut c = setup();
        let a = book(&mut c, 1, 1_000, 2, 2 * PRICE);
        assert_eq!(a.start_ns.0, 1_000);
        assert_eq!(a.end_ns.0, 1_000 + 2 * UNIT_NS);
        // second buyer: price rises (2 of 24 units ahead), starts when the first ends
        let p = c.get_price(0, 1).0;
        assert!(p > PRICE);
        let b = book(&mut c, 2, 1_000, 3, 10 * PRICE);
        assert_eq!(b.start_ns.0, a.end_ns.0);
        assert_eq!(b.end_ns.0, a.end_ns.0 + 3 * UNIT_NS);
        assert_eq!(c.get_queue(0).len(), 2);
    }

    #[test]
    fn payment_and_refund_receipts_are_really_created() {
        let mut c = setup();
        // pay 3 NEAR for a 1 NEAR booking: expect a transfer to the treasury and a refund
        book(&mut c, 1, 1_000, 1, 3 * PRICE);
        let receipts = near_sdk::test_utils::get_created_receipts();
        let to_treasury = receipts.iter().filter(|r| r.receiver_id == accounts(5)).count();
        let to_buyer = receipts.iter().filter(|r| r.receiver_id == accounts(1)).count();
        assert_eq!(to_treasury, 1, "treasury transfer was not scheduled");
        assert_eq!(to_buyer, 1, "refund was not scheduled");
    }

    #[test]
    fn current_ad_rotates_and_expires() {
        let mut c = setup();
        let a = book(&mut c, 1, 1_000, 1, PRICE);
        let _b = book(&mut c, 2, 1_000, 1, 5 * PRICE);
        testing_env!(ctx(accounts(0), 2_000, 0).build());
        assert_eq!(c.get_current_ad(0).unwrap().advertiser, accounts(1));
        testing_env!(ctx(accounts(0), a.end_ns.0 + 1, 0).build());
        assert_eq!(c.get_current_ad(0).unwrap().advertiser, accounts(2));
        testing_env!(ctx(accounts(0), a.end_ns.0 + UNIT_NS + 5, 0).build());
        assert!(c.get_current_ad(0).is_none());
        assert_eq!(c.get_queue(0).len(), 0);
    }

    #[test]
    #[should_panic(expected = "below the price")]
    fn underpay_rejected() {
        let mut c = setup();
        book(&mut c, 1, 1_000, 2, PRICE);
    }

    #[test]
    #[should_panic(expected = "Beyond the booking horizon")]
    fn horizon_enforced() {
        let mut c = setup();
        book(&mut c, 1, 1_000, 12, 100 * PRICE);
        book(&mut c, 2, 1_000, 12, 100 * PRICE);
        book(&mut c, 3, 1_000, 1, 100 * PRICE);
    }

    #[test]
    fn attention_scales_price_within_bounds() {
        let mut c = setup();
        testing_env!(ctx(accounts(0), 20_000_000_000, 0).build());
        c.set_attention(20_000);
        assert_eq!(c.get_price(0, 1).0, 2 * PRICE);
    }

    #[test]
    #[should_panic(expected = "out of range")]
    fn attention_out_of_range_rejected() {
        let mut c = setup();
        testing_env!(ctx(accounts(0), 20_000_000_000, 0).build());
        c.set_attention(40_000);
    }

    #[test]
    #[should_panic(expected = "Operator only")]
    fn attention_operator_only() {
        let mut c = setup();
        testing_env!(ctx(accounts(3), 20_000_000_000, 0).build());
        c.set_attention(10_000);
    }

    #[test]
    fn cycle_lifecycle_with_cooldown() {
        let mut c = setup();
        testing_env!(ctx(accounts(0), 10_000, 0).build());
        let cy = c.open_cycle("MOON rug".into(), 8_000, "hash".into(), U128(1_000));
        assert_eq!(cy.id.0, 1);
        assert!(c.get_cycle().is_some());
        let w = vec![Winner { category: "bestReturn".into(), account_id: accounts(1), score_bps: 2_500, prize: U128(600) }];
        let rec = c.close_cycle(w);
        assert_eq!(rec.winners.len(), 1);
        assert!(c.get_cycle().is_none());
        assert_eq!(c.get_cycle_history(None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Cooldown has not passed")]
    fn cooldown_blocks_reopen() {
        let mut c = setup();
        testing_env!(ctx(accounts(0), 10_000, 0).build());
        c.open_cycle("a".into(), 5_000, "h".into(), U128(10));
        c.close_cycle(vec![]);
        c.open_cycle("b".into(), 5_000, "h".into(), U128(10));
    }

    #[test]
    #[should_panic(expected = "Prizes exceed the pool")]
    fn prizes_capped_by_pool() {
        let mut c = setup();
        testing_env!(ctx(accounts(0), 10_000, 0).build());
        c.open_cycle("a".into(), 5_000, "h".into(), U128(100));
        c.close_cycle(vec![Winner { category: "x".into(), account_id: accounts(1), score_bps: 1, prize: U128(101) }]);
    }

    #[test]
    fn extension_is_bounded_and_force_close_works() {
        let mut c = setup();
        testing_env!(ctx(accounts(0), 10_000, 0).build());
        let cy = c.open_cycle("a".into(), 5_000, "h".into(), U128(10));
        let e1 = c.extend_cycle("aftershock".into());
        assert!(e1.closes_by_ns.0 > cy.closes_by_ns.0);
        c.extend_cycle("again".into());
        let e3 = c.extend_cycle("again".into());
        assert!(e3.closes_by_ns.0 <= cy.hard_cap_ns.0);
        testing_env!(ctx(accounts(4), e3.closes_by_ns.0 + 1, 0).build());
        let rec = c.force_close_expired();
        assert!(rec.forced && rec.winners.is_empty());
    }
}
