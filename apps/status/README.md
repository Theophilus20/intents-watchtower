# Status app

The public face of Intents Watchtower: is this route safe right now, and why.

- **Routes**: the verdict in one sentence, safety stats, every route with status, score, backing and trend. Tap a route for the plain-language answer (English, French, Spanish), each check, backing over time, what an app sees from `is_safe`, and the signed proof.
- **Chains**: the contagion map and chain health.
- **Watchers**: the quorum rules, live signatures for the selected route, and a lying-watcher simulation.
- **Developers**: an agent you can run against the current state, SDK and contract snippets, method reference.
- **Data source**: replay one of five incidents through the real engine, or connect to a deployed watchtower contract on testnet or mainnet.

Built with Preact and bundled into one HTML file (≈180 KB, no runtime CDN apart from Google Fonts).

```bash
npm run build:status          # apps/status/dist/site/index.html
npx serve apps/status/dist/site
```

Deploy `apps/status/dist/site` to any static host. The CI workflow publishes it to GitHub Pages on pushes to `main`.

Live mode reads the contract through public NEAR RPC from the browser, so it works on any normal origin. Inside embedded previews that block outbound requests, it shows an error that says so.

Tested in `apps/status/test/page.test.ts`: replay to red, open a route, verify signatures, flip a lying watcher, switch language, close with Escape, run the agent, visit every view.

## Your brand

- **Logo**: paste your SVG into `LOGO_SVG` in `src/brand.tsx` (it inherits the text colour), or put an image in `public/` and set `LOGO_SRC`. Then `npm run app`.
- **Token icons**: drop official icons into `public/tokens/` (`btc.svg`, `eth.svg`, …) and set `TOKEN_ICON_PATH = "tokens/"`. Until then the app shows ticker badges.
- **Name**: `PRODUCT_NAME` and `SHORT_NAME` in the same file.
