# Glitch economy (MVP GD-only)

Constants: [`shared/src/economy.ts`](../shared/src/economy.ts). Catalog: [`shared/src/catalog.ts`](../shared/src/catalog.ts). On-chain settlement policy: [`ONCHAIN.md`](./ONCHAIN.md).

## Design notes (settlement)

See [`ONCHAIN.md`](./ONCHAIN.md) for the full map. Short rules that affect economy design:

1. **Purchases ≠ burns.** Food, furniture, studio, maintenance, and forge `gdCost` are player-signed **`ft_transfer` → merchant** (`chef` / `dealer` / `smith`). Burns are only for sinks (holding tax / upkeep, fees, trade loss, post cost, fines) and merchant COGS on restock.
2. **`available = chainBalance − pendingBurns − escrowed`.** Every spend, stake, and maintenance payment checks `available`. `/me` returns `available`. Lazy `burn_from` flushes are capped at real chain balance.
3. **Food is instant.** Pay chef, apply hunger server-side, **no food token mint** (catalog food rows are price/effect only).
4. **Pay-then-deliver** for furniture / studio / gear with `pending_delivery` + reconcile; refund from merchant is last resort.
5. **Signup protection:** per-IP limit, hourly global cap, optional `INVITE_CODE`, refuse if root/`players` NEAR &lt; 0.2.

## Applied tuning (from prior proposals)

| Lever | Was | **Now** |
| --- | ---: | ---: |
| START | 250,000 | **60,000** (`START_GD`) |
| studio-apartment | 200,000 | **90,000** (`HOMEP_GD`) |
| studio maintenance | 7,500 / 10 min | **1,000 GD / 3,600,000 ms (1 h)** (`MAINTENANCE_GD` / `MAINTENANCE_MS`) |
| bed2 | 150,000 | **70,000** |
| trophy | 120,000 | **60,000** |
| Passive upkeep (holding tax) | 0.04% / 10s | **0.01% / 10s** (`UPKEEP_RATE = 0.0001`) |

## GD ↔ USDG (prototype legacy)

Fixed rate — does **not** float. MVP has no USDG; conversion only for migrated prices.

| Location | Constant | Rate |
| --- | --- | --- |
| legacy / `web` swap desk | `RATE` / `USDG_TO_GD` | **1 USDG = 500 GD** |

```ts
export const USDG_TO_GD = 500; // prototype RATE
```

---

## Earn sources (GD faucet via `earn()`)

Skill pay: weak (−40% if energy&lt;15 or hunger&lt;10); daily cap; over-cap credits **20%**.

### Daily skill-pay cap

```
payCap = PAY_CAP_BASE + PAY_CAP_PER_LEVEL * (L(trade) + L(sec) + L(comm) - 3)
       = 150000 + 25000 * (sumLevels - 3)
```

| Skill levels (t+s+c) | Daily cap |
| ---: | ---: |
| 1+1+1 (new player) | **150,000** GD |
| +1 total level | +25,000 GD |

Starter balance: **START_GD = 60,000** (not skill pay).

### Vault Cracker (sec)

`pay = hits * 15000 + (hits === 3 ? 30000 : 0)` then `earn(pay)`. Shards: `hits + (hits===3 ? 1 : 0)`.

| Hits | GD (before cap/weak) | Shards |
| ---: | ---: | ---: |
| 0 | 0 | 0 |
| 1 | 15,000 | 1 |
| 2 | 30,000 | 2 |
| 3 (perfect) | **75,000** | 4 |

### Trade Terminal

- Stakes: `1000, 5000, 10000, 50000, 100000`
- Entry: escrow stake, burn **1% fee**
- Win: stake returned + `earn(pnl)`; loss burned

### Attention Booth (post)

- Cost **10,000** GD: burn 5,000 + escrow 5,000; profit via `earn`

### Affordability assumptions

| Mode | GD / day |
| --- | ---: |
| Daily cap | 150,000 |
| Realistic | 50,000 |

---

## GD outflows (current)

| Outflow | Amount | Settlement (see ONCHAIN) |
| --- | --- | --- |
| Trade fee | 1% of stake | **burn** accrued **(b)** |
| Trade loss | up to stake | **burn** accrued **(b)** |
| Post half-burn | 5,000 of 10,000 | **burn** accrued **(b)** |
| Fast travel gas | **200** GD | **burn** `GAS_GD` **(b)** |
| Passive upkeep (holding tax) | **0.01%** / **10s** | **burn** `UPKEEP_RATE` **(b)** |
| CIA fine (guilty) | `min(bal, loot * 1.25)` | **burn** **(b)** |
| Furniture | catalog `priceGD` | **`ft_transfer` → dealer** **(a)** |
| Studio buy | **90,000** GD | **`ft_transfer` → dealer** **(a)** |
| Studio maintenance | **1,000** GD / **1 h** | **`ft_transfer` → dealer** **(a)** |
| Food | 1,000–4,000 GD | **`ft_transfer` → chef** **(a)**; no item mint |
| Gear mint GD leg | `gdCost` | **`ft_transfer` → smith** **(a)** (+ shard burn) |

---

## Affordability (after tuning)

Earn-only days = `priceGD / rate`. Flag if **&gt; 3 days** or **&lt; 2 minutes**.

| Item | priceGD | Cap days | Realistic days | Flag |
| --- | ---: | ---: | ---: | --- |
| zobo-drink | 1,000 | 0.007 (~10 min) | 0.02 (~29 min) | — |
| suya-skewer | 2,000 | 0.013 | 0.04 | — |
| jollof-and-chicken | 4,000 | 0.027 | 0.08 | — |
| plant | 8,000 | 0.053 | 0.16 | — |
| lamp | 12,000 | 0.08 | 0.24 | — |
| rug | 15,000 | 0.10 | 0.30 | — |
| cap gdCost | 1,000 | 0.007 | 0.02 | — (+3 shards) |
| backpack gdCost | 2,500 | 0.017 | 0.05 | — |
| chain gdCost | 5,000 | 0.033 | 0.10 | — |
| cape gdCost | 10,000 | 0.067 | 0.20 | — |
| crown gdCost | 20,000 | 0.13 | 0.40 | — |
| sofa | 40,000 | 0.27 | 0.80 | — |
| neon | 50,000 | 0.33 | 1.0 | — |
| trophy | **60,000** | 0.40 | 1.2 | — |
| tv | 60,000 | 0.40 | 1.2 | — |
| bed2 | **70,000** | 0.47 | 1.4 | — |
| pc | 90,000 | 0.60 | 1.8 | — |
| studio-apartment | **90,000** | 0.60 | 1.8 | — (+ first maintenance 1,000) |
| studio maintenance / period | **1,000** / 1 h | n/a | n/a | OK vs cap |

### Starter balance (START = 60,000)

With START 60k: food and small furniture (plant–rug) are still buyable immediately; mid furniture (sofa+) and housing need earn. Studio (90k) and bed2 (70k) are **not** free at spawn.
