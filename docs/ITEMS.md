# Glitch items catalog

Source of truth: [`shared/src/catalog.ts`](../shared/src/catalog.ts), taken from `legacy/glitch-prototype-v2c.html` and the matching tables in `web/src` (`FURN`, `MENU`, `GEARINFO`, home/forge).

MVP has **no USDG**. Former USDG prices use `USDG_TO_GD = 500` (prototype swap `RATE`). Unique **gear** is listed for reference but minted at forge time as `gear-<type>-<uuid>` (`max_supply` 1) — not seeded. Entries marked **proposed** are UI placeholders only.

Sellers: **chef** (food), **smith** (forge/gear), **dealer** (furniture/housing).

## Gear

| id | title | priceGD (gdCost) | shards | sellerId | maxSupply | effect | source |
| --- | --- | ---: | ---: | --- | ---: | --- | --- |
| cap | Cap | 1000 *(was 2 USDG)* | 3 | smith | 1 | Common wearable NFT | GEARINFO[1] |
| headphones | Headphones | — | — | system | — | Free starter gear | FREEGEAR |
| chain | Chain | 5000 *(was 10 USDG)* | 8 | smith | 1 | Rare wearable NFT | GEARINFO[3] |
| backpack | Backpack | 2500 *(was 5 USDG)* | 5 | smith | 1 | Common wearable NFT | GEARINFO[4] |
| cape | Cape | 10000 *(was 20 USDG)* | 15 | smith | 1 | Epic wearable NFT | GEARINFO[5] |
| crown | Crown | 20000 *(was 40 USDG)* | 30 | smith | 1 | Legendary wearable NFT | GEARINFO[6] |

On-chain mint id: `gear-<type>-<uuid>` via `gearTokenId(type, uuid)`.

## Furniture

| id | title | priceGD | sellerId | maxSupply | effect | source |
| --- | --- | ---: | --- | ---: | --- | --- |
| bed2 | Royal Bed | 70000 | dealer | — | +5 comfort | FURN / ECONOMY.md |
| rug | Neon Rug | 15000 | dealer | — | +2 comfort | FURN |
| sofa | Sofa | 40000 | dealer | — | +3 comfort | FURN |
| plant | Plant | 8000 | dealer | — | +1 comfort | FURN |
| lamp | Floor Lamp | 12000 | dealer | — | +1 comfort | FURN |
| tv | Big TV | 60000 | dealer | — | +4 comfort | FURN |
| pc | Gaming PC | 90000 | dealer | — | +5 comfort | FURN |
| neon | Neon Sign | 50000 | dealer | — | +3 comfort | FURN |
| trophy | Trophy Shelf | 60000 | dealer | — | +6 comfort | FURN / ECONOMY.md |

## Food

Price/effect only for the eat path: player **`ft_transfer` → chef**, hunger applied server-side, **no food token mint** (see [`ONCHAIN.md`](./ONCHAIN.md)).

| id | title | priceGD | sellerId | maxSupply | effect | source |
| --- | --- | ---: | --- | ---: | --- | --- |
| jollof-and-chicken | Jollof and chicken | 4000 *(was 8 USDG)* | chef | — | +45 hunger | MENU |
| suya-skewer | Suya skewer | 2000 *(was 4 USDG)* | chef | — | +25 hunger | MENU |
| zobo-drink | Zobo drink | 1000 *(was 2 USDG)* | chef | — | +8 hunger, +12 energy | MENU |

## Shard

| id | title | priceGD | sellerId | maxSupply | effect | source |
| --- | --- | ---: | --- | ---: | --- | --- |
| shard | Shard | — | vault | — | Earned in Vault Cracker; spent at forge with gdCost | secGame |

## House

| id | title | priceGD | sellerId | maxSupply | effect | source |
| --- | --- | ---: | --- | ---: | --- | --- |
| studio-apartment | Studio apartment | 90000 | dealer | — | Maintenance 1000 GD / 1 h | HOMEP_GD / MAINTENANCE_GD |
| penthouse | Penthouse | — | dealer | — | Coming later. **proposed** | homeHtml Soon |

## Consumable

_None in the prototype (food covers diner meals)._

## Seeding

```bash
npm run items:seed -w @glitch/server
```

Creates missing fungible / house / food / furniture / shard token types on `ITEMS_CONTRACT` via `get_token` → `create_token`. Skips `kind: gear` and `proposed: true`.
