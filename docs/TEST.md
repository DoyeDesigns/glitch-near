# Test playbook (AI / screener)

Primary path is **mock**. No secrets. Run from a clean clone at the repo root.

## 1. Mock env

```text
cp server/.env.example server/.env.local
```

Confirm `CHAIN_MODE=mock`. Leave `TREASURY_KEY` and `KEY_ENCRYPTION_SECRET` empty. Do not set `GOOGLE_CLIENT_ID` unless you are testing Google.

Windows PowerShell:

```powershell
Copy-Item server\.env.example server\.env.local
```

## 2. Install and run

```text
npm install
npm run dev
```

Expect API on `http://localhost:8787` and Vite on `http://localhost:5173`. Open the Vite URL.

## 3. Unit / integration tests

```text
npm test
```

Runs `@glitch/shared` then `@glitch/server` tests. Expect exit code 0.

## 4. Automated verify (mock)

```text
npm run verify
```

Boots the Hono app in-process with a temp SQLite DB and `CHAIN_MODE=mock`. Expected lines (order fixed):

| Line | Proves |
| --- | --- |
| `PASS signup — available=…` | Create account + session cookie + positive `GET /me` available |
| `PASS vault — hits via 3 stops` | `/vault/start` + three `/vault/finish` hits |
| `PASS purchase — suya-skewer` | `/shop/buy` food → chef path |
| `PASS forge — gear-cap-…` (or token id) | `/forge/mint` after vault shards |
| `PASS ad lookup — slots=…` | Public `GET /ads` returns slots |
| `verify PASS (5/5)` | All steps green |

Exit code must be **0**.

## 5. Manual smoke (~10 minutes, mock)

1. Open `http://localhost:5173`. **Play as guest** (or Create account with a short name + PIN).
2. Assist → **Settings**: must show **Mock chain (no testnet)** (or Advanced chain proof without a live NEAR account).
3. Walk to **Neon Diner** → Use → buy a cheap item. Available GD should drop via `/shop/buy`.
4. Walk to **Vault Lab** → Use → finish at least one lock (or cancel). Check feed / Balance for payout or cancel.
5. If shards &gt; 0, **Gear Forge** → mint a cheap piece (e.g. Cap).
6. HUD **Rank** tab: loads `GET /leaderboard` (you may appear after guest/create).
7. Assist → **Pose**: pick a preset; optionally save a custom pose (local only).
8. Assist → **My Home**: if affordable, buy studio; try **paint** (cosmetic, client-only).
9. Assist → **Market**: open listings UI (list/buy only if you have furniture/gear).

Optional: Attention Tower post, Exchange one small trade, Assist → Map → Go (`POST /travel`, `GAS_GD` pending burn).

## 6. Optional: NEAR testnet

Not required for screener PASS. Needs funded `players` parent and keys — see [ACCOUNTS.md](./ACCOUNTS.md).

1. Set `CHAIN_MODE=testnet` and fill `GD_CONTRACT`, `ITEMS_CONTRACT`, `MARKET_CONTRACT`, `ROOT_ACCOUNT`, `TREASURY_KEY`, `KEY_ENCRYPTION_SECRET` in `server/.env.local`.
2. `npm run near:smoke -w @glitch/server` — live chain sanity.
3. Idempotent setup if needed: `npm run items:seed -w @glitch/server`, `npm run merchants:setup -w @glitch/server`.
4. `npm run dev` → Create account → `GET /me` should show `<name>.players.…` and ~60,000 GD available.
5. Repeat a short diner / vault / forge path; Assist → Settings should show testnet chain proof, not Mock.

## 7. Failure tips

| Symptom | Likely cause |
| --- | --- |
| Port 8787 in use / API down | Kill the other process; `npm run dev` starts both |
| `npm run verify` FAIL on signup | Env not mock, or DB path locked; re-copy `.env.example` |
| Settings shows unexpected chain | Wrong `CHAIN_MODE` in `server/.env.local` |
| Create / guest “paused” or signup refused | **Testnet only:** root/`players` NEAR &lt; 0.2 — top up per ACCOUNTS.md |
| Google tab missing | `GOOGLE_CLIENT_ID` unset (expected) |
| Advertise wallet fails | Need `VITE_MARKET_CONTRACT` in `web/.env.local` and testnet |
| Admin 404 | `ADMIN_TOKEN` unset (expected) |
| Map Go 404 in Vite | Restart `npm run dev` so Vite proxies `/travel` to the API |
