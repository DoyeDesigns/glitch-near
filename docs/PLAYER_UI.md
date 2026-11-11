# Player UI map

How every surface opens, what it does, and whether money is server-settled or client-only. Code paths: `web/src/`.

## Intro (`#intro`)

| Tab | Action | Server |
| --- | --- | --- |
| Sign in | Name + PIN → Enter the city | `POST /auth/login` |
| Create account | Name + PIN (+ invite if required) | `POST /auth/login` with `signup: true` |
| Play as guest | Temporary `guest-*****` name | `POST /auth/login` with `guest: true` |
| Google | Shown only if `GET /auth/google/config` returns a `clientId` | `POST /auth/google` |

After success the intro hides and the city runs. First visit may open the look customizer.

## Controls

| Input | Effect |
| --- | --- |
| WASD / arrows / joystick | Move |
| Hold-drag on canvas | Look |
| Short click on floating assist drone | Open assist panel |
| **P** | Toggle assist |
| **E** / Use prompt | Enter door or use station |
| Esc | Close modal (when not locked) |

## City stations

Walk to a lit door or station, press **Use**.

| Place | Game / action | Server |
| --- | --- | --- |
| Wall Street / Exchange | Timed UP/DOWN bet | `/trade/open`, `/trade` |
| Vault Lab | Vault Cracker locks | `/vault/start`, `/finish`, `/cancel` |
| Attention Tower | Paid post | `/post` |
| Gear Forge | Mint gear NFT for shards + GD | `/forge/mint` |
| Neon Diner | Buy food (hunger) | `/shop/buy`, `/merchants` |
| Park bench | Rest energy | `/rest` `{ kind: 'bench' }` |
| My Home | Sleep / decorate (if owned) | `/rest` sleep, `/home/*`, furniture via `/shop/buy` |

Billboards read `GET /ads` (and creative proxy). Empty slot copy: “YOUR AD HERE”.

## Floating assist (ex-phone)

Open: click the cyan square drone beside the player, or press **P**. Modules grid:

| Module | Role | Server / client |
| --- | --- | --- |
| Social | Local feed / following | Client feed chrome; posts that pay go through `/post` at the tower |
| Chat | Here / DMs | Client-local NPC chat stub |
| Map | Districts + Go | **Go** burns GD in the browser (fast travel — client-only gap) |
| Balance | Available GD, shards, skill-pay meter, city-day sim | `/me`; sim uses `/sim/fast-forward` (no chain write) |
| Profile | Name / role card | Mostly client + `/me` |
| Pose | 10 presets + one custom pose | **Client-only**; custom in `localStorage` key `glitch-custom-pose-v2` |
| Settings | Rename, look, hint toggle, Advanced chain proof, reset | `/me/chain`; reset clears local save only |
| My Home | Buy studio, maintenance, furniture, room paint | `/home/*`, `/shop/buy`; **paint is client-only** |
| Market | List / buy / cancel gear or furniture | `/market`, `/market/list`, `/market/buy`, `/market/cancel` |

Hints: level-tiered lines near the drone (`#assistHint`). Hide with ×; re-enable in Settings or Modules home.

## HUD (always on)

| Element | Content |
| --- | --- |
| Top-left card | Name, role, available GD, settling, return %, rep, energy/hunger, daily skill pay |
| Top-right metrics | Online / district / visits (demo chrome) |
| Location chip | Current `LOCS` place |
| Tabs | Feed, Skills, Rank, About — toggle; × closes panel |
| Market strip (`#mk`) | Token tickers from SSE |

### HUD tabs

| Tab | Data |
| --- | --- |
| Feed | Recent posts from the sim/SSE feed |
| Skills | trade / sec / comm XP; locked future skills |
| Rank | `GET /leaderboard` — top 20 by spendable GD |
| About | Short product + local economy counters; Reset progress clears `localStorage` save |

## Advertise (`/advertise`)

Only page that loads NEAR wallet selector. Reads market contract prices; `book_ad` deposits NEAR. Env: `VITE_MARKET_CONTRACT` in `web/.env.local`.

## Admin (`/admin`)

Requires `ADMIN_TOKEN` in server env. Sends `x-admin-token` to `GET /admin/health`. Shows account balances, pending burns, outbox, signup caps.
