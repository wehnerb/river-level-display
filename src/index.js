// ============================================================
// river-level-display  -  src/index.js
//
// Fetches Red River gauge data from the NOAA NWPS public API
// and returns a self-contained HTML page containing a canvas-
// rendered hydrograph.  The page is designed for use as a
// single endpoint URL on station display screens and requires
// no client-side API calls -- all data is fetched server-side
// by the Worker and injected into the HTML before delivery.
//
// URL parameters:
//   ?gauge=   fargo              (default: fargo)
//   ?layout=  wide | split | tri | full   (default: split)
//
// NOAA NWPS API (no authentication required):
//   Metadata  : GET /nwps/v1/gauges/{id}
//   Stage data: GET /nwps/v1/gauges/{id}/stageflow
// ============================================================


// ============================================================
// CONFIGURATION  --  edit these values as needed
// ============================================================

// Gauge registry.  Maps URL-friendly key names to their NOAA gauge
// identifier and a human-readable display name.
// To add a new gauge, add a new entry following the existing format.
// The key is what callers pass as the ?gauge= URL parameter.
const GAUGES = {
  'fargo': { id: 'FGON8', name: 'Red River at Fargo' },
  // Example for a future gauge:
  // 'moorhead': { id: 'MHDN8', name: 'Red River at Moorhead' },
};
const DEFAULT_GAUGE = 'fargo';

// NOAA NWPS API base URL (no trailing slash)
const NOAA_BASE = 'https://api.water.noaa.gov/nwps/v1';

// How many hours of observed history to show on the chart.
// Combined with any available NWS forecast data.
const OBSERVED_HOURS = 120;

// How long (seconds) Cloudflare caches the Worker's response.
// NOAA updates gauge data every 30 minutes, so 15 minutes
// provides fresh data without hammering the upstream API.
const CACHE_SECONDS = 900;

// Padding added above and below the data range on the Y axis (feet).
// Keeps data points off the very edge of the chart.
const Y_AXIS_PADDING = 1.5;

// How many feet above the current data maximum a flood threshold
// line must be before it is hidden from the chart.  Thresholds
// closer than this distance will appear, giving a "lookahead"
// that shows what is coming as the river rises.
const THRESHOLD_LOOKAHEAD_FT = 3.0;

// Crest detection settings.
// A crest is labeled when the river rises to a peak and is
// confirmed to be falling on the other side.
//
// CREST_MIN_FLANK_POINTS: Number of data points required on each
//   side of the peak.  At NOAA's 30-min observation interval, 4
//   points represents ~2 hours of trend confirmation on each side.
//
// CREST_MIN_PROMINENCE_FT: The peak must be at least this many
//   feet above the average of the flank points on each side.
//   Prevents labeling noise or essentially flat conditions as a
//   crest.  0.5 ft filters trivial bumps while catching real events.
const CREST_MIN_FLANK_POINTS  = 4;
const CREST_MIN_PROMINENCE_FT = 0.5;

// Plausible stage range (feet).  Any reading outside this range is
// treated as a sentinel / fill value and discarded before charting.
// NOAA uses -9999 to indicate a missing or invalid reading; without
// this filter those values corrupt the Y-axis scale entirely.
// The bounds below are intentionally generous to accommodate any
// future gauges added to the GAUGES registry.
const STAGE_PLAUSIBLE_MIN = -20;   // below datum is possible but rare
const STAGE_PLAUSIBLE_MAX = 150;   // well above any realistic flood stage

// Layout pixel dimensions.  These match the station display
// column widths defined in the station-image-proxy project.
const LAYOUTS = {
  wide:  { width: 1735, height: 720  },  // full-width single column
  split: { width: 852,  height: 720  },  // two-column display (default)
  tri:   { width: 558,  height: 720  },  // three-column display
  full:  { width: 1920, height: 1075 },  // full-screen display
};
const DEFAULT_LAYOUT = 'split';

// Timezone used for all X-axis date/time labels
const DISPLAY_TZ = 'America/Chicago';

// Background color used when ?bg=dark is set.
// Matches the probationary-firefighter-display dark testing background.
const DARK_BG_COLOR = '#111111';


// ============================================================
// FLOOD THRESHOLD COLORS
// These colors match NOAA's standard flood category palette.
// ============================================================
const FLOOD_COLORS = {
  action:   '#ffdd00',  // Yellow
  minor:    '#ff9900',  // Orange
  moderate: '#ff4400',  // Red-orange
  major:    '#cc0000',  // Red
};


