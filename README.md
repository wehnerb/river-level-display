# River Level Display

A Cloudflare Worker that fetches live river gauge data from the NOAA NWPS public API and returns a self-contained HTML page with a canvas-rendered hydrograph. Designed as a single endpoint URL for fire station display screens.

## 📄 System Documentation
Full documentation (architecture, setup, account transfer, IT reference): https://github.com/wehnerb/ffd-display-system-documentation

---

## Live URLs

| Environment | URL |
|---|---|
| Production | `https://river-level-display.bwehner.workers.dev/` |
| Staging | `https://river-level-display-staging.bwehner.workers.dev/` |

---

## URL Parameters

| Parameter | Default | Options |
|---|---|---|
| `?gauge=` | `fargo` | Any key from `GAUGES` in `src/index.js` |
| `?layout=` | `split` | `full`, `wide`, `split`, `tri` |

| Layout | Width | Height |
|---|---|---|
| `full` | 1920px | 1075px |
| `wide` | 1735px | 720px |
| `split` | 852px | 720px |
| `tri` | 558px | 720px |

---

## Configuration (`src/index.js`)

| Constant | Default | Description |
|---|---|---|
| `GAUGES` | See code | Gauge registry — add new gauges here |
| `DEFAULT_GAUGE` | `'fargo'` | Gauge used when no `?gauge=` parameter is provided |
| `OBSERVED_HOURS` | `120` | Hours of observed history to display |
| `CACHE_SECONDS` | `900` | Cloudflare cache TTL (15 min) |
| `Y_AXIS_PADDING` | `1.5` | Feet of padding above/below data range |
| `THRESHOLD_LOOKAHEAD_FT` | `3.0` | Show flood threshold lines only when within this many feet of data max |
| `CREST_MIN_FLANK_POINTS` | `4` | Data points required on each side of peak to label a crest |
| `CREST_MIN_PROMINENCE_FT` | `0.5` | Minimum rise in feet for a valid crest label |

### Adding a New Gauge

1. Find the NOAA gauge ID at [water.noaa.gov](https://water.noaa.gov) (e.g. `FGON8`)
2. Edit `src/index.js` on the `staging` branch and add an entry to `GAUGES`:
```javascript
   'your-key': { id: 'NWSID', name: 'Human-readable name' },
```
3. Test at the staging URL with `?gauge=your-key`, then merge to `main`

---

## Secrets

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token — Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

No Google credentials needed — the NOAA API is fully public.

---

## Deployment

| Branch | Deploys To | Purpose |
|---|---|---|
| `staging` | `river-level-display-staging.bwehner.workers.dev` | Testing |
| `main` | `river-level-display.bwehner.workers.dev` | Production |

Push to either branch — GitHub Actions deploys automatically (~30–45 sec).  
**Always stage and test before merging to main.**  
To roll back: use the Cloudflare dashboard **Deployments** tab, then revert the commit on `main`.
