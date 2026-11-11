# Track 09 — Games With Real Economies

Hackathon: [NEAR Hackathon](https://nearhackathon.com/), Track 09. Deadline **14 Nov 2026 23:59 UTC**. Submission needs a public repo, an X demo tagged `@NEARProtocol` `#NEARHackathon`, and the form (wallet + both links).

## Claim table

| Criterion / tag | Glitch evidence | Where |
| --- | --- | --- |
| Game loop first | City walk + earn/spend stations before any wallet UI | `web/`, intro → stations |
| Player markets | List / buy / cancel furniture & gear for GD | `POST /market/*`, Assist → Market |
| NPC economies that move | Merchants hold GD; dynamic quotes; restock/COGS rules | `GET /merchants`, `shared/merchants.rules.ts`, merchant accounts |
| Bonus: players never see the chain | Custodial subaccounts; encrypted keys; no player wallet | Server auth + near; only `/advertise` uses wallet |
| NEP-141 GD | Mint / burn / transfer after server validates results | `gd` contract, `docs/ONCHAIN.md` |
| NEP-245 items | Multi-token items (furniture, shards, unique gear) | `items` contract, `docs/ITEMS.md` |
| Ads paid in NEAR | Billboard slots via market contract | `/advertise`, `market.book_ad` |
| Agent NPCs | Rule-driven merchants with GD wallets — **not** LLM agents | Honest gap |
| Social login | Google GIS when `GOOGLE_CLIENT_ID` is set | `/auth/google*`; hidden if unset |
| NEAR Intents | **Not used** | Out of scope |

## Pitch (judges)

Economy **is** the gameplay: earn GD in minigames, spend at NPC merchants that hold balances, forge unique gear, list items to other players — while the player never opens a chain wallet. Testnet (or mock for verify). Intents are out of scope; custodial play + NEP-245 are in.

## Demo script (60–90s for X)

1. **Enter** — Open the city; Play as guest or Create account (no wallet prompt).
2. **Earn** — Vault Lab or Exchange: finish one payout; flash Available GD / feed.
3. **Spend at NPC** — Neon Diner buy, or Forge if shards exist; mention merchant GD path.
4. **Market or forge** — Show Assist → Market listing UI, or a unique gear mint id.
5. **Invisible chain** — Assist → Settings: Mock badge **or** testnet chain proof — player still never signed a tx.
6. **Close** — One line: server settles every result; `/advertise` is the only wallet screen.

Optional B-roll: Rank tab, Pose, My Home paint (label as cosmetic).

## Screener path

Judges/AI should follow the **mock** path in the [README](../README.md) and [TEST.md](./TEST.md): `npm install` → `npm test` → `npm run verify` with no secrets. Testnet is optional proof for the live demo video.