// ============================================================
// MAIN REQUEST HANDLER
// ============================================================
export default {
  async fetch(request, env, ctx) {
    try {
      // ----------------------------------------------------------
      // 0. Method filter — reject anything that is not a GET request.
      // All valid display screen requests are GET. Any other method
      // (POST, PUT, DELETE, etc.) is rejected immediately before any
      // processing occurs.
      // ----------------------------------------------------------
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET' } });
      }

      // ----------------------------------------------------------
      // 1. Parse URL parameters: ?gauge= and ?layout=
      // ----------------------------------------------------------
      const url = new URL(request.url);

      // Resolve the gauge from ?gauge=, falling back to DEFAULT_GAUGE
      // if the parameter is missing or not found in the registry.
      const gaugeParam = url.searchParams.get('gauge');
      const gaugeKey   = (gaugeParam && GAUGES[gaugeParam]) ? gaugeParam : DEFAULT_GAUGE;
      const gauge      = GAUGES[gaugeKey];

      // Resolve the layout from ?layout=, falling back to DEFAULT_LAYOUT.
      const layoutParam = url.searchParams.get('layout');
      const layoutKey   = (layoutParam && LAYOUTS[layoutParam])
        ? layoutParam
        : DEFAULT_LAYOUT;
      const layout = LAYOUTS[layoutKey];

      // ?bg=dark renders with a solid dark background for browser-based testing.
      // Matches the probationary-firefighter-display ?bg=dark parameter behaviour.
      const darkBg = url.searchParams.get('bg') === 'dark';

      // ----------------------------------------------------------
      // 2. Fetch gauge metadata and stage/flow time series
      //    in parallel to minimise latency.
      //    cf.cacheTtl instructs Cloudflare's edge cache to store
      //    the upstream response, reducing NOAA API calls.
      // ----------------------------------------------------------
      const fetchOpts = {
        headers: {
          // Identify the client to NOAA per their API guidance
          'User-Agent': 'FargoFireDept-StationDisplay/1.0',
        },
        cf: { cacheTtl: CACHE_SECONDS },
      };

      const [metaRes, stageRes] = await Promise.all([
        fetch(NOAA_BASE + '/gauges/' + gauge.id, fetchOpts),
        fetch(NOAA_BASE + '/gauges/' + gauge.id + '/stageflow', fetchOpts),
      ]);

      // Parse both JSON responses
      const [meta, stageflow] = await Promise.all([
        metaRes.json(),
        stageRes.json(),
      ]);

      // ----------------------------------------------------------
      // 3. Extract flood stage thresholds from gauge metadata.
      //    Nested paths are accessed defensively with optional
      //    chaining so a missing field never throws.
      // ----------------------------------------------------------
      const cats = meta?.flood?.categories ?? {};
      const thresholds = {
        action:   cats.action?.stage   ?? null,
        minor:    cats.minor?.stage    ?? null,
        moderate: cats.moderate?.stage ?? null,
        major:    cats.major?.stage    ?? null,
      };

      // ----------------------------------------------------------
      // 4. Filter observed data to the last OBSERVED_HOURS window.
      //    Each element from the API has shape:
      //      { validTime: "2025-03-10T14:00:00Z", primary: 12.34 }
      //    where `primary` is stage in feet.
      //
      //    Values outside STAGE_PLAUSIBLE_MIN/MAX are discarded.
      //    NOAA uses -9999 as a sentinel for missing readings; without
      //    this check those values corrupt the Y-axis scale entirely.
      // ----------------------------------------------------------
      const now = Date.now();
      const observedCutoff = now - OBSERVED_HOURS * 60 * 60 * 1000;

      const observed = (stageflow?.observed?.data ?? [])
        .filter(d => d.primary !== null && d.primary !== undefined)
        .map(d => ({
          t: new Date(d.validTime).getTime(),
          v: parseFloat(d.primary),
        }))
        .filter(d =>
          !isNaN(d.t) && !isNaN(d.v) &&
          d.t >= observedCutoff &&
          d.v >= STAGE_PLAUSIBLE_MIN && d.v <= STAGE_PLAUSIBLE_MAX
        )
        .sort((a, b) => a.t - b.t);

      // ----------------------------------------------------------
      // 5. Extract NWS forecast data (future timestamps only).
      //    Same plausibility filter applied as for observed data.
      // ----------------------------------------------------------
      const forecast = (stageflow?.forecast?.data ?? [])
        .filter(d => d.primary !== null && d.primary !== undefined)
        .map(d => ({
          t: new Date(d.validTime).getTime(),
          v: parseFloat(d.primary),
        }))
        .filter(d =>
          !isNaN(d.t) && !isNaN(d.v) &&
          d.t > now &&
          d.v >= STAGE_PLAUSIBLE_MIN && d.v <= STAGE_PLAUSIBLE_MAX
        )
        .sort((a, b) => a.t - b.t);

      // ----------------------------------------------------------
      // 6. Derive summary values for the header display
      // ----------------------------------------------------------

      // Current stage = most recent observed reading
      const currentStage = observed.length > 0
        ? observed[observed.length - 1].v
        : null;

      // Human-readable timestamp of the most recent observation
      const lastUpdated = observed.length > 0
        ? new Date(observed[observed.length - 1].t).toLocaleString('en-US', {
            timeZone: DISPLAY_TZ,
            month:    'short',
            day:      'numeric',
            hour:     'numeric',
            minute:   '2-digit',
            hour12:   true,
          }) + ' CT'
        : 'Unavailable';

      // Flood status badge text and color
      const floodStatus = getFloodStatus(currentStage, thresholds);

      // ----------------------------------------------------------
      // 7. Detect crest in the combined observed + forecast series.
      //    Returns null if no confirmed crest is present, or an
      //    object { t, v, timeLabel } if one is found.
      //    The combined series is sorted by time before passing in.
      // ----------------------------------------------------------
      const combined = observed
        .concat(forecast)
        .sort((a, b) => a.t - b.t);

      const crestPoint = findCrest(combined);
      const crest = crestPoint
        ? {
            t: crestPoint.t,
            v: crestPoint.v,
            timeLabel: new Date(crestPoint.t).toLocaleString('en-US', {
              timeZone: DISPLAY_TZ,
              weekday: 'short',
              month:   'short',
              day:     'numeric',
              hour:    'numeric',
              minute:  '2-digit',
              hour12:  true,
            }) + ' CT',
          }
        : null;

      // ----------------------------------------------------------
      // 8. Build the data payload that will be injected into the
      //    HTML page as a JSON literal.  The client-side canvas
      //    renderer reads this object directly -- no further API
      //    calls are made from the browser.
      // ----------------------------------------------------------
      const chartData = {
        observed,
        forecast,
        thresholds,
        currentStage,
        lastUpdated,
        floodStatus,
        gaugeName: gauge.name,
        gaugeId:   gauge.id,
        crest,
        nowMs: now,
      };

      // ----------------------------------------------------------
      // 9. Render and return the HTML page
      // ----------------------------------------------------------
      const html = buildHtml(layout, layoutKey, chartData, darkBg);

      return new Response(html, {
        headers: {
          'Content-Type':            'text/html; charset=utf-8',
          // Do NOT cache the rendered HTML page in the browser or at the
          // Cloudflare edge.  The meta refresh tag fires every CACHE_SECONDS;
          // if the browser served a cached copy on refresh instead of making
          // a real network request, the displayed data would never update.
          // The upstream NOAA fetch is separately cached by Cloudflare via
          // cf.cacheTtl in fetchOpts, so NOAA API load is still controlled.
          'Cache-Control':           'no-store',
          'X-Content-Type-Options':  'nosniff',
          'Referrer-Policy':         'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';",
        },
      });

    } catch (err) {
      // Return a styled error page rather than a raw 500 response.
      // The page auto-refreshes every 60 seconds so it will recover
      // as soon as the upstream API becomes available again.
      return new Response(buildErrorHtml(), {
        status: 200, // Return 200 so the display does not blank out
        headers: {
          'Content-Type':            'text/html; charset=utf-8',
          'X-Content-Type-Options':  'nosniff',
          'Referrer-Policy':         'no-referrer',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline';",
        },
      });
    }
  },
};


