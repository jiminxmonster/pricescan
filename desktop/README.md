# PriceScan Desktop — scroll-based supervised collection

Electron owns one app window, isolated embedded marketplace views, persistent per-site
sessions, and durable task state. No browser extension installation is required.
The existing React seller workspace and local FastAPI database remain in use.

## Run / build (macOS, local development)

1. From the repository root: `docker compose up -d --build`.
2. From `desktop`: `npm ci` then `npm start` (Electron may download its runtime on first use).
3. `npm run package` creates a timestamped `PriceScan Desktop.app` in
   `artifacts/pricescan-desktop/`. The launcher/helper prefers the newest build
   that has passed local code-signature verification (`.pricescan-ready`).

운영 배포판을 Desktop 셸에서 테스트하려면 HTTPS 주소를 명시합니다. API 주소는 같은 경로의 `api`로 고정되며, HTTP는 로컬 루프백에서만 허용합니다.

```bash
PRICESCAN_APP_URL=https://pricescan.d2blue.com/pricescan/ npm start
```

The package contains Electron, host code and the shared parsers. **The UI/API
still depend on the existing local Docker services.** This is not yet a fully
offline/self-contained installer. The package uses an ad-hoc development
signature; public distribution needs Developer ID signing, notarization,
secure updates, and real-device notification/OS permission verification.

## Collection behavior

- Search creates/reuses a seller draft and loads Naver, Danawa, Enuri and Coupang
  concurrently. One marketplace occupies the full browser area, while all four
  keep their isolated persistent sessions and independent workers in memory.
- Scroll up or down on the fixed PriceScan work bar to move freely between the
  four full-size marketplace screens. This is not a gated next-step wizard; a
  marketplace can be revisited at any time to adjust its lowest-price option.
- Each marketplace indicator turns green when its current result page is ready.
  On the last marketplace, **4곳 한 번에 수집** becomes available only after all
  selected screens are ready. CAPTCHA, login and access-limit screens stay visible
  for the user and are never bypassed.
- Captured candidates return to a four-panel review view. The left checkbox selects
  up to ten rows for detail research; the right checkbox controls monitoring.
- **닫기** returns to the seller screen without cancelling collection;
  **내리기** minimizes the one app window. Marketplace popups stay in the same
  embedded view.
- Naver starts from the visible Shopping landing page. The desktop host finds a
  visible search field, clicks it with normal Electron mouse input, inserts the
  model name and presses Enter. It does not direct-load a generated Naver result
  URL. Normal results are then read automatically (up to ten loaded cards, no
  stealth, proxy rotation, CAPTCHA solving, or scripted Naver scrolling).
- A matching Naver query/sort result is reused for six hours without opening
  Naver again. A genuinely new Naver search is globally spaced by 60–90 minutes.
  One loaded page is read for up to ten already-visible cards without pagination,
  scripted scrolling or detail requests.
- Login/CAPTCHA pauses reads, raises an in-app status, Dock badge and native
  notification attempt. Click the notification or **화면 보기** to open the exact
  job window. Complete verification directly; normal, matching-query results
  must be stable before automatic collection resumes.
- An access-denied page stops that worker without an automatic reload loop.
  After resolving the restriction, **이어서 진행** re-inspects the same window.
  If login lands elsewhere, open the requested Shopping results in that window.
- New Naver starts are spread across a persisted 60–90 minute interval, never
  below one hour, including across restarts. A detected restriction adds a
  persisted 24-hour rest period and never triggers an automatic retry. This is
  request reduction, not identity masking. Other sources run independently.
- **중지** cancels the selected task. Closing a collection window hides it; it
  does not cancel work. Quit the app to stop all work.
- On app restart unfinished tasks become **일시정지**. After PriceScan login,
  explicitly resume. Parsed-but-unsaved results are retried without revisiting
  the shop. `/price-search/desktop-results` uses job UUID + source idempotency,
  so retries do not double-count quota or replace prior source/item identities.
- Marketplace empty results, access denial and save failures are distinct;
  they are never presented as successful price collection.

## Security boundaries

- App-owned profile: `~/Library/Application Support/PriceScan Desktop`.
  Legacy Chrome / PriceScan Browser profiles are not inspected, copied or erased.
  Users sign in directly; sessions can expire or be rejected by the site.
- Shopping views have **no preload or IPC bridge**, Node disabled, context
  isolation and sandbox enabled, HTTPS domain-scoped navigation, downloads and
  permission requests denied by default. Do not add broad OS permissions.
- Only the fixed local PriceScan main frame receives named start/list/action
  calls. Control bars have only their own window action bridge. No generic
  command execution, cookies, passwords, credential export or AI access.
- Task JSON stores queries, product IDs, statuses and price results, not app
  tokens or browser cookies. PriceScan auth tokens are memory-only in the host;
  logout interrupts jobs. API writes use a fixed loopback address and reject
  redirects. The existing local single-admin auth model is unchanged.
- Electron is not a guarantee that Naver accepts embedded-browser login or
  automated collection. Validate login → results → handoff → resume with the
  user; respect persistent restrictions and consider official APIs separately.

## Verification

`npm test` tests independent workers, cancellation, restart recovery, no token
persistence, save retry, throttling and navigation/challenge classification.
Backend: `python -m unittest discover -s tests` from `backend` includes transactional
partial-result merge, idempotency, authorization and monitoring preservation.
Frontend: `node --test tests/*.test.ts` and `npm run build` from `frontend`.

Live acceptance: open the packaged app → search a real model → inspect each
source's independent status → directly complete any requested Naver login →
verify saved Naver prices (not just a page opening) → quit/relaunch and check
login persistence and explicit task recovery. Automated fixture tests alone do
not establish live Naver compatibility or native notification delivery.
