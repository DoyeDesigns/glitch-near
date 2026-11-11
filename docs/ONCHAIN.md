# On-chain settlement map

Policy for every GD and item movement on NEAR testnet. The server paths in `server/src` implement this map. Where this file and the code disagree, the code is the source of truth.

Contracts: `GD_CONTRACT`, `ITEMS_CONTRACT`. Player keys are custodial (encrypted in SQLite); the server decrypts them to sign **player** txs. The treasury/oracle key signs **mint**, **burn_from**, **create_token**, forge item mint, and shard mint/burn. Merchant→merchant GD hops use each merchant’s key (`merchantFtTransfer`).

---

## Classes

| Code | Meaning |
| --- | --- |
| **(a)** | Immediate on-chain call when the action succeeds. |
| **(b)** | Accrued server-side; flushed lazily as `gd.burn_from` (treasury-signed). |
| **(c)** | Server-only — never touches the chain. |

**(a)** call kinds:

- **Player-signed:** `ft_transfer` (and any player-origin NEP-141) using the player’s decrypted key.
- **Treasury-signed:** `mint`, `burn_from`, `create_token`, forge item mint, shard mint/burn.
- **Merchant-signed:** `ft_transfer` between merchant wallets (restock supply chain + city trades).

---

## Available balance

```
available = chainBalance − pendingBurns − escrowed
```

| Term | Meaning |
| --- | --- |
| `chainBalance` | Live `ft_balance_of` (or short TTL cache) for the player’s GD |
| `pendingBurns` | Sum of accrued **(b)** sink liabilities not yet flushed |
| `escrowed` | GD held in open trade/post escrows (server ledger) |

**Rules**

- Every **spend**, **stake**, and **maintenance** payment must check `available` **before** accepting the action.
- `GET /me` returns `available` (and should expose `chainBalance`, `pendingBurns`, `escrowed` for debugging).
- Flush burns are **capped at the real chain balance** (`min(pendingBurns, chainBalance)`). Remainder stays pending (or is written down only under an explicit insolvency policy — default: keep pending).

---

## Persistence (SQLite)

| Table / store | Purpose |
| --- | --- |
| `pending_burns` | Accrued **(b)** GD sinks per player (`amount`, `reason`, `created_at`, …) |
| `escrow` | Open trade/post stakes per player |
| `outbox` | Ordered on-chain intents (player or treasury) awaiting send / confirm |
| `pending_delivery` | Pay-then-deliver rows after GD left the player but before item confirmed |
| `chain_failures` | Failed writes for reconcile (existing) |

**Flush triggers for pending burns**

1. Every **5 minutes** for any player with `pendingBurns > 0`
2. Process **shutdown**
3. Player **logout**
4. (Also) immediately before an **(a)** action that needs a clean available picture, if desired — not a substitute for the timers above

Flush = one treasury `burn_from(player, min(pending, chainBalance))`, then reduce `pending_burns` by the burned amount. Never retry non-idempotent writes (`ChainWriteError` → `chain_failures`).

---

## GD movements

### Faucet / prizes — treasury `mint` **(a)**

| Movement | Amount (ref) | Notes |
| --- | --- | --- |
| New player seed | `START_GD` 60,000 | After account `active` |
| Vault skill payout | 15k / 30k / 75k by hits | Validated result; daily cap / weak |
| Trade win (profit) | variable | Stake return is escrow release, not a mint |
| Post profit | variable | After validated post |
| Cycle / event prizes | event-defined | |

### Purchases — player `ft_transfer` → merchant **(a)**

Signed with the **player’s decrypted key**. Destination is the merchant account (`chef`, `dealer`, `smith`). **Not** a burn.

| Movement | To | Amount |
| --- | --- | --- |
| Food (eat) | `chef` | catalog `priceGD` |
| Furniture | `dealer` | catalog `priceGD` |
| Studio buy | `dealer` | `HOMEP_GD` 90,000 |
| Studio maintenance / first maintenance | `dealer` | `MAINTENANCE_GD` 1,000 |
| Forge GD leg | `smith` | `gdCost` |

Require `available >= amount` before signing.

### Burns — treasury `burn_from` for player sinks **(b)** (lazy)

Burns are **not** used for player purchases or merchant→merchant commerce.

| Movement | Class | Notes |
| --- | --- | --- |
| Trade entry fee (1%) | **(b)** | |
| Trade loss | **(b)** | |
| Post cost (burn half) | **(b)** | Escrow half separate |
| Player market fee (2%) | **(b)** | Accrued on seller when GD transfer lands |
| Fast travel gas | **(b)** | `GAS_GD` (200); `POST /travel` |
| Passive holding tax | **(b)** | `UPKEEP_RATE` / `UPKEEP_INTERVAL_S`; catch-up on `GET /me` |
| CIA fine (guilty) | **(b)** | `min(available, floor(loot * 1.25))` when player case resolves |

### Merchant → merchant — merchant-signed `ft_transfer` **(a)**