// ============================================================
// HELPER: Determine flood status from current stage
// Returns an object: { label: string, color: hex string }
// ============================================================
function getFloodStatus(stage, thresholds) {
  if (stage === null)
    return { label: 'NO DATA',        color: '#888888' };
  if (thresholds.major    !== null && stage >= thresholds.major)
    return { label: 'MAJOR FLOOD',    color: FLOOD_COLORS.major };
  if (thresholds.moderate !== null && stage >= thresholds.moderate)
    return { label: 'MODERATE FLOOD', color: FLOOD_COLORS.moderate };
  if (thresholds.minor    !== null && stage >= thresholds.minor)
    return { label: 'MINOR FLOOD',    color: FLOOD_COLORS.minor };
  if (thresholds.action   !== null && stage >= thresholds.action)
    return { label: 'ACTION STAGE',   color: FLOOD_COLORS.action };
  return   { label: 'NORMAL',         color: '#22aa55' };
}


// ============================================================
// HELPER: Detect a confirmed crest in a time-sorted array of
// { t, v } points.
//
// A crest is only labeled when both conditions hold:
//   1. The peak has at least CREST_MIN_FLANK_POINTS data points
//      on each side (guarantees a trend is visible, not noise).
//   2. The peak value exceeds the average of those flanking points
//      by at least CREST_MIN_PROMINENCE_FT on both sides (confirms
//      the river was genuinely rising before and falling after).
//
// Returns the { t, v } point of the crest, or null if no confirmed
// crest exists.  Null is the expected result during a steady rise
// (no falling tail yet) or during normal low-water conditions.
// ============================================================
function findCrest(combined) {
  const n     = combined.length;
  const flank = CREST_MIN_FLANK_POINTS;

  // Need enough total points to have a meaningful flank on each side
  if (n < flank * 2 + 1) return null;

  // Find the index of the global maximum value
  let maxIdx = 0;
  for (let i = 1; i < n; i++) {
    if (combined[i].v > combined[maxIdx].v) maxIdx = i;
  }

  // The peak must not be at or too close to either end of the series
  if (maxIdx < flank || maxIdx > n - flank - 1) return null;

  // Compare the peak against the average of the FIRST and LAST flank
  // points in the entire series -- not the adjacent points.
  //
  // Rivers crest gradually: the 4 points immediately beside a peak
  // are nearly as high as the peak itself (e.g. 32.49 vs 32.50 ft),
  // so an adjacent-point comparison would never clear the prominence
  // threshold.  Using the series start/end correctly measures whether
  // the river genuinely rose to a peak and is falling back down.
  let beforeSum = 0;
  for (let i = 0; i < flank; i++) {
    beforeSum += combined[i].v;
  }
  const beforeAvg = beforeSum / flank;

  let afterSum = 0;
  for (let i = n - flank; i < n; i++) {
    afterSum += combined[i].v;
  }
  const afterAvg = afterSum / flank;

  const crestVal = combined[maxIdx].v;

  // Both the series start and series end must be significantly below
  // the peak.  This confirms: (a) the river was rising before the
  // crest, and (b) it is falling after -- the two conditions that
  // define a genuine crest rather than a plateau or still-rising event.
  if (crestVal - beforeAvg < CREST_MIN_PROMINENCE_FT) return null;
  if (crestVal - afterAvg  < CREST_MIN_PROMINENCE_FT) return null;

  return combined[maxIdx];
}


// ============================================================
// HELPER: Build the complete self-contained HTML page.
//
// All data is embedded as a JSON literal inside the <script>
// block.  The chart is rendered onto a <canvas> element using
// vanilla JavaScript with no external dependencies.
// ============================================================


// ============================================================
// HELPER: Escape characters with special meaning in HTML.
// Applied to all NOAA API strings injected into the HTML header
// to prevent unexpected rendering if the API returns unusual text.
// ============================================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}


