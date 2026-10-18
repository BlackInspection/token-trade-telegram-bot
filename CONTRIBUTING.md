# Contributing

Thanks for helping. Bug reports, fixes and verified API details are all welcome, especially for anything marked `TODO(verify)`.

## Set up and test

You need Node.js 22.13 or newer (the bot uses the built-in `node:sqlite`, unflagged from 22.13).

```bash
npm install
npm test
node src/index.js mock --cycles 2
```

Both must pass before you open a pull request. Tests and `mock` run offline and need no keys. If you add a feature, add offline tests for its logic, and fixtures in `src/data/mock.js` so the `mock` run shows it.

## The safety rule

Never weaken a safety default. In particular:

- `DRY_RUN=true` stays the default and stays a hard lock: no bot command or stored setting may lift it.
- Live autopilot keeps needing `DRY_RUN=false`, graduation and the Confirm LIVE button.
- Every spend path checks `MAX_TRADE_USD`, `DAILY_BUDGET_USD`, `MAX_TRADES_PER_HOUR`, `MAX_OPEN_POSITIONS` and `DAILY_LOSS_LIMIT_USD`.
- `/panic` must keep stopping all buying, and exits must keep running.
- Secrets (bot token, private keys, API keys) are never logged in full.

Pull requests that relax these will not be merged.

## Code style

- Node.js 22.13+, ES modules, no build step. Keep runtime dependencies to a minimum; anything only needed for live swaps goes in `optionalDependencies` and is loaded with `import()`.
- Keep the math pure: `costs.js`, `guardian.js`, `risk.js`, `indicators.js` and `explain.js` do no I/O, and the clock is passed in.
- API-specific code lives in `src/data/` and `src/executors/`. Mark any guess about an external API with `TODO(verify)`.
- Every price shown to the user is net of fees, taxes, gas and price impact.
- Everything is in English: code, comments, bot strings, CLI output and docs.
- Two-space indent, single quotes, semicolons. Match the style of the surrounding code.
