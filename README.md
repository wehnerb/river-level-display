# River Level Display

A Cloudflare Worker that fetches live river gauge data from the NOAA NWPS public API and returns a self-contained HTML page with a canvas-rendered hydrograph. Designed as a single endpoint URL for fire station display screens that cannot run local scripts or be configured beyond a URL.

---

## What It Does

When a display screen loads the Worker URL, the Worker:

1. Fetches gauge metadata and stage/forecast data from the NOAA NWPS API (no authentication required)
2. Processes and trims the data server-side — no further API calls are made by the browser
3. Injects the data as a JSON literal into a self-contained HTML page
4. Returns the page sized to exact pixel dimensions for the requested display layout

The page auto-refreshes every 15 minutes, matching the NOAA data update cycle.

---

## Endpoints

| Environment | URL |
|---|---|
| Production | `https://river-level-display.bwehner.workers.dev/` |
| Staging | `https://river-level-display-staging.bwehner.workers.dev/` |

---

## URL Parameters

| Parameter | Default | Options | Description |
|---|---|---|---|
| `gauge` | `fargo` | Any key from `GAUGES` | Which river gauge to display |
| `layout` | `split` | `wide`, `split`, `tri`, `full` | Display column width |

### Layout Dimensions

| Key | Width (px) | Height (px) | Use Case |
|---|---|---|---|
| `wide` | 1735 | 720 | Full-width single column |
| `split` | 852 | 720 | Two-column display (default) |
| `tri` | 558 | 720 | Three-column display |
| `full` | 1920 | 1075 | Full-screen display |

### Example URLs

```
# Default — Red River, two-column layout
https://river-level-display.bwehner.workers.dev/

# Three-column layout
https://river-level-display.bwehner.workers.dev/?layout=tri

# Full-screen layout
https://river-level-display.bwehner.workers.dev/?layout=full
```

---

## Chart Features

- **Observed line** — 72 hours of recorded stage with a gradient fill
- **Forecast line** — NWS official forecast shown as a dashed amber line
- **Flood thresholds** — Action / Minor / Moderate / Major lines, shown only when within 3 ft of the data maximum to avoid clutter at normal river levels
- **Crest marker** — Diamond + label when the river has peaked and the descent is confirmed by at least 4 data points (~2 hours) on each side
- **NOW marker** — Vertical dashed line marking current time
- **Flood status badge** — Color-coded header badge: Normal / Action / Minor / Moderate / Major
- **Adaptive X-axis** — Label interval and format adjust automatically to chart width
- **Error recovery** — If the NOAA API is unavailable, returns an error page that retries every 60 seconds

---

## Configuration

All tunable values are at the top of `src/index.js`. No other part of the file needs editing for routine operation.

```javascript
// Gauge registry — add new gauges here
const GAUGES = {
  'fargo': { id: 'FGON8', name: 'Red River at Fargo' },
  // 'moorhead': { id: 'MHDN8', name: 'Red River at Moorhead' },
};
const DEFAULT_GAUGE = 'fargo';

const OBSERVED_HOURS          = 72;    // hours of history to show
const CACHE_SECONDS           = 900;   // Cloudflare cache TTL (15 min)
const Y_AXIS_PADDING          = 1.5;   // ft of padding above/below data range
const THRESHOLD_LOOKAHEAD_FT  = 3.0;   // show threshold only if within this many ft of data max
const CREST_MIN_FLANK_POINTS  = 4;     // data points required on each side of peak
const CREST_MIN_PROMINENCE_FT = 0.5;   // minimum ft rise for a valid crest label
```

### Adding a New Gauge

1. Find the NOAA gauge ID at [water.noaa.gov](https://water.noaa.gov) (the 4–5 character code in the URL, e.g. `FGON8`)
2. Open the `staging` branch in GitHub
3. Edit `src/index.js` and add an entry to `GAUGES`:
   ```javascript
   'your-key': { id: 'NWSID', name: 'Human-readable name' },
   ```
4. Commit to `staging`, test at the staging URL with `?gauge=your-key`
5. Merge to `main` once confirmed working

---

## Data Source

All data comes from the **NOAA National Water Prediction Service (NWPS)** public API — no API key or account required.

| Call | Endpoint |
|---|---|
| Gauge metadata + flood thresholds | `GET https://api.water.noaa.gov/nwps/v1/gauges/{id}` |
| Observed + forecast stage data | `GET https://api.water.noaa.gov/nwps/v1/gauges/{id}/stageflow` |

NOAA updates gauge data approximately every 30 minutes. The Worker caches its response for 15 minutes (`CACHE_SECONDS = 900`), so all display screens receive cached responses rather than each triggering a new upstream API call.

---

## Deployment

Deployment is handled automatically by GitHub Actions on push to either branch.

| Branch | Deploys To | Purpose |
|---|---|---|
| `staging` | `river-level-display-staging.bwehner.workers.dev` | Test before production |
| `main` | `river-level-display.bwehner.workers.dev` | Live production |

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

No Google credentials are needed — the NOAA API is fully public.

### Wrangler Config

See `wrangler.toml` for environment definitions. Staging and production are configured as separate named environments targeting their respective Worker names.

---

## File Structure

```
river-level-display/
├── src/
│   └── index.js          # Worker — all logic, configuration, and HTML rendering
├── wrangler.toml          # Cloudflare Workers configuration
└── .github/
    └── workflows/
        └── deploy.yml    # GitHub Actions deploy on push to staging / main
```

---

## Related Projects

This Worker is part of the Fargo Fire Department station display board system. Related repositories:

- [`station-image-proxy`](https://github.com/wehnerb/station-image-proxy) — Resizes and caches traffic camera and river gauge images for display screens
- [`slide-timing-proxy`](https://github.com/wehnerb/slide-timing-proxy) — Dynamically calculates Google Slides per-slide timing and handles pre-fetch delay

Layout pixel dimensions (`wide`, `split`, `tri`, `full`) are shared across all three projects and must remain in sync.