// ============================================================
// BUILD HTML PAGE
//
// Renders a complete self-contained HTML page for the river level
// display.  The page has two sections:
//
//   1.  Header card  (HTML) — gauge name, current stage, flood badge,
//       and last-updated timestamp. Built server-side from the data
//       object so no client-side DOM manipulation is needed for chrome.
//
//   2.  Chart card   (HTML + Canvas) — the hydrograph canvas sits
//       inside a styled card container; a legend strip at the bottom
//       of the card is also plain HTML.  Only the chart drawing itself
//       (axes, grid, threshold lines, data lines, crest marker) uses
//       the Canvas 2D API.
//
// The original single full-page canvas approach drew everything
// (header, chart, legend) in canvas, which prevented CSS-based
// styling.  The new split approach lets the header and legend
// participate in the shared design language (transparent cards,
// white-tinted surfaces, consistent font) while the chart maths
// remain unchanged inside the IIFE.
// ============================================================
function buildHtml(layout, layoutKey, data, darkBg) {

  // Derived layout flags
  const isNarrow = layout.width <= 558;
  const isWide   = layout.width >= 1735;
  const isFull   = layoutKey === 'full';

  // ----------------------------------------------------------
  // Layout dimensions
  // ----------------------------------------------------------
  // Outer padding applied on all four sides of the page.
  const pagePad = 8;
  // Vertical gap between the header card and the chart card.
  const gapH    = 8;
  // Header card height — proportional to layout height so it scales
  // sensibly across the four display sizes.
  const hdrH    = Math.floor(layout.height * 0.135);
  // Legend strip height at the bottom of the chart card.
  const legendH = Math.floor(layout.height * 0.052);

  // Canvas dimensions.
  // canvasW fills the page minus outer padding on each side.
  // canvasH = total height
  //         − outer padding (top + bottom)
  //         − header card height
  //         − 2px (header card top + bottom border)
  //         − gap between cards
  //         − 2px (chart card top + bottom border)
  //         − legend strip height
  const canvasW = layout.width  - pagePad * 2;
  const canvasH = layout.height - (pagePad * 2) - hdrH - 4 - gapH - legendH;

  // ----------------------------------------------------------
  // Header font sizes — proportional to header height
  // ----------------------------------------------------------
  const stageFont  = isNarrow ? 28 : isWide ? 54 : 40;
  const nameFont   = isNarrow ? 14 : isWide ? 24 : 18;
  const subFont    = Math.floor(nameFont * 0.72);
  const metaFont   = Math.floor(nameFont * 0.65);
  const badgeFont  = isNarrow ? 10 : isWide ? 16 : 12;
  const legendFont = Math.max(10, Math.floor(legendH * 0.38));

  // ----------------------------------------------------------
  // Header data values
  // ----------------------------------------------------------
  const stageColor = data.floodStatus ? data.floodStatus.color : '#888888';
  const stageLabel = data.floodStatus ? escapeHtml(data.floodStatus.label) : 'NO DATA';
  // Split stage number from units so the unit can be styled smaller.
  const stageVal   = (data.currentStage !== null && data.currentStage !== undefined)
    ? escapeHtml(data.currentStage.toFixed(2))
    : '--';

  // ----------------------------------------------------------
  // Safe JSON for client-side chart injection
  // ----------------------------------------------------------
  // Unicode-escape <, >, and & so the JSON is safe inside a <script> block.
  const dataJson = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  // ----------------------------------------------------------
  // Legend HTML (server-side; Forecast and Crest are conditional)
  // ----------------------------------------------------------
  const obsLegend =
    '<div class="legend-item">' +
    '<svg width="24" height="10" style="flex-shrink:0;display:block;">' +
    '<line x1="0" y1="5" x2="24" y2="5" stroke="#4488ff" stroke-width="2.5"/>' +
    '</svg>' +
    'Observed</div>';

  const fcLegend = (data.forecast && data.forecast.length > 0)
    ? '<div class="legend-item">' +
      '<svg width="24" height="10" style="flex-shrink:0;display:block;">' +
      '<line x1="0" y1="5" x2="24" y2="5" stroke="#ffaa22" stroke-width="2" stroke-dasharray="5,3"/>' +
      '</svg>' +
      'NWS Forecast</div>'
    : '';

  const crestLegend = (data.crest !== null && data.crest !== undefined)
    ? '<div class="legend-item">' +
      '<svg width="10" height="10" viewBox="0 0 10 10" style="flex-shrink:0;display:block;">' +
      '<polygon points="5,0 10,5 5,10 0,5" fill="#ff66ff"/>' +
      '</svg>' +
      'Crest</div>'
    : '';

  // ----------------------------------------------------------
  // CSS
  // ----------------------------------------------------------
  const css =
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: '    + layout.width  + 'px;' +
    '  height: '   + layout.height + 'px;' +
    '  overflow: hidden;' +
    // full layout fills the screen and needs a solid background;
    // all other layouts are transparent so hardware texture shows through.
    // ?bg=dark overrides to a solid background for browser-based testing.
    '  background: ' + (darkBg || isFull ? DARK_BG_COLOR : 'transparent') + ';' +
    '  font-family: "Segoe UI", Arial, Helvetica, sans-serif;' +
    '  color: rgba(255,255,255,0.92);' +
    '}' +

    // Outer flex column containing the two cards.
    '.outer {' +
    '  width: '   + layout.width  + 'px;' +
    '  height: '  + layout.height + 'px;' +
    '  padding: ' + pagePad + 'px;' +
    '  display: flex; flex-direction: column;' +
    '  gap: '     + gapH + 'px;' +
    '}' +

    // Header card — station name, stage, and flood badge.
    '.header-card {' +
    '  background: rgba(255,255,255,0.10);' +
    '  border: 1px solid rgba(255,255,255,0.10);' +
    '  border-radius: 6px;' +
    '  height: '  + hdrH + 'px;' +
    '  padding: 0 ' + Math.floor(hdrH * 0.16) + 'px;' +
    '  display: flex; flex-direction: row; align-items: center;' +
    '  flex-shrink: 0;' +
    '  gap: '     + Math.floor(hdrH * 0.20) + 'px;' +
    '}' +

    // Left side of header — gauge sub-label, name, last updated.
    '.hdr-info { flex: 1; min-width: 0; }' +
    '.hdr-sub {' +
    '  font-size: '    + subFont + 'px;' +
    '  color: rgba(255,255,255,0.68);' +
    '  text-transform: uppercase; letter-spacing: 0.10em;' +
    '  margin-bottom: ' + Math.floor(subFont * 0.3) + 'px;' +
    '}' +
    '.hdr-name {' +
    '  font-size: '    + nameFont + 'px;' +
    '  font-weight: 700; color: #ffffff;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.hdr-meta {' +
    '  font-size: '    + metaFont + 'px;' +
    '  color: rgba(255,255,255,0.38);' +
    '  margin-top: '   + Math.floor(metaFont * 0.3) + 'px;' +
    '}' +

    // Centre of header — the large stage number.
    '.hdr-stage { text-align: center; flex-shrink: 0; }' +
    '.hdr-stage-lbl {' +
    '  font-size: '    + subFont + 'px;' +
    '  color: rgba(255,255,255,0.68);' +
    '  text-transform: uppercase; letter-spacing: 0.08em;' +
    '  margin-bottom: 2px;' +
    '}' +
    '.hdr-stage-val {' +
    '  font-size: '    + stageFont + 'px;' +
    '  font-weight: 700; line-height: 1;' +
    '}' +
    '.hdr-stage-unit {' +
    '  font-size: '    + Math.floor(stageFont * 0.45) + 'px;' +
    '  color: rgba(255,255,255,0.45);' +
    '  margin-left: 3px;' +
    '}' +

    // Right side of header — flood status badge.
    '.hdr-badge {' +
    '  font-weight: 700;' +
    '  font-size: '    + badgeFont + 'px;' +
    '  letter-spacing: 0.08em;' +
    '  padding: '      + Math.floor(hdrH * 0.08) + 'px ' + Math.floor(hdrH * 0.18) + 'px;' +
    '  border-radius: 4px;' +
    '  white-space: nowrap; flex-shrink: 0;' +
    '}' +

    // Chart card — white-tinted container for the canvas and legend.
    '.chart-card {' +
    '  background: rgba(255,255,255,0.06);' +
    '  border: 1px solid rgba(255,255,255,0.10);' +
    '  border-radius: 6px;' +
    '  flex: 1; min-height: 0;' +
    '  display: flex; flex-direction: column;' +
    '  overflow: hidden;' +
    '}' +

    // Canvas sits at the top of the chart card; legend strip below.
    'canvas { display: block; flex-shrink: 0; }' +

    // Legend strip — HTML row of labelled line/symbol samples.
    '.legend {' +
    '  border-top: 1px solid rgba(255,255,255,0.10);' +
    '  display: flex; flex-direction: row; align-items: center;' +
    '  gap: '      + Math.floor(legendH * 0.50) + 'px;' +
    '  padding: 0 ' + Math.floor(legendH * 0.40) + 'px;' +
    '  height: '   + legendH + 'px;' +
    '  font-size: ' + legendFont + 'px;' +
    '  color: rgba(255,255,255,0.68);' +
    '  flex-shrink: 0;' +
    '}' +
    '.legend-item { display: flex; align-items: center; gap: 6px; }';

  // ----------------------------------------------------------
  // HTML body structure
  // ----------------------------------------------------------
  const body =
    '<div class="outer">' +

      '<div class="header-card">' +
        '<div class="hdr-info">' +
          '<div class="hdr-sub">NOAA Gauge &middot; ' + escapeHtml(data.gaugeId || '') + '</div>' +
          '<div class="hdr-name">' + escapeHtml(data.gaugeName || '') + '</div>' +
          '<div class="hdr-meta">Updated: ' + escapeHtml(data.lastUpdated || '') + '</div>' +
        '</div>' +
        '<div class="hdr-stage">' +
          '<div class="hdr-stage-lbl">River Stage</div>' +
          '<div class="hdr-stage-val" style="color:' + stageColor + '">' +
            stageVal +
            '<span class="hdr-stage-unit">ft</span>' +
          '</div>' +
        '</div>' +
        '<div class="hdr-badge" style="background:' + stageColor + ';color:#000000">' +
          stageLabel +
        '</div>' +
      '</div>' +

      '<div class="chart-card">' +
        '<canvas id="c" width="' + canvasW + '" height="' + canvasH + '"></canvas>' +
        '<div class="legend">' + obsLegend + fcLegend + crestLegend + '</div>' +
      '</div>' +

    '</div>';

  // ----------------------------------------------------------
  // Client-side chart script (IIFE)
  // The header and legend are now HTML; the IIFE only draws
  // the chart area: background, axes, grid, threshold lines,
  // data lines, "NOW" marker, and crest marker.
  // ----------------------------------------------------------
  const script =
    '(function() {' +

    // Data injected by the Worker — full chart payload as a JS literal.
    'var DATA = ' + dataJson + ';' +

    // Layout constants injected from server-side configuration.
    // W and H now refer to the canvas element dimensions, not the full page.
    'var W         = ' + canvasW  + ';' +
    'var H         = ' + canvasH  + ';' +
    'var IS_NARROW = ' + isNarrow + ';' +
    'var IS_WIDE   = ' + isWide   + ';' +
    'var Y_PAD     = ' + Y_AXIS_PADDING          + ';' +
    'var LOOKAHEAD = ' + THRESHOLD_LOOKAHEAD_FT  + ';' +

    // Crest marker colour — violet, distinct from all flood/line colours.
    'var CREST_COLOR = "#ff66ff";' +

    // Flood threshold colour map — matches NOAA standard palette.
    'var FLOOD_COLORS = {' +
    '  action:   "' + FLOOD_COLORS.action   + '",' +
    '  minor:    "' + FLOOD_COLORS.minor    + '",' +
    '  moderate: "' + FLOOD_COLORS.moderate + '",' +
    '  major:    "' + FLOOD_COLORS.major    + '"' +
    '};' +

    'var canvas = document.getElementById("c");' +
    'var ctx    = canvas.getContext("2d");' +

    // ============================================================
    // DRAW CHART — entry point.
    // The canvas is sized to the chart area only (no header offset).
    // ============================================================
    'function drawChart() {' +
    '  var baseFont  = IS_NARROW ? 12 : IS_WIDE ? 18 : 15;' +
    '  var labelFont = IS_NARROW ? 11 : IS_WIDE ? 14 : 13;' +
    // Small top padding within the canvas so the first grid line
    // does not sit flush against the card edge.
    '  var chartTop    = 6;' +
    '  var xLabelH     = IS_NARROW ? 20 : IS_WIDE ? 24 : 22;' +
    '  var chartBottom = H - xLabelH;' +
    // Left margin must be wide enough for Y-axis labels.
    '  var chartLeft   = IS_NARROW ? 44 : IS_WIDE ? 68 : 58;' +
    '  var chartRight  = W - (IS_NARROW ? 8 : IS_WIDE ? 16 : 10);' +
    '  drawChartArea(' +
    '    chartLeft, chartTop,' +
    '    chartRight  - chartLeft,' +
    '    chartBottom - chartTop,' +
    '    baseFont, labelFont' +
    '  );' +
    '}' +

    // ============================================================
    // DRAW CHART AREA — axes, grid, threshold lines, data lines,
    // crest marker. Legend is now rendered as HTML below the canvas.
    // ============================================================
    'function drawChartArea(cx, cy, cw, ch, baseFont, labelFont) {' +

    '  var allPoints = DATA.observed.concat(DATA.forecast);' +
    '  if (allPoints.length === 0) {' +
    '    ctx.font = "bold " + baseFont + "px Arial";' +
    '    ctx.fillStyle = "rgba(255,255,255,0.45)";' +
    '    ctx.textAlign = "center";' +
    '    ctx.textBaseline = "middle";' +
    '    ctx.fillText("No gauge data available", cx + Math.round(cw/2), cy + Math.round(ch/2));' +
    '    return;' +
    '  }' +

    '  var vals    = allPoints.map(function(d) { return d.v; });' +
    '  var dataMin = Math.min.apply(null, vals);' +
    '  var dataMax = Math.max.apply(null, vals);' +

    // Determine which flood thresholds fall within the visible range
    // (including a lookahead buffer so approaching thresholds appear).
    '  var visibleThresholds = {};' +
    '  var threshOrder = ["action", "minor", "moderate", "major"];' +
    '  threshOrder.forEach(function(key) {' +
    '    var stage = DATA.thresholds[key];' +
    '    if (stage !== null && stage <= dataMax + LOOKAHEAD) {' +
    '      visibleThresholds[key] = stage;' +
    '      if (stage > dataMax) { dataMax = stage; }' +
    '    }' +
    '  });' +

    '  var yMin = dataMin - Y_PAD;' +
    '  var yMax = dataMax + Y_PAD;' +

    '  var allTimes = allPoints.map(function(d) { return d.t; });' +
    '  var tMin = Math.min.apply(null, allTimes);' +
    '  var tMax = Math.max.apply(null, allTimes);' +
    '  var tBuf = (tMax - tMin) * 0.02;' +
    '  tMin -= tBuf; tMax += tBuf;' +

    // Coordinate transforms
    '  function toY(v) { return cy + ch - ((v - yMin) / (yMax - yMin)) * ch; }' +
    '  function toX(t) { return cx + ((t - tMin) / (tMax - tMin)) * cw; }' +

    // Chart area background — dark semi-transparent fill so the white-tinted
    // card surface is visible at the canvas edges as a subtle frame.
    '  ctx.fillStyle = "rgba(0,0,0,0.50)";' +
    '  ctx.fillRect(cx, cy, cw, ch);' +

    // ----- Y axis: grid lines -----
    '  var yTicks = calcNiceTicks(yMin, yMax, IS_NARROW ? 5 : IS_WIDE ? 9 : 7);' +
    '  ctx.strokeStyle = "rgba(255,255,255,0.10)";' +
    '  ctx.lineWidth = 1;' +
    '  ctx.setLineDash([]);' +
    '  yTicks.forEach(function(tick) {' +
    '    var y = toY(tick);' +
    '    if (y < cy || y > cy + ch) return;' +
    '    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + cw, y); ctx.stroke();' +
    '  });' +

    // ----- Y axis: numeric labels -----
    '  ctx.font = labelFont + "px Arial";' +
    '  ctx.fillStyle = "rgba(255,255,255,0.65)";' +
    '  ctx.textAlign = "right";' +
    '  ctx.textBaseline = "middle";' +
    '  yTicks.forEach(function(tick) {' +
    '    var y = toY(tick);' +
    '    if (y < cy - 4 || y > cy + ch + 4) return;' +
    '    ctx.fillText(tick.toFixed(1), cx - 4, y);' +
    '  });' +

    // ----- Y axis: rotated "Stage (ft)" unit label -----
    '  ctx.save();' +
    '  ctx.translate(cx - (IS_NARROW ? 30 : IS_WIDE ? 54 : 40), cy + Math.round(ch / 2));' +
    '  ctx.rotate(-Math.PI / 2);' +
    '  ctx.font = (IS_NARROW ? 9 : IS_WIDE ? 13 : 10) + "px Arial";' +
    '  ctx.fillStyle = "rgba(255,255,255,0.40)";' +
    '  ctx.textAlign = "center";' +
    '  ctx.textBaseline = "middle";' +
    '  ctx.fillText("Stage (ft)", 0, 0);' +
    '  ctx.restore();' +

    // ----- X axis: grid lines -----
    '  var xTicks = calcAdaptiveTicks(tMin, tMax, cw);' +
    '  ctx.strokeStyle = "rgba(255,255,255,0.10)";' +
    '  ctx.lineWidth = 1;' +
    '  xTicks.forEach(function(tick) {' +
    '    var x = toX(tick.t);' +
    '    if (x < cx || x > cx + cw) return;' +
    '    ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x, cy + ch); ctx.stroke();' +
    '  });' +

    // ----- X axis: date/time labels -----
    '  ctx.font = labelFont + "px Arial";' +
    '  ctx.fillStyle = "rgba(255,255,255,0.65)";' +
    '  ctx.textAlign = "center";' +
    '  ctx.textBaseline = "top";' +
    '  xTicks.forEach(function(tick) {' +
    '    var x = toX(tick.t);' +
    '    if (x < cx + 22 || x > cx + cw - 22) return;' +
    '    ctx.fillText(tick.label, x, cy + ch + 3);' +
    '  });' +

    // ----- Flood threshold lines -----
    '  threshOrder.forEach(function(key) {' +
    '    var stage = visibleThresholds[key];' +
    '    if (stage === undefined) return;' +
    '    var y = toY(stage);' +
    '    if (y < cy || y > cy + ch) return;' +
    '    var color = FLOOD_COLORS[key];' +
    '    ctx.strokeStyle = color;' +
    '    ctx.lineWidth = IS_NARROW ? 1 : IS_WIDE ? 2.5 : 1.5;' +
    '    ctx.setLineDash([6, 4]);' +
    '    ctx.globalAlpha = 0.65;' +
    '    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + cw, y); ctx.stroke();' +
    '    ctx.setLineDash([]); ctx.globalAlpha = 1.0;' +
    '    var lFont = IS_NARROW ? 9 : IS_WIDE ? 12 : 12;' +
    '    ctx.font = lFont + "px Arial";' +
    '    ctx.fillStyle = color;' +
    '    ctx.textAlign = "right";' +
    '    ctx.textBaseline = "bottom";' +
    '    ctx.globalAlpha = 0.8;' +
    '    ctx.fillText(' +
    '      key.charAt(0).toUpperCase() + key.slice(1) + " (" + stage.toFixed(1) + " ft)",' +
    '      cx + cw - 4, y - 2' +
    '    );' +
    '    ctx.globalAlpha = 1.0;' +
    '  });' +

    // ----- "NOW" vertical marker -----
    '  var nowX = toX(DATA.nowMs);' +
    '  if (nowX >= cx && nowX <= cx + cw) {' +
    '    ctx.strokeStyle = "#ffffff";' +
    '    ctx.lineWidth = 1;' +
    '    ctx.globalAlpha = 0.18;' +
    '    ctx.setLineDash([3, 5]);' +
    '    ctx.beginPath(); ctx.moveTo(nowX, cy); ctx.lineTo(nowX, cy + ch); ctx.stroke();' +
    '    ctx.setLineDash([]); ctx.globalAlpha = 1.0;' +
    '    ctx.font = (IS_NARROW ? 8 : 10) + "px Arial";' +
    '    ctx.fillStyle = "#ffffff";' +
    '    ctx.globalAlpha = 0.3;' +
    '    ctx.textAlign = "center";' +
    '    ctx.textBaseline = "top";' +
    '    ctx.fillText("NOW", nowX, cy + 3);' +
    '    ctx.globalAlpha = 1.0;' +
    '  }' +

    // ----- Observed: gradient fill under the line -----
    '  if (DATA.observed.length > 1) {' +
    '    ctx.beginPath();' +
    '    DATA.observed.forEach(function(d, i) {' +
    '      var x = toX(d.t); var y = toY(d.v);' +
    '      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);' +
    '    });' +
    '    ctx.lineTo(toX(DATA.observed[DATA.observed.length - 1].t), cy + ch);' +
    '    ctx.lineTo(toX(DATA.observed[0].t), cy + ch);' +
    '    ctx.closePath();' +
    '    var grad = ctx.createLinearGradient(0, cy, 0, cy + ch);' +
    '    grad.addColorStop(0, "rgba(50, 110, 220, 0.32)");' +
    '    grad.addColorStop(1, "rgba(50, 110, 220, 0.02)");' +
    '    ctx.fillStyle = grad;' +
    '    ctx.fill();' +
    '  }' +

    // ----- Observed: solid blue line -----
    '  if (DATA.observed.length > 1) {' +
    '    ctx.beginPath();' +
    '    DATA.observed.forEach(function(d, i) {' +
    '      var x = toX(d.t); var y = toY(d.v);' +
    '      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);' +
    '    });' +
    '    ctx.strokeStyle = "#4488ff";' +
    '    ctx.lineWidth = IS_NARROW ? 1.5 : IS_WIDE ? 3.5 : 2.5;' +
    '    ctx.lineJoin = "round";' +
    '    ctx.setLineDash([]);' +
    '    ctx.stroke();' +
    '  }' +

    // ----- NWS Forecast: dashed amber line -----
    // Connected to the last observed point so there is no visual gap
    // at the "NOW" boundary.
    '  if (DATA.forecast.length > 0) {' +
    '    ctx.beginPath();' +
    '    var started = false;' +
    '    if (DATA.observed.length > 0) {' +
    '      var last = DATA.observed[DATA.observed.length - 1];' +
    '      ctx.moveTo(toX(last.t), toY(last.v));' +
    '      started = true;' +
    '    }' +
    '    DATA.forecast.forEach(function(d) {' +
    '      var x = toX(d.t); var y = toY(d.v);' +
    '      if (!started) { ctx.moveTo(x, y); started = true; }' +
    '      else { ctx.lineTo(x, y); }' +
    '    });' +
    '    ctx.strokeStyle = "#ffaa22";' +
    '    ctx.lineWidth = IS_NARROW ? 1.5 : IS_WIDE ? 3 : 2;' +
    '    ctx.lineJoin = "round";' +
    '    ctx.setLineDash([IS_NARROW ? 4 : 7, IS_NARROW ? 3 : 5]);' +
    '    ctx.stroke();' +
    '    ctx.setLineDash([]);' +
    '  }' +

    // ----- Crest marker (drawn on top of data lines) -----
    '  if (DATA.crest !== null) {' +
    '    drawCrest(cx, cy, cw, ch, toX, toY, baseFont, labelFont);' +
    '  }' +

    // ----- Chart border -----
    '  ctx.strokeStyle = "rgba(255,255,255,0.12)";' +
    '  ctx.lineWidth = 1;' +
    '  ctx.setLineDash([]);' +
    '  ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.stroke();' +
    '}' +

    // ============================================================
    // DRAW CREST MARKER
    // Draws a vertical dashed line, a diamond at the crest point,
    // and a floating label box showing stage value and timestamp.
    // The label box uses roundRect for its background and border.
    // ============================================================
    'function drawCrest(cx, cy, cw, ch, toX, toY, baseFont, labelFont) {' +
    '  var cx2 = toX(DATA.crest.t);' +
    '  var cy2 = toY(DATA.crest.v);' +
    '  if (cx2 < cx || cx2 > cx + cw) return;' +

    '  ctx.strokeStyle = CREST_COLOR;' +
    '  ctx.lineWidth = 1;' +
    '  ctx.setLineDash([4, 4]);' +
    '  ctx.globalAlpha = 0.5;' +
    '  ctx.beginPath(); ctx.moveTo(cx2, cy); ctx.lineTo(cx2, cy2); ctx.stroke();' +
    '  ctx.setLineDash([]); ctx.globalAlpha = 1.0;' +

    '  var ds = IS_NARROW ? 5 : IS_WIDE ? 10 : 7;' +
    '  ctx.fillStyle = CREST_COLOR;' +
    '  ctx.beginPath();' +
    '  ctx.moveTo(cx2,      cy2 - ds);' +
    '  ctx.lineTo(cx2 + ds, cy2);' +
    '  ctx.lineTo(cx2,      cy2 + ds);' +
    '  ctx.lineTo(cx2 - ds, cy2);' +
    '  ctx.closePath();' +
    '  ctx.fill();' +

    '  var lFont      = IS_NARROW ? 10 : IS_WIDE ? 14 : 13;' +
    '  var lFontLarge = IS_NARROW ? 13 : IS_WIDE ? 18 : 16;' +
    '  var boxPadX    = IS_NARROW ? 5  : IS_WIDE ? 10 : 7;' +
    '  var boxPadY    = IS_NARROW ? 4  : IS_WIDE ? 7  : 5;' +
    '  var lineH      = IS_NARROW ? 12 : IS_WIDE ? 20 : 15;' +

    '  ctx.font = lFontLarge + "px Arial";' +
    '  var stageText = DATA.crest.v.toFixed(2) + " ft";' +
    '  var stageW    = ctx.measureText(stageText).width;' +
    '  ctx.font = lFont + "px Arial";' +
    '  var crestW    = ctx.measureText("CREST").width;' +
    '  var timeW     = ctx.measureText(DATA.crest.timeLabel).width;' +
    '  var boxW      = Math.max(stageW, crestW, timeW) + boxPadX * 2;' +
    '  var boxH      = lineH * 3 + boxPadY * 2;' +

    '  var boxY = cy2 - ds - boxH - 6;' +
    '  if (boxY < cy + 2) { boxY = cy2 + ds + 6; }' +
    '  var boxX = cx2 - Math.round(boxW / 2);' +
    '  if (boxX < cx + 2) { boxX = cx + 2; }' +
    '  if (boxX + boxW > cx + cw - 2) { boxX = cx + cw - boxW - 2; }' +

    '  ctx.fillStyle = "rgba(0,0,0,0.75)";' +
    '  roundRect(ctx, boxX, boxY, boxW, boxH, 3);' +
    '  ctx.fill();' +

    '  ctx.strokeStyle = CREST_COLOR;' +
    '  ctx.lineWidth = IS_NARROW ? 1 : 1.5;' +
    '  ctx.globalAlpha = 0.7;' +
    '  roundRect(ctx, boxX, boxY, boxW, boxH, 3);' +
    '  ctx.stroke();' +
    '  ctx.globalAlpha = 1.0;' +

    '  ctx.font = lFont + "px Arial";' +
    '  ctx.fillStyle = CREST_COLOR;' +
    '  ctx.textAlign = "center";' +
    '  ctx.textBaseline = "top";' +
    '  var labelCX = boxX + Math.round(boxW / 2);' +
    '  ctx.fillText("CREST", labelCX, boxY + boxPadY);' +

    '  ctx.font = "bold " + lFontLarge + "px Arial";' +
    '  ctx.fillStyle = "#ffffff";' +
    '  ctx.fillText(stageText, labelCX, boxY + boxPadY + lineH);' +

    '  ctx.font = lFont + "px Arial";' +
    '  ctx.fillStyle = "rgba(255,255,255,0.75)";' +
    '  ctx.fillText(DATA.crest.timeLabel, labelCX, boxY + boxPadY + lineH * 2);' +
    '}' +

    // ============================================================
    // HELPER: Calculate nice round Y-axis tick values.
    // ============================================================
    'function calcNiceTicks(min, max, targetCount) {' +
    '  var range = max - min;' +
    '  var step  = niceNum(range / (targetCount - 1), true);' +
    '  var start = Math.ceil(min / step) * step;' +
    '  var ticks = [];' +
    '  for (var v = start; v <= max + step * 0.01; v += step) {' +
    '    ticks.push(Math.round(v * 100) / 100);' +
    '  }' +
    '  return ticks;' +
    '}' +

    'function niceNum(x, round) {' +
    '  var exp = Math.floor(Math.log10(x));' +
    '  var f   = x / Math.pow(10, exp);' +
    '  var nf;' +
    '  if (round) {' +
    '    if (f < 1.5) nf = 1;' +
    '    else if (f < 3) nf = 2;' +
    '    else if (f < 7) nf = 5;' +
    '    else nf = 10;' +
    '  } else {' +
    '    if (f <= 1) nf = 1;' +
    '    else if (f <= 2) nf = 2;' +
    '    else if (f <= 5) nf = 5;' +
    '    else nf = 10;' +
    '  }' +
    '  return nf * Math.pow(10, exp);' +
    '}' +

    // ============================================================
    // HELPER: Generate X-axis tick marks at an adaptive interval.
    // ============================================================
    'function calcAdaptiveTicks(tMin, tMax, chartWidth) {' +
    '  var h           = 3600000;' +
    '  var minPitch    = 80;' +
    '  var maxLabels   = Math.max(2, Math.floor(chartWidth / minPitch));' +
    '  var idealMs     = (tMax - tMin) / maxLabels;' +
    '  var candidates  = [3*h, 6*h, 12*h, 24*h, 48*h, 72*h, 7*24*h];' +
    '  var interval    = candidates[candidates.length - 1];' +
    '  for (var ci = 0; ci < candidates.length; ci++) {' +
    '    if (candidates[ci] >= idealMs) { interval = candidates[ci]; break; }' +
    '  }' +
    '  var t     = Math.ceil(tMin / interval) * interval;' +
    '  var ticks = [];' +
    '  while (t <= tMax) {' +
    '    var d = new Date(t);' +
    '    var label;' +
    '    if (interval >= 24 * h) {' +
    '      label = d.toLocaleString("en-US", {' +
    '        timeZone: "America/Chicago",' +
    '        weekday: "short",' +
    '        month: "numeric",' +
    '        day: "numeric"' +
    '      });' +
    '    } else {' +
    '      label = d.toLocaleString("en-US", {' +
    '        timeZone: "America/Chicago",' +
    '        weekday: "short",' +
    '        hour: "numeric",' +
    '        hour12: true' +
    '      });' +
    '    }' +
    '    ticks.push({ t: t, label: label });' +
    '    t += interval;' +
    '  }' +
    '  return ticks;' +
    '}' +

    // ============================================================
    // HELPER: Draw a filled rounded rectangle path.
    // Used by drawCrest for the label box background and border.
    // Call ctx.fill() or ctx.stroke() after invoking this function.
    // ============================================================
    'function roundRect(ctx, x, y, w, h, r) {' +
    '  ctx.beginPath();' +
    '  ctx.moveTo(x + r, y);' +
    '  ctx.lineTo(x + w - r, y);' +
    '  ctx.quadraticCurveTo(x + w, y, x + w, y + r);' +
    '  ctx.lineTo(x + w, y + h - r);' +
    '  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);' +
    '  ctx.lineTo(x + r, y + h);' +
    '  ctx.quadraticCurveTo(x, y + h, x, y + h - r);' +
    '  ctx.lineTo(x, y + r);' +
    '  ctx.quadraticCurveTo(x, y, x + r, y);' +
    '  ctx.closePath();' +
    '}' +

    // Kick off rendering
    'drawChart();' +

    '})();';

  // ----------------------------------------------------------
  // Assemble and return the full HTML document
  // ----------------------------------------------------------
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="' + CACHE_SECONDS + '">' +
    '<style>' + css + '</style>' +
    '</head>' +
    '<body>' + body + '<script>' + script + '</script></body>' +
    '</html>'
  );
}


// ============================================================
// HELPER: Build a fallback error page returned when the Worker
// fails (e.g. NOAA API unreachable).  Auto-refreshes every 60
// seconds so the display recovers without manual intervention.
// ============================================================
function buildErrorHtml() {
  return (
    '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="60">' +
    '<style>' +
    '*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }' +
    'html, body {' +
    '  width:100vw; height:100vh; overflow:hidden;' +
    '  background:transparent;' +
    '  display:flex; align-items:center; justify-content:center;' +
    '  flex-direction:column;' +
    '  font-family:"Segoe UI",Arial,Helvetica,sans-serif;' +
    '}' +
    '.icon { font-size:48px; margin-bottom:16px; color:' + FLOOD_COLORS.major + '; }' +
    '.msg  { color:#C8102E; font-size:16px; font-weight:bold; }' +
    '.sub  { color:rgba(255,255,255,0.92); font-size:12px; margin-top:8px; }' +
    '</style></head><body>' +
    '<div class="icon">&#9888;</div>' +
    '<div class="msg">GAUGE DATA UNAVAILABLE</div>' +
    '<div class="sub">Will retry automatically &mdash; data source temporarily unavailable</div>' +
    '</body></html>'
  );
}