| Movement | Notes |
| --- | --- |
| Restock supply chain | When stock recovers: chef→dealer (ingredients), smith→dealer (parts), dealer→chef (canteen). See `MERCHANT_SUPPLY_CHAIN`. |
| City trades (triangle) | Ongoing staff meals / ingredients / parts / tools / repairs among all three (`MERCHANT_CITY_TRADES`). Each hop leaves `MERCHANT_MIN_BALANCE` on the payer when possible. Live tick ~10s; day sim is off-chain ledger only. |

### Escrow — server ledger **(b)**-adjacent

| Movement | Notes |
| --- | --- |
| Trade stake hold | Increases `escrowed`; reduces `available` |
| Post escrow half | Same |
| Player market buy | Buyer escrow while `listing_sales.status = paying` |
| Stake/escrow release on settle | Decreases `escrowed`; win may `mint` profit **(a)** |

### Server-only **(c)**

Daily cap bookkeeping, XP, needs (except food hunger apply after pay), social, market sim, look cosmetics, **poses** (client `localStorage`), home paint (client), key storage, prototype USDG (removed).

`GET /leaderboard` ranks by spendable `available` GD (15s cache) — read-only, no chain write.

---

## Item movements

| Movement | Class | Notes |
| --- | --- | --- |
| **Food** | **(a)** GD only | **Eaten instantly:** `ft_transfer` player → `chef`, then apply hunger **server-side**. **Mint no food token.** |
| Furniture buy | **(a)** | Pay-then-deliver: after GD transfer, mint furniture to player (see below). |
| Studio deed | **(a)** | Pay-then-deliver `studio-apartment` mint. |
| Shard earn (vault) | **(a)** | Treasury `mint` shards. |
| Shard spend (forge) | **(a)** | Treasury `burn_from` shards + player `ft_transfer` gdCost → smith + gear mint. |
| Gear forge | **(a)** | `create_token` `gear-<type>-<uuid>` (max 1) + `mint` to player. |
| Player market list | **(c)** hold | Open listing in SQLite; qty held = chain balance − open/sold-in-flight listings. Furniture or gear tokens only. Price 100–1,000,000 GD. |
| Player market buy | **(a)** | Buyer `ft_transfer` → seller; then treasury `admin_transfer` seller → buyer (existing minter method). Same paying/paid/delivered/failed + escrow + resume as shop purchases. 2% fee → seller `pending_burns`. |
| Merchant restock / city trades | **(a)** | Merchant-signed GD `ft_transfer` (see above); not item mint. |
| Catalog seed | ops **(a)** | `create_token` for non-gear types. |
| Headphones / placement | **(c)** | Free look / which owned item is placed. |

Food catalog rows remain for **pricing and effects** only; they are not seeded as holdable balances for the eat path.

---

## Pay-then-deliver + reconcile

For furniture, studio, forge gear (and any future deliverable):

1. Check `available`.
2. Flush burns if needed (cap at chain balance).
3. Player `ft_transfer` → merchant (outbox).
4. Insert **`pending_delivery`** `{ player, sku, amountPaid, merchant, status: paid }`.
5. Attempt deliver: treasury `mint` / `create_token`+`mint` / `admin_transfer` as appropriate.
6. On success: mark delivery `done`.
7. **Reconcile job** (periodic): for open `pending_delivery`, **view item balances** (or token existence). If already delivered, mark `done` and **do not re-mint**. If paid but missing after retries, last resort: **refund** via merchant → player `ft_transfer` (merchant/treasury-signed as designed), mark `refunded`, log `chain_failures` if refund fails.

Never mint first and charge later.

---

## Signup protection

Refuse or throttle `createPlayerAccount` / signup when:

| Control | Rule |
| --- | --- |
| Per-IP rate limit | Cap signups (and create attempts) per IP per window |
| Global new-account cap | Max new accounts **per hour** (env-tunable) |
| Optional `INVITE_CODE` | If set in env, require matching code on signup |
| Root NEAR balance | Refuse signups when **`players` / `ROOT_ACCOUNT` NEAR balance &lt; 0.2** (cannot fund subaccounts safely) |

Env knobs (see `server/.env.example`): `SIGNUP_IP_PER_HOUR` (default 5), `SIGNUP_HOURLY_CAP` (default 30), optional `INVITE_CODE`, funding check against `0.2` NEAR on `ROOT_ACCOUNT` when `CHAIN_MODE=testnet`.

---

## Settlement sketch

1. Validate action; compute `available`; reject if insufficient.
2. **(b)**-only → append `pending_burns` / adjust `escrow`; return.
3. **(a)** purchase / payout / logout / 5‑min / shutdown:
   - Flush `pending_burns` capped at chain balance.
   - Purchases: player `ft_transfer` → merchant; `pending_delivery` → deliver; reconcile later.
   - Food: `ft_transfer` → chef; hunger **(c)** update; no item mint.
   - Sinks already in pending: covered by flush.
   - Prizes: treasury `mint`.
4. `ChainWriteError` → `chain_failures` / outbox retry policy; do not advance dependent game state.
