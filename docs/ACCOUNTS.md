# Glitch: NEAR testnet accounts, permissions and top-ups

**Screener / CI path does not need this file.** Use `CHAIN_MODE=mock` and [TEST.md](./TEST.md). This doc is for optional live testnet demos and ops.

Network: testnet only. Root: `glitch-edoye.testnet`. All commands are for near-cli-rs 0.30 on PowerShell. If a flag fails, run the command with `--help`.

Env names: `ROOT_ACCOUNT` (= `players.…`), `TREASURY_KEY`, `KEY_ENCRYPTION_SECRET`, `GD_CONTRACT`, `ITEMS_CONTRACT`, `MARKET_CONTRACT`, optional `TOPUP_ACCOUNT` / merchant overrides — see `server/.env.example`.

## 1. Account map

| Account | Role | Who signs | Needs NEAR for |
|---|---|---|---|
| `glitch-edoye.testnet` | Root. Owner of all contracts. Parent of every sub-account below. | You (CLI, legacy keychain) | Creating sub-accounts, its own storage |
| `glitch-edoye-2.testnet` | Faucet-funded top-level account. A spare wallet. | You | Nothing. Use it as a source of NEAR |
| `gd.glitch-edoye.testnet` | GD token contract | Nobody (contract) | Storage: every registered holder costs it a little |
| `items.glitch-edoye.testnet` | Items contract (NEP-245 subset) | Nobody (contract) | Storage: every (account, token) balance costs it a little |
| `market.glitch-edoye.testnet` | Ads and cycles contract | Advertisers (`book_ad` via `/advertise`); server reads views only | Storage: bookings and cycle records |
| `treasury.glitch-edoye.testnet` | Receives ad revenue from `market` | You, rarely | Nothing. It only accumulates |
| `players.glitch-edoye.testnet` | **Server signer.** Parent of player accounts. Minter on `gd` and `items`. Operator on `market`. | The server (key in `server/.env.local` as `TREASURY_KEY`) | Funding each new player, gas for every mint, burn and transfer |
| `<name>.players.glitch-edoye.testnet` | One per player. Created and signed by the server. | The server (encrypted key in SQLite) | Small starting balance only |

## 2. The permission rules that caused the errors

1. **Only a parent can create its sub-accounts.** `players.glitch-edoye.testnet` can only be created by `glitch-edoye.testnet`. `smoke1.players.glitch-edoye.testnet` can only be created by `players.glitch-edoye.testnet`. A contract account (`gd`, `items`, `market`) cannot create siblings. `glitch-edoye-2.testnet` cannot create anything under `glitch-edoye.testnet`.
2. **Sending NEAR has no parent rule.** Any account with a key and a balance can send NEAR to any other account (`send-near`). This is the top-up mechanism.
3. **Contract roles are separate from account ownership.** Being a minter or operator is stored inside the contract (`add_minter`, `add_operator`). Only the contract owner (`glitch-edoye.testnet`) can grant it.
4. **Storage is paid by the account that stores the data.** When `gd.mint` registers a new player, `gd` pays for the bytes. When `items.mint` stores a balance, `items` pays. So the contract accounts slowly consume their balance as players grow.
5. **Gas is paid by the signer.** Every server-signed call is paid from `players.glitch-edoye.testnet`. One call costs about 0.0003 NEAR, so 1 NEAR covers roughly 3,000 calls.

## 3. Where testnet NEAR comes from

- **Faucet account (renewable).** Create a fresh funded top-level account with the faucet, then send its balance wherever it is needed:
  ```
  near account create-account sponsor-by-faucet-service glitch-edoye-3.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
  ```
  Use a new name each time (`glitch-edoye-3`, `-4`, ...). Each gets a small starting balance. If the command fails, check `near account create-account --help` and the NEAR docs for the current faucet command.
- **Web faucets.** NEAR's testnet faucets are rate-limited, so use them as a backup, not the plan.
- **Recycle.** You can delete an account you control and send its balance to a beneficiary with `near account delete-account <id> beneficiary <target> ...`. Good for junk test accounts.

## 4. How to top up any account

Pattern: **faucet account → root → whoever needs it.**

1. Check balances:
   ```
   near account view-account-summary glitch-edoye.testnet network-config testnet now
   near account view-account-summary players.glitch-edoye.testnet network-config testnet now
   near account view-account-summary gd.glitch-edoye.testnet network-config testnet now
   near account view-account-summary items.glitch-edoye.testnet network-config testnet now
   ```
2. Send NEAR (change sender, receiver and amount):
   ```
   near tokens glitch-edoye-2.testnet send-near players.glitch-edoye.testnet '0.5 NEAR' network-config testnet sign-with-legacy-keychain send
   ```
   Keep at least 0.1 NEAR in the sender, because the sender must still afford its own storage. If the CLI says "not enough balance", lower the amount.
3. If the sender is empty, create a new faucet account (section 3) and send from that.

### What to top up, and when

| Account | Warning level | Typical top-up |
|---|---|---|
| `players.glitch-edoye.testnet` | below 0.3 NEAR | 0.5 to 1 NEAR. Check it before recording the demo |
| `gd` and `items` | below 0.5 NEAR | 0.5 NEAR each, if you see "not enough balance for storage" errors |
| `market` | below 0.3 NEAR | 0.3 NEAR |
| `glitch-edoye.testnet` (root) | below 0.2 NEAR | Only needed to create new sub-accounts |
| `treasury` | never | It only receives |

Cost per new player: about 0.05 NEAR (account funding), plus a little contract storage. 20 test players is about 1 NEAR.

## 5. Standard recipes

- **Add a new minter or operator** (always signed by root):
  ```
  '{"account_id":"<account>"}' | Out-File -Encoding ascii grant.json
  near contract call-function as-transaction gd.glitch-edoye.testnet add_minter file-args grant.json prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as glitch-edoye.testnet network-config testnet sign-with-legacy-keychain send
  ```
  Use `items...add_minter` for items and `market...add_operator` for market.
- **Check a minter:** `near contract call-function as-read-only gd.glitch-edoye.testnet is_minter file-args grant.json network-config testnet now`
- **Server key rotation:** add a new key to `players.glitch-edoye.testnet`, update `TREASURY_KEY` in `server/.env.local`, then remove the old key. Never commit `.env.local`.
- **PowerShell JSON rule:** write JSON to a file with `Out-File -Encoding ascii` and pass it with `file-args`. Inline JSON loses its quotes.

## 6. Before the demo and before submitting

- [ ] `players` balance above 0.5 NEAR
- [ ] `gd`, `items` and `market` balances above 0.5 NEAR
- [ ] `is_minter` is true for `players` on `gd` and `items`
- [ ] `market` operator list includes `players`
- [ ] Treasury balance shows the test ad payment
- [ ] `.env.local`, `server/data/` and every key file are ignored by git
- [ ] README lists the contract addresses and explains the custodial, gasless model
- [ ] `web/.env` (or `.env.local`) sets `VITE_MARKET_CONTRACT` for `/advertise` wallet bookings
- [ ] Mock path still green: `npm test` && `npm run verify` with `CHAIN_MODE=mock`
