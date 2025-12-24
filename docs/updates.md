# Updates

## Slippage and depth protection

- Added configurable slippage/depth guards for BUY/SELL execution (replaces the previous hardcoded $0.05 BUY check):
  - `MAX_SLIPPAGE_PCT`: allowed price drift vs trader price (default 1.0)
  - `SLIPPAGE_WAIT_MS`: wait between retries when outside tolerance (default 30s)
  - `SLIPPAGE_MAX_RETRIES`: max retries before skipping (default 20; 30s * 20 ≈ 10 minutes)
  - `MIN_BOOK_SIZE_USD`: minimum depth at best price (default $5)
  - `SLIPPAGE_ACTION`: `wait` (retry then skip) or `skip` (skip immediately)
- Logic lives in `src/utils/postOrder.ts` and is sourced from `src/config/env.ts`. Configure via `.env` (see `.env.sample`).

## Defaults

- `.env.sample` documents all required settings, including new slippage/depth variables.
- Defaults updated to allow waiting up to ~10 minutes for price to return within tolerance before skipping.

## Dashboard/API

- Added a lightweight dashboard/API server (`npm run dashboard`) at `DASHBOARD_PORT` (default 4000). Serves `/api/positions` and `/api/activity` via Polymarket data API and hosts the frontend under `/`.
- Frontend now consumes the local API (no external CORS proxy) and shows the tracked trader/bot addresses dynamically.

## Reconciliation

- New script `npm run reconcile` (`src/scripts/reconcilePositions.ts`): fetches trader/bot positions, finds stale bot-only holdings, and attempts to sell them using the existing postOrder logic (with slippage/wait guards). Use to clean up positions when the bot missed an exit.
