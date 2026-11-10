# On-chain settlement map

Policy for every GD and item movement on NEAR testnet. **Doc only — no implementation yet.**

Contracts: `GD_CONTRACT`, `ITEMS_CONTRACT`. Player keys are custodial (encrypted in SQLite); the server decrypts them to sign **player** txs. The treasury/oracle key signs **mint**, **burn_from**, **create_token**, and merchant restock burns.

---

## Classes

| Code | Meaning |
| --- | --- |
| **(a)** | Immediate on-chain call when the action succeeds. |
| **(b)** | Accrued server-side; flushed lazily as `gd.burn_from` (treasury-signed). |
| **(c)** | Server-only — never touches the chain. |

**(a)** call kinds:

- **Player-signed:** `ft_transfer` (and any player-origin NEP-141) using the player’s decrypted key.
- **Treasury-signed:** `mint`, `burn_from`, `create_token`, merchant COGS burns, forge item mint, shard mint/burn.

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

### Burns — treasury `burn_from` only for sinks **(b)** (lazy) or merchant COGS **(a)**

Burns are **not** used for player purchases.

| Movement | Class | Notes |
| --- | --- | --- |
| Passive upkeep / holding tax (`UPKEEP_RATE` / 10s) | **(b)** | Accrue → flush |
| Trade entry fee (1%) | **(b)** | |
| Trade loss | **(b)** | |
| Post cost (burn half) | **(b)** | Escrow half separate |
| Fast-travel gas (`GAS_GD`) | **(b)** | |
| CIA fine | **(b)** | |
| Merchant cost-of-goods on restock | **(a)** | Treasury/merchant burn when restocking inventory economics |

### Escrow — server ledger **(b)**-adjacent

| Movement | Notes |
| --- | --- |
| Trade stake hold | Increases `escrowed`; reduces `available` |
| Post escrow half | Same |
| Stake/escrow release on settle | Decreases `escrowed`; win may `mint` profit **(a)** |

### Server-only **(c)**

Daily cap bookkeeping, XP, needs (except food hunger apply after pay), social, market sim, look cosmetics, key storage, prototype USDG (removed).

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
| Merchant restock / COGS | **(a)** | Burns or admin moves as designed. |
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

Document env knobs (names TBD in implementation): e.g. `SIGNUP_IP_LIMIT`, `SIGNUP_HOURLY_CAP`, `INVITE_CODE`, funding check against `0.2` NEAR.

---

## Settlement sketch (no code yet)

1. Validate action; compute `available`; reject if insufficient.
2. **(b)**-only → append `pending_burns` / adjust `escrow`; return.
3. **(a)** purchase / payout / logout / 5‑min / shutdown:
   - Flush `pending_burns` capped at chain balance.
   - Purchases: player `ft_transfer` → merchant; `pending_delivery` → deliver; reconcile later.
   - Food: `ft_transfer` → chef; hunger **(c)** update; no item mint.
   - Sinks already in pending: covered by flush.
   - Prizes: treasury `mint`.
4. `ChainWriteError` → `chain_failures` / outbox retry policy; do not advance dependent game state.
