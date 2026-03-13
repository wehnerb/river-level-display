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
const CREST_MIN_PROMINENCE_FT = 0.05;

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
      // ----------------------------------------------------------
      const now = Date.now();
      const observedCutoff = now - OBSERVED_HOURS * 60 * 60 * 1000;

      const observed = (stageflow?.observed?.data ?? [])
        .filter(d => d.primary !== null && d.primary !== undefined)
        .map(d => ({
          t: new Date(d.validTime).getTime(),
          v: parseFloat(d.primary),
        }))
        .filter(d => !isNaN(d.t) && !isNaN(d.v) && d.t >= observedCutoff)
        .sort((a, b) => a.t - b.t);

      // ----------------------------------------------------------
      // 5. Extract NWS forecast data (future timestamps only).
      // ----------------------------------------------------------
      const forecast = (stageflow?.forecast?.data ?? [])
        .filter(d => d.primary !== null && d.primary !== undefined)
        .map(d => ({
          t: new Date(d.validTime).getTime(),
          v: parseFloat(d.primary),
        }))
        .filter(d => !isNaN(d.t) && !isNaN(d.v) && d.t > now)
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
      // 8. Render and return the HTML page
      // ----------------------------------------------------------
      const html = buildHtml(layout, layoutKey, chartData);

      return new Response(html, {
        headers: {
          'Content-Type':  'text/html; charset=utf-8',
          // Do NOT cache the rendered HTML page in the browser or at the
          // Cloudflare edge.  The meta refresh tag fires every CACHE_SECONDS;
          // if the browser served a cached copy on refresh instead of making
          // a real network request, the displayed data would never update.
          // The upstream NOAA fetch is separately cached by Cloudflare via
          // cf.cacheTtl in fetchOpts, so NOAA API load is still controlled.
          'Cache-Control': 'no-store',
        },
      });

    } catch (err) {
      // Return a styled error page rather than a raw 500 response.
      // The page auto-refreshes every 60 seconds so it will recover
      // as soon as the upstream API becomes available again.
      return new Response(buildErrorHtml(), {
        status: 200, // Return 200 so the display does not blank out
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
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
function buildHtml(layout, layoutKey, data) {

  // Derived layout flags used for responsive scaling
  const isNarrow = layout.width <= 558;
  const isWide   = layout.width >= 1735;

  // Serialize chart data for injection into a <script> block.
  // JSON.stringify does not escape < > or & characters, so a string
  // value in the API response containing </script> could cause the
  // browser's HTML parser to close the script tag prematurely,
  // potentially allowing injected content to execute.
  // Unicode-escaping these three characters makes the JSON safe to
  // embed as a JavaScript literal inside a <script> element. The
  // JavaScript engine correctly interprets \u003c as <, \u003e as >,
  // and \u0026 as & at runtime, so DATA will contain the correct
  // values when the chart renderer reads it.
  const dataJson = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  // --------------------------------------------------------
  // All chart rendering logic lives inside the IIFE below.
  // Server-side constants are injected as JS literals so the
  // renderer does not need to repeat configuration values.
  // --------------------------------------------------------
  return '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'<meta charset="utf-8">' +
// Auto-refresh the page every CACHE_SECONDS to pull fresh data
'<meta http-equiv="refresh" content="' + CACHE_SECONDS + '">' +
'<style>' +
'* { margin: 0; padding: 0; box-sizing: border-box; }' +
'html, body {' +
'  width: '  + layout.width  + 'px;' +
'  height: ' + layout.height + 'px;' +
'  overflow: hidden;' +
'  background: #080d1a;' +
'  font-family: Arial, sans-serif;' +
'}' +
'canvas { display: block; position: absolute; top: 0; left: 0; }' +
'</style>' +
'</head>' +
'<body>' +
'<canvas id="c" width="' + layout.width + '" height="' + layout.height + '"></canvas>' +
'<script>' +

// ---- BEGIN INJECTED CLIENT-SIDE SCRIPT ----
'(function() {' +

// Data injected by the Worker
'var DATA = ' + dataJson + ';' +

// Layout constants injected by the Worker
'var W          = ' + layout.width  + ';' +
'var H          = ' + layout.height + ';' +
'var IS_NARROW  = ' + isNarrow + ';' +
'var IS_WIDE    = ' + isWide   + ';' +
'var Y_PAD      = ' + Y_AXIS_PADDING + ';' +
'var LOOKAHEAD  = ' + THRESHOLD_LOOKAHEAD_FT + ';' +

// Crest detection constants injected from server-side config
'var CREST_COLOR = "#ff66ff";' +   // Violet -- distinct from all flood/line colors

// Flood threshold color map
'var FLOOD_COLORS = {' +
'  action:   "' + FLOOD_COLORS.action   + '",' +
'  minor:    "' + FLOOD_COLORS.minor    + '",' +
'  moderate: "' + FLOOD_COLORS.moderate + '",' +
'  major:    "' + FLOOD_COLORS.major    + '"' +
'};' +

// Canvas context
'var canvas = document.getElementById("c");' +
'var ctx    = canvas.getContext("2d");' +

// ============================================================
// DRAW CHART -- entry point
// ============================================================
'function drawChart() {' +
'  ctx.fillStyle = "#080d1a";' +
'  ctx.fillRect(0, 0, W, H);' +

  // Responsive font sizes
'  var baseFont  = IS_NARROW ? 12 : IS_WIDE ? 18 : 15;' +
'  var titleFont = IS_NARROW ? 15 : IS_WIDE ? 28 : 21;' +
'  var stageFont = IS_NARROW ? 22 : IS_WIDE ? 52 : 38;' +
'  var labelFont = IS_NARROW ? 11 : IS_WIDE ? 14 : 13;' +

  // Header height reserved for station name / stage / status badge
'  var headerH = IS_NARROW ? 80 : IS_WIDE ? 120 : 104;' +

  // Footer height reserved for attribution text

'  drawHeader(headerH, titleFont, stageFont, baseFont, labelFont);' +

  // Chart occupies the space between header and footer
'  var chartTop    = headerH + 6;' +
'  var xLabelH    = IS_NARROW ? 20 : IS_WIDE ? 24 : 22;' +
'  var chartBottom = H - xLabelH;' +
  // Left margin must be wide enough for Y axis labels
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
// DRAW HEADER  (station name, current stage, flood badge)
// ============================================================
'function drawHeader(headerH, titleFont, stageFont, baseFont, labelFont) {' +
'  var pad = IS_NARROW ? 8 : IS_WIDE ? 18 : 12;' +

  // Header background
'  ctx.fillStyle = "#0d1428";' +
'  ctx.fillRect(0, 0, W, headerH);' +

  // Separator line
'  ctx.strokeStyle = "#1e2d50";' +
'  ctx.lineWidth = 1;' +
'  ctx.beginPath(); ctx.moveTo(0, headerH); ctx.lineTo(W, headerH); ctx.stroke();' +

  // Station name (top-left)
'  ctx.font = "bold " + titleFont + "px Arial";' +
'  ctx.fillStyle = "#aabbdd";' +
'  ctx.textAlign = "left";' +
'  ctx.textBaseline = "top";' +
'  ctx.fillText(DATA.gaugeName, pad, pad);' +

  // "RIVER STAGE" sub-label above the big number (centred)
'  var subFont = Math.round(titleFont * 0.62);' +
'  ctx.font = subFont + "px Arial";' +
'  ctx.fillStyle = "#556677";' +
'  ctx.textAlign = "center";' +
'  var stageCX = IS_NARROW ? Math.round(W * 0.5) : Math.round(W * 0.56);' +
'  ctx.fillText("RIVER STAGE", stageCX, pad);' +

  // Current stage value (large, colour-coded to flood status)
'  ctx.font = "bold " + stageFont + "px Arial";' +
'  ctx.fillStyle = DATA.floodStatus.color;' +
'  ctx.textAlign = "center";' +
'  ctx.textBaseline = "bottom";' +
'  if (DATA.currentStage !== null) {' +
'    ctx.fillText(DATA.currentStage.toFixed(2) + " ft", stageCX, headerH - pad);' +
'  } else {' +
'    ctx.font = "bold " + Math.round(stageFont * 0.55) + "px Arial";' +
'    ctx.fillStyle = "#667788";' +
'    ctx.fillText("NO DATA", stageCX, headerH - pad);' +
'  }' +

  // Flood status badge (right side, vertically centred)
'  var badgeW  = IS_NARROW ? 82  : IS_WIDE ? 200 : 132;' +
'  var badgeH  = IS_NARROW ? 24  : IS_WIDE ? 44  : 30;' +
'  var badgeX  = W - (IS_NARROW ? 6 : IS_WIDE ? 16 : 10);' +
'  var badgeMY = Math.round(headerH / 2);' +
'  ctx.fillStyle = DATA.floodStatus.color;' +
'  roundRect(ctx, badgeX - badgeW, badgeMY - Math.round(badgeH/2), badgeW, badgeH, 4);' +
'  ctx.fill();' +
'  ctx.font = "bold " + (IS_NARROW ? 9 : IS_WIDE ? 18 : 12) + "px Arial";' +
'  ctx.fillStyle = "#000000";' +
'  ctx.textAlign = "center";' +
'  ctx.textBaseline = "middle";' +
'  ctx.fillText(DATA.floodStatus.label, badgeX - Math.round(badgeW / 2), badgeMY);' +

  // Last updated timestamp (bottom-left of header)
'  ctx.font = labelFont + "px Arial";' +
'  ctx.fillStyle = "#3a4f62";' +
'  ctx.textAlign = "left";' +
'  ctx.textBaseline = "bottom";' +
'  ctx.fillText("Updated: " + DATA.lastUpdated, pad, headerH - pad);' +
'}' +

// ============================================================
// DRAW FOOTER  (attribution)
// ============================================================
// ============================================================
// DRAW CHART AREA  (axes, grid, threshold lines, data lines)
// ============================================================
'function drawChartArea(cx, cy, cw, ch, baseFont, labelFont) {' +

  // Combine observed and forecast for range calculations
'  var allPoints = DATA.observed.concat(DATA.forecast);' +
'  if (allPoints.length === 0) {' +
'    ctx.font = "bold " + baseFont + "px Arial";' +
'    ctx.fillStyle = "#445566";' +
'    ctx.textAlign = "center";' +
'    ctx.textBaseline = "middle";' +
'    ctx.fillText("No gauge data available", cx + Math.round(cw/2), cy + Math.round(ch/2));' +
'    return;' +
'  }' +

  // ----- Y axis range -----
'  var vals = allPoints.map(function(d) { return d.v; });' +
'  var dataMin = Math.min.apply(null, vals);' +
'  var dataMax = Math.max.apply(null, vals);' +

  // Determine which flood thresholds are visible and extend
  // dataMax to include any threshold within LOOKAHEAD distance
'  var visibleThresholds = {};' +
'  var threshOrder = ["action", "minor", "moderate", "major"];' +
'  threshOrder.forEach(function(key) {' +
'    var stage = DATA.thresholds[key];' +
'    if (stage !== null && stage <= dataMax + LOOKAHEAD) {' +
'      visibleThresholds[key] = stage;' +
      // Extend the chart range to fully show any visible threshold line
'      if (stage > dataMax) { dataMax = stage; }' +
'    }' +
'  });' +

  // Apply Y axis padding
'  var yMin = dataMin - Y_PAD;' +
'  var yMax = dataMax + Y_PAD;' +

  // ----- X axis range (time) -----
'  var allTimes = allPoints.map(function(d) { return d.t; });' +
'  var tMin = Math.min.apply(null, allTimes);' +
'  var tMax = Math.max.apply(null, allTimes);' +
  // Small time buffer at each end so points sit away from the edges
'  var tBuf = (tMax - tMin) * 0.02;' +
'  tMin -= tBuf; tMax += tBuf;' +

  // Coordinate transform helpers
'  function toY(v) { return cy + ch - ((v - yMin) / (yMax - yMin)) * ch; }' +
'  function toX(t) { return cx + ((t - tMin) / (tMax - tMin)) * cw; }' +

  // ----- Chart background -----
'  ctx.fillStyle = "#0a1020";' +
'  ctx.fillRect(cx, cy, cw, ch);' +

  // ----- Y axis grid lines and labels -----
'  var yTicks = calcNiceTicks(yMin, yMax, IS_NARROW ? 5 : IS_WIDE ? 9 : 7);' +
'  ctx.strokeStyle = "#141e32";' +
'  ctx.lineWidth = 1;' +
'  ctx.setLineDash([]);' +
'  yTicks.forEach(function(tick) {' +
'    var y = toY(tick);' +
'    if (y < cy || y > cy + ch) return;' +
'    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + cw, y); ctx.stroke();' +
'  });' +
  // Y axis labels (to the left of the chart)
'  ctx.font = labelFont + "px Arial";' +
'  ctx.fillStyle = "#4a6070";' +
'  ctx.textAlign = "right";' +
'  ctx.textBaseline = "middle";' +
'  yTicks.forEach(function(tick) {' +
'    var y = toY(tick);' +
'    if (y < cy - 4 || y > cy + ch + 4) return;' +
'    ctx.fillText(tick.toFixed(1), cx - 4, y);' +
'  });' +
  // Y axis unit label (rotated, sits to the left of tick labels)
'  ctx.save();' +
'  ctx.translate(cx - (IS_NARROW ? 30 : IS_WIDE ? 54 : 40), cy + Math.round(ch / 2));' +
'  ctx.rotate(-Math.PI / 2);' +
'  ctx.font = (IS_NARROW ? 9 : IS_WIDE ? 13 : 10) + "px Arial";' +
'  ctx.fillStyle = "#2a3a4a";' +
'  ctx.textAlign = "center";' +
'  ctx.textBaseline = "middle";' +
'  ctx.fillText("Stage (ft)", 0, 0);' +
'  ctx.restore();' +

  // ----- X axis grid lines and labels (adaptive interval) -----
'  var xTicks = calcAdaptiveTicks(tMin, tMax, cw);' +
'  ctx.strokeStyle = "#141e32";' +
'  ctx.lineWidth = 1;' +
'  xTicks.forEach(function(tick) {' +
'    var x = toX(tick.t);' +
'    if (x < cx || x > cx + cw) return;' +
'    ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x, cy + ch); ctx.stroke();' +
'  });' +
  // X axis labels (below the chart)
'  ctx.font = labelFont + "px Arial";' +
'  ctx.fillStyle = "#4a6070";' +
'  ctx.textAlign = "center";' +
'  ctx.textBaseline = "top";' +
'  xTicks.forEach(function(tick) {' +
'    var x = toX(tick.t);' +
    // Keep labels inside the chart bounds to avoid clipping
'    if (x < cx + 22 || x > cx + cw - 22) return;' +
'    ctx.fillText(tick.label, x, cy + ch + 3);' +
'  });' +

  // ----- Flood threshold lines (only those within visible range) -----
'  threshOrder.forEach(function(key) {' +
'    var stage = visibleThresholds[key];' +
'    if (stage === undefined) return;' +
'    var y = toY(stage);' +
'    if (y < cy || y > cy + ch) return;' +
'    var color = FLOOD_COLORS[key];' +

    // Dashed horizontal threshold line
'    ctx.strokeStyle = color;' +
'    ctx.lineWidth = IS_NARROW ? 1 : IS_WIDE ? 2.5 : 1.5;' +
'    ctx.setLineDash([6, 4]);' +
'    ctx.globalAlpha = 0.65;' +
'    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + cw, y); ctx.stroke();' +
'    ctx.setLineDash([]); ctx.globalAlpha = 1.0;' +

    // Threshold label (right-aligned, just above the line)
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

  // ----- Observed data: gradient fill under the line -----
'  if (DATA.observed.length > 1) {' +
'    ctx.beginPath();' +
'    DATA.observed.forEach(function(d, i) {' +
'      var x = toX(d.t); var y = toY(d.v);' +
'      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);' +
'    });' +
    // Close fill path along chart bottom edge
'    ctx.lineTo(toX(DATA.observed[DATA.observed.length - 1].t), cy + ch);' +
'    ctx.lineTo(toX(DATA.observed[0].t), cy + ch);' +
'    ctx.closePath();' +
'    var grad = ctx.createLinearGradient(0, cy, 0, cy + ch);' +
'    grad.addColorStop(0, "rgba(50, 110, 220, 0.32)");' +
'    grad.addColorStop(1, "rgba(50, 110, 220, 0.02)");' +
'    ctx.fillStyle = grad;' +
'    ctx.fill();' +
'  }' +

  // ----- Observed data: solid line -----
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
  // The forecast line is drawn connected to the last observed point
  // so there is no visual gap at the "NOW" boundary.
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

  // ----- Crest marker (drawn on top of data lines, beneath legend) -----
'  if (DATA.crest !== null) {' +
'    drawCrest(cx, cy, cw, ch, toX, toY, baseFont, labelFont);' +
'  }' +

  // ----- Legend -----
  // Compute a lyStart that avoids overlapping any visible threshold
  // line.  The legend is anchored to the top-right, so we scan
  // downward from cy + pad until the legend's full height fits
  // cleanly between two threshold lines (or clears them all).
'  (function() {' +
'    var lgPad    = IS_NARROW ? 6  : IS_WIDE ? 12 : 8;' +
'    var lgLh     = IS_NARROW ? 12 : IS_WIDE ? 20 : 15;' +
'    var lgBuffer = IS_NARROW ? 4  : IS_WIDE ? 6  : 5;' +
    // Row count: Observed is always shown; Forecast and Crest are conditional
'    var lgRows   = 1' +
'      + (DATA.forecast.length > 0 ? 1 : 0)' +
'      + (DATA.crest !== null      ? 1 : 0);' +
'    var lgH = lgRows * lgLh + lgPad;' +
    // Collect Y pixel positions of all visible threshold lines
'    var threshYs = [];' +
'    var thKeys = ["action", "minor", "moderate", "major"];' +
'    thKeys.forEach(function(k) {' +
'      if (visibleThresholds[k] !== undefined) {' +
'        threshYs.push(toY(visibleThresholds[k]));' +
'      }' +
'    });' +
    // Walk lyStart downward until no threshold falls inside the legend box.
    // Each iteration shifts below the offending line plus a small buffer.
'    var lyStart = cy + lgPad;' +
'    var maxTries = threshYs.length + 1;' +
'    for (var ti = 0; ti < maxTries; ti++) {' +
'      var conflict = false;' +
'      for (var yi = 0; yi < threshYs.length; yi++) {' +
'        var ty = threshYs[yi];' +
          // A threshold conflicts if it falls inside the legend's Y range
'        if (ty >= lyStart - lgBuffer && ty <= lyStart + lgH + lgBuffer) {' +
'          lyStart = ty + lgBuffer;' +
'          conflict = true;' +
'          break;' +
'        }' +
'      }' +
'      if (!conflict) break;' +
'    }' +
    // Clamp so legend never extends below the chart bottom
'    lyStart = Math.min(lyStart, cy + ch - lgH - lgPad);' +
'    drawLegend(cx, cy, cw, lyStart, labelFont);' +
'  })();' +

  // ----- Chart border -----
'  ctx.strokeStyle = "#1a2840";' +
'  ctx.lineWidth = 1;' +
'  ctx.setLineDash([]);' +
'  ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.stroke();' +
'}' +

// ============================================================
// DRAW CREST MARKER
// Draws a vertical dashed line, a diamond marker, and a label
// box at the confirmed crest point.  The label box is nudged
// horizontally if the crest is near the chart edges.
// ============================================================
'function drawCrest(cx, cy, cw, ch, toX, toY, baseFont, labelFont) {' +
'  var cx2 = toX(DATA.crest.t);' +
'  var cy2 = toY(DATA.crest.v);' +

  // Only render if the crest X falls within the visible chart area
'  if (cx2 < cx || cx2 > cx + cw) return;' +

  // Dashed vertical line from crest point to top of chart
'  ctx.strokeStyle = CREST_COLOR;' +
'  ctx.lineWidth = 1;' +
'  ctx.setLineDash([4, 4]);' +
'  ctx.globalAlpha = 0.5;' +
'  ctx.beginPath(); ctx.moveTo(cx2, cy); ctx.lineTo(cx2, cy2); ctx.stroke();' +
'  ctx.setLineDash([]); ctx.globalAlpha = 1.0;' +

  // Diamond marker at the crest point
'  var ds = IS_NARROW ? 5 : IS_WIDE ? 10 : 7;' +
'  ctx.fillStyle = CREST_COLOR;' +
'  ctx.beginPath();' +
'  ctx.moveTo(cx2,      cy2 - ds);' +
'  ctx.lineTo(cx2 + ds, cy2);' +
'  ctx.lineTo(cx2,      cy2 + ds);' +
'  ctx.lineTo(cx2 - ds, cy2);' +
'  ctx.closePath();' +
'  ctx.fill();' +

  // Label box dimensions
'  var lFont      = IS_NARROW ? 10 : IS_WIDE ? 14 : 13;' +
'  var lFontLarge = IS_NARROW ? 13 : IS_WIDE ? 18 : 16;' +
'  var boxPadX    = IS_NARROW ? 5  : IS_WIDE ? 10 : 7;' +
'  var boxPadY    = IS_NARROW ? 4  : IS_WIDE ? 7  : 5;' +
'  var lineH      = IS_NARROW ? 12 : IS_WIDE ? 20 : 15;' +

  // Measure the widest line (the stage value line is usually widest)
'  ctx.font = lFontLarge + "px Arial";' +
'  var stageText = DATA.crest.v.toFixed(2) + " ft";' +
'  var stageW    = ctx.measureText(stageText).width;' +
'  ctx.font = lFont + "px Arial";' +
'  var crestW    = ctx.measureText("CREST").width;' +
'  var timeW     = ctx.measureText(DATA.crest.timeLabel).width;' +
'  var boxW      = Math.max(stageW, crestW, timeW) + boxPadX * 2;' +
'  var boxH      = lineH * 3 + boxPadY * 2;' +

  // Default: label sits above the diamond; flip below if near chart top
'  var boxY = cy2 - ds - boxH - 6;' +
'  if (boxY < cy + 2) { boxY = cy2 + ds + 6; }' +

  // Default: label is centred on the crest X; nudge left/right at edges
'  var boxX = cx2 - Math.round(boxW / 2);' +
'  if (boxX < cx + 2) { boxX = cx + 2; }' +
'  if (boxX + boxW > cx + cw - 2) { boxX = cx + cw - boxW - 2; }' +

  // Background box
'  ctx.fillStyle = "rgba(10, 14, 30, 0.88)";' +
'  roundRect(ctx, boxX, boxY, boxW, boxH, 3);' +
'  ctx.fill();' +

  // Box border
'  ctx.strokeStyle = CREST_COLOR;' +
'  ctx.lineWidth = IS_NARROW ? 1 : 1.5;' +
'  ctx.globalAlpha = 0.7;' +
'  roundRect(ctx, boxX, boxY, boxW, boxH, 3);' +
'  ctx.stroke();' +
'  ctx.globalAlpha = 1.0;' +

  // "CREST" label (top line)
'  ctx.font = lFont + "px Arial";' +
'  ctx.fillStyle = CREST_COLOR;' +
'  ctx.textAlign = "center";' +
'  ctx.textBaseline = "top";' +
'  var labelCX = boxX + Math.round(boxW / 2);' +
'  ctx.fillText("CREST", labelCX, boxY + boxPadY);' +

  // Stage value (middle line, larger font)
'  ctx.font = "bold " + lFontLarge + "px Arial";' +
'  ctx.fillStyle = "#ffffff";' +
'  ctx.fillText(stageText, labelCX, boxY + boxPadY + lineH);' +

  // Timestamp (bottom line)
'  ctx.font = lFont + "px Arial";' +
'  ctx.fillStyle = "#aabbcc";' +
'  ctx.fillText(DATA.crest.timeLabel, labelCX, boxY + boxPadY + lineH * 2);' +
'}' +

// ============================================================
// DRAW LEGEND  (top-left corner of chart area)
// ============================================================
'function drawLegend(cx, cy, cw, lyStart, labelFont) {' +
'  var pad     = IS_NARROW ? 6  : IS_WIDE ? 12 : 8;' +
'  var lineLen = IS_NARROW ? 16 : IS_WIDE ? 26 : 20;' +
'  var lh      = IS_NARROW ? 12 : IS_WIDE ? 20 : 15;' +
'  var lFont   = IS_NARROW ? 10 : IS_WIDE ? 13 : 13;' +
'  var lx = cx + cw - pad;' +
  // lyStart is computed by the caller to avoid threshold line conflicts
'  var ly = lyStart;' +
'  ctx.globalAlpha = 0.8;' +

  // Observed line legend
'  ctx.strokeStyle = "#4488ff";' +
'  ctx.lineWidth = IS_NARROW ? 1.5 : 2;' +
'  ctx.setLineDash([]);' +
'  ctx.beginPath();' +
'  ctx.moveTo(lx - lineLen, ly + Math.round(lh * 0.5));' +
'  ctx.lineTo(lx,           ly + Math.round(lh * 0.5));' +
'  ctx.stroke();' +
'  ctx.font = lFont + "px Arial";' +
'  ctx.fillStyle = "#8899bb";' +
'  ctx.textAlign = "right";' +
'  ctx.textBaseline = "middle";' +
'  ctx.fillText("Observed", lx - lineLen - 4, ly + Math.round(lh * 0.5));' +
'  ly += lh;' +

  // Forecast line legend (only drawn if forecast data exists)
'  if (DATA.forecast.length > 0) {' +
'    ctx.strokeStyle = "#ffaa22";' +
'    ctx.lineWidth = IS_NARROW ? 1.5 : 2;' +
'    ctx.setLineDash([5, 3]);' +
'    ctx.beginPath();' +
'    ctx.moveTo(lx - lineLen, ly + Math.round(lh * 0.5));' +
'    ctx.lineTo(lx,           ly + Math.round(lh * 0.5));' +
'    ctx.stroke();' +
'    ctx.setLineDash([]);' +
'    ctx.font = lFont + "px Arial";' +
'    ctx.fillStyle = "#8899bb";' +
'    ctx.fillText("NWS Forecast", lx - lineLen - 4, ly + Math.round(lh * 0.5));' +
'    ly += lh;' +
'  }' +

  // Crest marker legend (only drawn if a crest was detected)
'  if (DATA.crest !== null) {' +
'    var ds2  = IS_NARROW ? 4 : IS_WIDE ? 7 : 5;' +
'    var midX = lx - Math.round(lineLen / 2);' +
'    var midY = ly + Math.round(lh * 0.5);' +
'    ctx.fillStyle = CREST_COLOR;' +
'    ctx.beginPath();' +
'    ctx.moveTo(midX,       midY - ds2);' +
'    ctx.lineTo(midX + ds2, midY);' +
'    ctx.lineTo(midX,       midY + ds2);' +
'    ctx.lineTo(midX - ds2, midY);' +
'    ctx.closePath();' +
'    ctx.fill();' +
'    ctx.font = lFont + "px Arial";' +
'    ctx.fillStyle = "#8899bb";' +
'    ctx.textAlign = "right";' +
'    ctx.textBaseline = "middle";' +
'    ctx.fillText("Crest", lx - lineLen - 4, midY);' +
'  }' +
'  ctx.globalAlpha = 1.0;' +
'}' +

// ============================================================
// HELPER: Calculate nice round Y-axis tick values.
// Uses the "nice number" algorithm for human-friendly intervals.
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
// The interval is chosen so labels never overlap: it snaps to
// the smallest clean step (3h, 6h, 12h, 24h, 48h ...) that
// keeps each label at least 80px away from its neighbours.
// Labels are formatted in local (Central) time.
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
      // Wide spacing: show day name and date only (no time)
'      label = d.toLocaleString("en-US", {' +
'        timeZone: "America/Chicago",' +
'        weekday: "short",' +
'        month: "numeric",' +
'        day: "numeric"' +
'      });' +
'    } else {' +
      // Tight spacing: show day name and hour
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
// Call ctx.fill() or ctx.stroke() after this function.
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

'})();' +
// ---- END INJECTED CLIENT-SIDE SCRIPT ----

'</script>' +
'</body>' +
'</html>';
}


// ============================================================
// HELPER: Build a fallback error page returned when the Worker
// fails (e.g. NOAA API unreachable).  Auto-refreshes every 60
// seconds so the display recovers without manual intervention.
// ============================================================
function buildErrorHtml() {
  return '<!DOCTYPE html>' +
'<html lang="en"><head>' +
'<meta charset="utf-8">' +
'<meta http-equiv="refresh" content="60">' +
'<style>' +
'* { margin:0; padding:0; box-sizing:border-box; }' +
'html,body {' +
'  width:100vw; height:100vh; overflow:hidden;' +
'  background:#080d1a;' +
'  display:flex; align-items:center; justify-content:center;' +
'  flex-direction:column; font-family:Arial,sans-serif;' +
'}' +
'.icon { font-size:48px; margin-bottom:16px; color:#cc4444; }' +
'.msg  { color:#cc4444; font-size:16px; font-weight:bold; }' +
'.sub  { color:#3a5060; font-size:12px; margin-top:8px; }' +
'</style></head><body>' +
'<div class="icon">&#9888;</div>' +
'<div class="msg">GAUGE DATA UNAVAILABLE</div>' +
'<div class="sub">Will retry automatically &mdash; data source temporarily unavailable</div>' +
'</body></html>';
}
