# Changelog

## 1.3.90 · 2026-11-02

- Contract events refresh without a stall when the RPC lags.
- The alert keeps its format after a token rename.
- Faster startup with a long watch list.
- Fixed the balance row on wallets with many decimals.


All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-28

First public release.

### Added

- Token analysis for any contract address on Solana and EVM chains: DexScreener market data with outlier-resistant pair selection, GoPlus, honeypot.is and RugCheck security, GeckoTerminal candles, EMA, RSI, MACD, ATR and volume spikes, a 0-100 risk score with reasons, and a BUY, WATCH or AVOID verdict with entry, stop and target.
- Exit Test: a Jupiter (Solana) or KyberSwap (EVM) round-trip quote with a pool-size fallback, the break-even move, the largest buy under a 3% round trip, a cost gate for automatic buys, `/cost` with a $50 / $250 / $1,000 ladder, and a `/buy` confirmation card.
- Verdict card: RED, YELLOW or GREEN with the top 3 reasons in money terms, check coverage, the data age, and an "Is this the real one?" copycat check.
- Position Guardian: alerts and practice exits when a held token's tax, honeypot status, sell route, mint or owner rights, LP lock, liquidity or pair changes; warnings tighten the stop. `/guardian` shows the status per token.
- Track record: every check is graded at 1h, 24h and 7d, with per-verdict stats, confidence intervals and the baseline (`/trackrecord` and the `trackrecord` CLI command).
- Safe ladder: practice mode, link mode (swap links for Phantom, Jupiter, Uniswap and PancakeSwap that you sign yourself, plus `/filled`), and live autopilot through Jupiter or 0x after graduation. A `/start` tour on a fresh install.
- Watchlist autopilot with the EMA-cross / RSI strategy, stop-loss, take-profit, trailing stop and position sizing; practice fills with pool price impact and token taxes; a backtester.
- Explained decisions: `/why` for every alert, buy and skip, a `decisions` table, a JSONL event log, a daily digest with tuning hints, and an optional "Explain more" button using Claude.
- Shadow rules with hindsight cards, `/scoreboard`, `/digest`, `/mute`, `/preset` and `/settings`.
- Optional display currency (`DISPLAY_CURRENCY=eur` or `rub`).
- Offline `mock` mode with fixture tokens that shows every feature, and 174 offline tests.
- Windows install (README: Self-hosting) and a GitHub Actions workflow.

### Safety

- `DRY_RUN=true` by default, as a hard lock that no bot command or stored setting can override.
- Live autopilot needs `DRY_RUN=false`, a graduation checklist and a Confirm LIVE button. An unconfirmed `live` mode runs as practice.
- Spending limits (`MAX_TRADE_USD`, `DAILY_BUDGET_USD`, `MAX_TRADES_PER_HOUR`, `MAX_OPEN_POSITIONS`, `DAILY_LOSS_LIMIT_USD`) on every buy, with buys run one at a time and real buys recorded before they are sent.
- `/panic` stops all buying and forces practice while exits keep running; `/resume` needs a confirmation that expires after 120 seconds and only clears the panic it was made for.
- `/pause` and every auto-pause stop all new entries: the autopilot, manual `/buy` and confirmation cards made before the pause. A stale-data pause ends by itself when fresh market data is back, and a Resume button only ends the pause it was sent for.
- Real-money buys (link or live mode) above `CONFIRM_ABOVE` always ask first, on autopilot and for a manual `/buy` with `BUY_CONFIRM=false`.
- Live sells swap at most the position's own quantity, capped at the wallet balance; other tokens of the same mint in the hot wallet are never sold.
- `/settings slippage_bps` reaches every Jupiter and 0x quote and every practice fill; raising it waits `LOOSEN_DELAY_HOURS` like other loosening changes.
- Link-mode alerts carry the LIVE tag, because you sign real swaps. A shadow rule goes live only after **Go live** and a second tap within 120 seconds.
- Seatbelts: a monthly loss budget, a loss-streak cooldown, a revenge-trade block and delayed loosening of limits.
- Auto-pause after repeated executor errors or stale market data; `/safety` (including which risk preset your limits match) and `/doctor`.
- Balance-drop auto-pause: in live mode the bot reads the hot wallet's USDC balance every 5 minutes. When the balance falls more than `AUTO_PAUSE_BALANCE_DROP_PCT` (30% by default) below any reading of the last 24 hours, beyond what the bot's own trades explain, it pauses, sends an alert with a Resume button and refuses real-funds buys until you resume. `doctor` shows the balance and fails when `DAILY_BUDGET_USD` is above it.
- The Guardian never sells real funds unless `GUARDIAN_LIVE_EXIT=true`.
- Secrets are never logged in full; `doctor` prints key names only.

### Known limitations

- No real-funds swap has been sent yet. The Jupiter and 0x executors are untested with real money, the 0x path has never run with an API key, and the hot-wallet balance reader has not read a real wallet.
- The balance reader counts USDC only (not SOL or ETH for gas, not token holdings). Live `POSITION_SIZE_PCT` sizing still uses `PAPER_START_EQUITY`, and positions are not reconciled with the wallet after a restart.
- Round-trip costs are estimates. Constant-product math understates impact on concentrated-liquidity pools, and a quote is not an execution.
- The Guardian polls, so it cannot beat a rug that happens in the same block.
- Gas, DEX fee and risk-weight defaults are rough starting values.
- Several API details are marked `TODO(verify)` in the code; see "Before going live" in the README.
- Bot strings and reason templates are English only.

[0.1.0]: https://github.com/<owner>/crypto-trading-bot/releases/tag/v0.1.0
