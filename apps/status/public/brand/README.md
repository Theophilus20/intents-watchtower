# Intents Watchtower brand files

| File | Use |
| --- | --- |
| `mark.svg` / `mark-white.svg` | The tower on light or dark backgrounds |
| `app-icon.svg` | Favicon, app tile, social avatar (also `app-icon-512.png`) |
| `lockup.svg` / `lockup-white.svg` | Mark with the name, for slides and headers |

The lit window is the signal amber `#ffb547`; the tile is the product blue `#2b55d4` (gradient `#3a63e6` to `#2346c0`); ink is `#0e1622`.
Keep clear space around the mark equal to the window's height. Below 20px, use the version with a single crossbar (the app does this automatically).

To use your own logo instead, set `LOGO_SVG` or `LOGO_SRC` in `apps/status/src/brand.tsx`.
