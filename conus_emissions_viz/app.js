/* =========================================================
   app.js

   Responsibilities:
   - Load state + national CSV data
   - Initialize Leaflet map + state outlines
   - Optional gridded GeoTIFF overlay with slider + legend
   - Charts (bar + timeseries) with uncertainty
   - Export currently displayed chart data as CSV
   ========================================================= */

/* ===================== CONFIG ===================== */

// Years + paths
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024];
const PRIOR_YEARS = [2019, 2020];

const CSV_PATH = (year) => `data/csv/estrada_states_${year}.csv`;
const NATIONAL_CSV_PATH = "data/csv/national_emissions.csv";
const NATIONAL_CSV_PATH_PRIOR = "data/csv/national_prior_emissions_2017_2020.csv";
const NETCDF_PATH = (year, emisSource) =>
  (emisSource === "ghgi")
    ? `data/nc/prior_${year}.nc`
    : `data/nc/posterior_ens_mean_${year}.nc`;


// GeoJSON
const STATES_GEOJSON_PATH = "data/ne/us_states_simplified.geojson";

// State outline styling
const STATES_FILL_OPACITY = 0.0;
const STATES_LINE_COLOR = "#666";
const STATES_LINE_WEIGHT = 0.8;

// Scenario naming in state CSV
const SCENARIO_SUFFIX = "_posterior";

// Sector inclusion/exclusion + labels
const DEFAULT_SECTOR = "Total_ExclSoilAbs";
const EXCLUDED_SECTORS = [
  "Total",
  "OtherAnth",
  "Gas",
  "Oil",
  "Lakes",
  "Seeps",
  "Termites",
  "SoilAbsorb",
];

const SECTOR_LABELS = {
  ONG: "Oil/Gas",
  Livestock: "Livestock",
  Total_ExclSoilAbs: "Total",
};

// Grid overlay
const GRID_MANIFEST_PATH = "data/manifest.json";
const GRID_VAR_BY_SECTOR = {
  Total_ExclSoilAbs: "EmisCH4_Total",
  Landfills: "EmisCH4_Landfills",
  Wastewater: "EmisCH4_Wastewater",
  Livestock: "EmisCH4_Livestock",
  Coal: "EmisCH4_Coal",
  ONG: "EmisCH4_ONG",
  Rice: "EmisCH4_Rice",
  BiomassBurning: "EmisCH4_BiomassBurning",
  Wetlands: "EmisCH4_Wetlands",
  Reservoirs: "EmisCH4_Reservoirs",
};

const GRID_UNITS_HTML = "kg km<sup>-2</sup> h<sup>-1</sup>";
const GRID_COLORMAP = "ylorrd";
const GRID_OPACITY = 0.40;
const GRID_RESOLUTION = 256;

/* ===================== APP STATE ===================== */

const state = {
  // data
  dataByYear: {},              // [year][stateName] -> row
  nationalPosteriorByYear: {}, // GHGI+TROPOMI
  nationalPriorByYear: {},     // GHGI
  sectorKeys: [],              // derived from state CSV columns
  selectedState: null,         // string | null
  emisSource: "ghgi_tropomi",  // "ghgi" | "ghgi_tropomi"

  // units (charts)
  unit: "Tg",
  unitFactor: 1,
  unitLabel: "Tg/yr",

  // map
  map: null,
  statesLayer: null,

  // grid overlay
  colorbarRefEntry: null,
  gridManifest: null,
  gridLayer: null,
  gridVarDomainCache: {}, // gridVar -> { min, max }
  gridOpacity: GRID_OPACITY,
  currentGridEntry: null,
  currentGridVar: null,
  gridLegendControl: null,
  gridDisplayMax: null, // real-value max used for color scaling (null => use manifest max)
  gridMaxT: 1.0,        // normalized slider value [0..1]
  gridGeoraster: null,

  // charts
  barChart: null,
  lineChart: null,

  // cached DOM
  el: {},
};

/* ===================== UTILITIES ===================== */

function $(id) {
  return document.getElementById(id);
}

function parseNumber(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs < 0.001) return v.toFixed(4);
  if (abs < 1) return v.toFixed(3);
  if (abs < 10) return v.toFixed(2);
  if (abs < 100) return v.toFixed(1);
  return Math.round(v).toString();
}

function setUnits(newUnit) {
  state.unit = newUnit;
  state.unitFactor = (newUnit === "Gg") ? 1000 : 1;
  state.unitLabel = (newUnit === "Gg") ? "Gg/yr" : "Tg/yr";
}

function scaleVal(v) {
  return (v == null || !Number.isFinite(v)) ? null : v * state.unitFactor;
}

function getNiceLimits(minVal, maxVal) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return { min: undefined, max: undefined };
  if (minVal === maxVal) return { min: 0, max: maxVal * 1.1 + 1e-9 };

  const pad = 0.06 * (maxVal - minVal);
  return { min: Math.max(0, minVal - pad), max: maxVal + pad };
}

function labelSector(sectorKey) {
  return SECTOR_LABELS[sectorKey] ?? sectorKey;
}

function emisSourceLabel(emisSource) {
  return (emisSource === "ghgi") ? "GHGI" : "GHGI+TROPOMI";
}

/* ===================== MODE + COLUMN HELPERS ===================== */

function activeYears(emisSource) {
  return (emisSource === "ghgi") ? PRIOR_YEARS : YEARS;
}

function getChartMode() {
  const el = document.querySelector('input[name="chartMode"]:checked');
  return el ? el.value : "state";
}

function getEmisSource() {
  const el = state.el?.dataSourceSelect;
  return el ? el.value : (state.emisSource ?? "ghgi_tropomi");
}

function mapValueCol(emisSource) {
  return (emisSource === "ghgi") ? "Total_prior" : "Total_posterior";
}

function currentPlaceLabel(mode) {
  return (mode === "national") ? "National" : (state.selectedState ?? "(none)");
}

function stateCentralCol(sectorKey, emisSource) {
  return (emisSource === "ghgi") ? `${sectorKey}_prior` : `${sectorKey}_posterior`;
}

// National columns are base sectorKey without suffix
function centralCol(sectorKey, mode, emisSource) {
  return (mode === "national") ? sectorKey : stateCentralCol(sectorKey, emisSource);
}

function minCol(sectorKey) {
  return `${sectorKey}_min`;
}
function maxCol(sectorKey) {
  return `${sectorKey}_max`;
}

/* ===================== CSV EXPORT ===================== */

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return (/[",\n]/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  return rows.map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
}

function downloadUrl(filename, url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function makeBarCsvRows(mode, year) {
  const place = currentPlaceLabel(mode);
  const emisSource = getEmisSource();
  const bar = buildBarData(year, mode, emisSource);

  const rows = [
    ["type", "bar"],
    ["mode", mode],
    ["place", place],
    ["year", year],
    ["units", state.unitLabel],
    ["data_source", emisSourceLabel(emisSource)],
    [],
    ["sector", "value", "min", "max"],
  ];

  for (let i = 0; i < bar.labels.length; i++) {
    const key = bar.labels[i];
    rows.push([labelSector(key), bar.values[i], bar.mins[i], bar.maxs[i]]);
  }
  return rows;
}

function makeLineCsvRows(mode, sectorKey) {
  const place = currentPlaceLabel(mode);
  const emisSource = getEmisSource();
  const line = buildLineData(mode, sectorKey, emisSource);

  const rows = [
    ["type", "timeseries"],
    ["mode", mode],
    ["place", place],
    ["sector", labelSector(sectorKey)],
    ["units", state.unitLabel],
    ["data_source", emisSourceLabel(emisSource)],
    [],
    ["year", "value", "min", "max"],
  ];

  for (let i = 0; i < line.labels.length; i++) {
    rows.push([line.labels[i], line.values[i], line.mins[i], line.maxs[i]]);
  }
  return rows;
}

/* ===================== DATA LOADING ===================== */

async function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: reject,
    });
  });
}

function deriveSectorsFromRow(row) {
  return Object.keys(row)
    .filter(k => k.endsWith(SCENARIO_SUFFIX))
    .map(k => k.replace(SCENARIO_SUFFIX, ""))
    .filter(s => s !== "Total")
    .filter(s => !EXCLUDED_SECTORS.includes(s))
    .sort();
}

async function loadStateCSVs() {
  for (const y of YEARS) {
    const rows = await fetchCSV(CSV_PATH(y));
    state.dataByYear[y] = {};

    for (const r of rows) {
      const name = r.State?.trim();
      if (name) state.dataByYear[y][name] = r;
    }

    if (state.sectorKeys.length === 0 && rows.length > 0) {
      state.sectorKeys = deriveSectorsFromRow(rows[0]);
    }
  }
}

async function loadNationalCSVs() {
  const rowsPost = await fetchCSV(NATIONAL_CSV_PATH);
  state.nationalPosteriorByYear = {};
  for (const r of rowsPost) {
    const y = Number(r.Year);
    if (Number.isFinite(y)) state.nationalPosteriorByYear[y] = r;
  }

  const rowsPrior = await fetchCSV(NATIONAL_CSV_PATH_PRIOR);
  state.nationalPriorByYear = {};
  for (const r of rowsPrior) {
    const y = Number(r.Year);
    if (Number.isFinite(y)) state.nationalPriorByYear[y] = r;
  }
}

function hasUncertainty(emisSource) {
  return emisSource !== "ghgi";
}

/* ===================== STATE OUTLINES ===================== */

function makeChoroplethStyle(year, feature) {
  const props = feature.properties || {};
  const name = props.name || props.NAME || props.STATE_NAME;

  const row = state.dataByYear?.[year]?.[name];
  const emisSource = getEmisSource();
  const v = row ? parseNumber(row[mapValueCol(emisSource)]) : null;

  return {
    color: STATES_LINE_COLOR,
    weight: STATES_LINE_WEIGHT,
    fillColor: (v == null) ? "#00000000" : "#3388ff",
    fillOpacity: (v == null) ? 0.0 : STATES_FILL_OPACITY,
  };
}

function recolorStates() {
  if (!state.statesLayer) return;

  const year = Number(state.el.yearSelect.value);
  state.statesLayer.setStyle((feature) => makeChoroplethStyle(year, feature));

  if (!state.selectedState) return;

  state.statesLayer.eachLayer(layer => {
    const props = layer.feature?.properties || {};
    const name = props.name || props.NAME || props.STATE_NAME;
    if (name === state.selectedState) layer.setStyle({ weight: 2, color: "#000" });
  });
}

function hideStatesOverlay() {
  if (state.statesLayer && state.map?.hasLayer(state.statesLayer)) {
    state.map.removeLayer(state.statesLayer);
  }
}

function showStatesOverlay() {
  if (state.statesLayer && state.map && !state.map.hasLayer(state.statesLayer)) {
    state.statesLayer.addTo(state.map);
    state.statesLayer.bringToFront();
  }
}

/* ===================== GRID OVERLAY ===================== */

function getGlobalDomainForGridVar(gridVar) {
  // Cache so we don't rescan every time
  if (state.gridVarDomainCache?.[gridVar]) return state.gridVarDomainCache[gridVar];

  const entries = state.gridManifest?.data?.[gridVar];
  if (!entries) return null;

  let gMin = Infinity;
  let gMax = -Infinity;

  for (const key of Object.keys(entries)) {
    const e = entries[key];
    if (!e) continue;

    const mn = Number(e.min);
    const mx = Number(e.max);
    if (Number.isFinite(mn)) gMin = Math.min(gMin, mn);
    if (Number.isFinite(mx)) gMax = Math.max(gMax, mx);
  }

  if (!Number.isFinite(gMin) || !Number.isFinite(gMax) || gMax <= gMin) return null;

  const dom = { min: gMin, max: gMax };
  state.gridVarDomainCache[gridVar] = dom;
  return dom;
}

function gridVarForSector(sectorKey) {
  return GRID_VAR_BY_SECTOR[sectorKey] ?? "EmisCH4_Total";
}

function getColorbarReferenceEntry(gridVar, year) {
  // Always use GHGI+TROPOMI entry (no "_prior") for colorbar min/max domain
  return state.gridManifest?.data?.[gridVar]?.[String(year)] ?? null;
}

async function ensureGridManifestLoaded() {
  if (state.gridManifest) return;
  state.gridManifest = await (await fetch(GRID_MANIFEST_PATH)).json();
}

function getGridOpacity() {
  const el = state.el.gridOpacitySlider;
  if (!el) return GRID_OPACITY;
  const v = Number(el.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : GRID_OPACITY;
}

function syncGridOpacityUI() {
  const el = state.el.gridOpacitySlider;
  const out = state.el.gridOpacityValue;
  if (!el || !out) return;
  out.textContent = `${Math.round(getGridOpacity() * 100)}%`;
}

function applyGridOpacity() {
  state.gridOpacity = getGridOpacity();
  syncGridOpacityUI();
  if (state.gridLayer && typeof state.gridLayer.setOpacity === "function") {
    state.gridLayer.setOpacity(state.gridOpacity);
  } else if (state.gridLayer?.options) {
    // fallback for implementations without setOpacity
    state.gridLayer.options.opacity = state.gridOpacity;
    state.gridLayer.redraw?.();
  }
}

function clearGrid() {
  if (state.gridLayer) state.map.removeLayer(state.gridLayer);
  state.gridLayer = null;
  state.gridGeoraster = null;
  state.currentGridEntry = null;
  state.currentGridVar = null;
  updateGridLegend();
  syncGridSliderToEntry();
}

function getEffectiveGridMax() {
  const dom = state.currentGridVar ? getGlobalDomainForGridVar(state.currentGridVar) : null;
  if (!dom) return null;

  const maxRaw = Number(dom.max ?? 1);
  return (state.gridDisplayMax != null) ? Number(state.gridDisplayMax) : maxRaw;
}

function syncGridSliderToEntry() {
  const slider = state.el.gridMaxSlider;
  const out = state.el.gridMaxValue;

  if (!slider || !out || !state.currentGridEntry || !state.currentGridVar) return;

  const dom = getGlobalDomainForGridVar(state.currentGridVar);
  if (!dom) {
    slider.disabled = true;
    out.textContent = "";
    return;
  }

  const dataMin = dom.min;
  const dataMax = dom.max;

  slider.disabled = false;

  // Only initialize if user hasn't set it yet
  if (state.gridDisplayMax == null) state.gridDisplayMax = dataMax;

  // Clamp within global domain
  state.gridDisplayMax = Math.max(dataMin, Math.min(dataMax, state.gridDisplayMax));

  state.gridMaxT = (state.gridDisplayMax - dataMin) / (dataMax - dataMin);
  state.gridMaxT = Math.max(0, Math.min(1, state.gridMaxT));

  slider.value = String(Math.round(state.gridMaxT * 1000));
  out.innerHTML = `${fmt(state.gridDisplayMax)} ${GRID_UNITS_HTML}`;
}

function updateGridLegend() {
  const ctl = state.gridLegendControl;
  if (!ctl?._container) return;

  if (!state.currentGridEntry || !state.currentGridVar) {
    ctl._container.innerHTML = "";
    return;
  }

  const dom = getGlobalDomainForGridVar(state.currentGridVar);
  if (!dom) {
    ctl._container.innerHTML = "";
    return;
  }

  const min = dom.min;
  const max = getEffectiveGridMax();

  const steps = 40;
  const colors = [];
  for (let i = 0; i < steps; i++) {
    colors.push(chroma.scale(GRID_COLORMAP)(i / (steps - 1)).hex());
  }
  const gradient = `linear-gradient(to right, ${colors.join(",")})`;

  const sectorKey =
    Object.keys(GRID_VAR_BY_SECTOR).find(k => GRID_VAR_BY_SECTOR[k] === state.currentGridVar) ??
    DEFAULT_SECTOR;

  ctl._container.innerHTML = `
    <div class="legend">
      <div class="title">${labelSector(sectorKey)}</div>
      <div class="units">${GRID_UNITS_HTML}</div>
      <div class="bar" style="background:${gradient};"></div>
      <div class="labels">
        <span>${fmt(min)}</span>
        <span>${fmt(max)}</span>
      </div>
    </div>
  `;
}

async function setGridLayerForSelection() {
  await ensureGridManifestLoaded();

  const year = Number(state.el.yearSelect.value);
  const sectorKey = state.el.sectorSelect.value;
  const gridVar = gridVarForSector(sectorKey);

  const emisSource = getEmisSource();
  const yearKey = (emisSource === "ghgi") ? `${year}_prior` : String(year);

  const entry = state.gridManifest?.data?.[gridVar]?.[yearKey];
  if (!entry) {
    console.warn("No GeoTIFF entry for", { gridVar, yearKey, sectorKey });
    state.currentGridEntry = null;
    state.currentGridVar = null;
    syncGridSliderToEntry();
    updateGridLegend();
    return;
  }

  // remove old layer
  if (state.gridLayer) {
    state.map.removeLayer(state.gridLayer);
    state.gridLayer = null;
    state.gridGeoraster = null;
  }

  state.currentGridEntry = entry;
  state.currentGridVar = gridVar;

  // reference entry ALWAYS posterior for slider + legend + colormap scaling
  state.colorbarRefEntry = getColorbarReferenceEntry(gridVar, year) || entry;

  const resp = await fetch(entry.tif);
  const arrayBuffer = await resp.arrayBuffer();
  const georaster = await parseGeoraster(arrayBuffer);
  state.gridGeoraster = georaster;

  state.gridLayer = new GeoRasterLayer({
    georaster,
    opacity: getGridOpacity(),
    resolution: GRID_RESOLUTION,
    pixelValuesToColorFn: (vals) => {
      const v = vals?.[0];
      if (v == null || Number.isNaN(v)) return null;

      const dom = state.currentGridVar ? getGlobalDomainForGridVar(state.currentGridVar) : null;
      const min = Number(dom?.min ?? 0);
      const max = getEffectiveGridMax();
      const denom = (max - min) || 1;

      const t = Math.max(0, Math.min(1, (v - min) / denom));
      return chroma.scale(GRID_COLORMAP)(t).hex();
    },
  });

  state.gridLayer.addTo(state.map);

  if (getChartMode() === "state" && state.statesLayer) state.statesLayer.bringToFront();

  syncGridSliderToEntry();
  updateGridLegend();
}

function handleGridSliderInput() {
  if (!state.currentGridVar) return;

  const dom = getGlobalDomainForGridVar(state.currentGridVar);
  if (!dom) return;

  const dataMin = dom.min;
  const dataMax = dom.max;

  state.gridMaxT = Number(state.el.gridMaxSlider.value) / 1000;
  state.gridDisplayMax = dataMin + state.gridMaxT * (dataMax - dataMin);

  state.el.gridMaxValue.innerHTML = `${fmt(state.gridDisplayMax)} ${GRID_UNITS_HTML}`;

  state.gridLayer?.redraw?.();
  updateGridLegend();
}

/* ===================== CHARTS ===================== */

// Draw bar error bars using dataset[0]._errMin/_errMax
const barErrorBarsPlugin = {
  id: "barErrorBars",
  afterDatasetsDraw(chart) {
    const emisSource = getEmisSource();
    if (!hasUncertainty(emisSource)) return;

    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.length) return;

    const ds = chart.data.datasets[0];
    const mins = ds._errMin || [];
    const maxs = ds._errMax || [];
    if (!mins.length || !maxs.length) return;

    const { ctx } = chart;
    ctx.save();
    ctx.lineWidth = 1;

    meta.data.forEach((barElem, i) => {
      const yMin = mins[i];
      const yMax = maxs[i];
      if (yMin == null || yMax == null || Number.isNaN(yMin) || Number.isNaN(yMax)) return;

      const x = barElem.x;
      const yTop = chart.scales.y.getPixelForValue(yMax);
      const yBot = chart.scales.y.getPixelForValue(yMin);
      const cap = 8;

      ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - cap, yTop); ctx.lineTo(x + cap, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - cap, yBot); ctx.lineTo(x + cap, yBot); ctx.stroke();
    });

    ctx.restore();
  },
};

function getRowFor(mode, year) {
  if (mode === "national") {
    const emisSource = getEmisSource();
    return (emisSource === "ghgi")
      ? (state.nationalPriorByYear?.[year] ?? null)
      : (state.nationalPosteriorByYear?.[year] ?? null);
  }

  if (!state.selectedState) return null;
  return state.dataByYear?.[year]?.[state.selectedState] ?? null;
}

function buildBarData(year, mode, emisSource) {
  const row = getRowFor(mode, year);
  if (!row) return { labels: [], values: [], mins: [], maxs: [] };

  const labels = state.sectorKeys;
  const values = labels.map(s => scaleVal(parseNumber(row[centralCol(s, mode, emisSource)])));

  if (!hasUncertainty(emisSource)) {
    return {
      labels,
      values,
      mins: labels.map(() => null),
      maxs: labels.map(() => null),
    };
  }

  return {
    labels,
    values,
    mins: labels.map(s => scaleVal(parseNumber(row[minCol(s)]))),
    maxs: labels.map(s => scaleVal(parseNumber(row[maxCol(s)]))),
  };
}

function buildLineData(mode, sectorKey, emisSource) {
  const yrs = activeYears(emisSource);
  const labels = yrs.map(String);

  const values = yrs.map(y => {
    const row = getRowFor(mode, y);
    return row ? scaleVal(parseNumber(row[centralCol(sectorKey, mode, emisSource)])) : null;
  });

  if (!hasUncertainty(emisSource)) {
    return { labels, values, mins: labels.map(() => null), maxs: labels.map(() => null) };
  }

  const mins = yrs.map(y => {
    const row = getRowFor(mode, y);
    return row ? scaleVal(parseNumber(row[minCol(sectorKey)])) : null;
  });

  const maxs = yrs.map(y => {
    const row = getRowFor(mode, y);
    return row ? scaleVal(parseNumber(row[maxCol(sectorKey)])) : null;
  });

  return { labels, values, mins, maxs };
}

function clearCharts() {
  if (!state.barChart || !state.lineChart) return;

  state.barChart.data.labels = [];
  state.barChart.data.datasets[0].data = [];
  state.barChart.data.datasets[0]._errMin = [];
  state.barChart.data.datasets[0]._errMax = [];
  state.barChart.options.plugins.title.text = "Click a state";
  state.barChart.update();

  state.lineChart.data.labels = [];
  state.lineChart.data.datasets[0].data = [];
  state.lineChart.data.datasets[1].data = [];
  state.lineChart.data.datasets[2].data = [];
  state.lineChart.options.plugins.title.text = "";
  state.lineChart.update();
}

function syncChartTitles() {
  const emisSource = getEmisSource();
  const suffix = emisSourceLabel(emisSource);

  if (state.el.barChartTitleText) {
    state.el.barChartTitleText.textContent = `Sector breakdown (${suffix})`;
  }
  if (state.el.lineChartTitle) state.el.lineChartTitle.textContent = `Timeseries (${suffix})`;

  if (state.barChart?.data?.datasets?.[0]) state.barChart.data.datasets[0].label = suffix;
  if (state.lineChart?.data?.datasets?.[2]) state.lineChart.data.datasets[2].label = suffix;
}

function updateCharts() {
  const mode = getChartMode();
  const emisSource = getEmisSource();
  const year = Number(state.el.yearSelect.value);
  const sectorKey = state.el.sectorSelect.value;
  const place = currentPlaceLabel(mode);

  syncChartTitles();
  updateDataHint();

  state.el.selectedState.textContent = (mode === "national")
    ? "National"
    : (state.selectedState ?? "(none)");

  if (!state.barChart || !state.lineChart) return;
  if (mode === "state" && !state.selectedState) return clearCharts();

  // BAR
  const bar = buildBarData(year, mode, emisSource);
  state.barChart.data.labels = bar.labels.map(labelSector);
  state.barChart.data.datasets[0].data = bar.values;
  state.barChart.data.datasets[0]._errMin = bar.mins;
  state.barChart.data.datasets[0]._errMax = bar.maxs;

  const finiteVals = bar.values.filter(Number.isFinite);
  const finiteMins = bar.mins.filter(Number.isFinite);
  const finiteMaxs = bar.maxs.filter(Number.isFinite);

  const overallMin = finiteMins.length ? Math.min(...finiteMins) : 0;
  const overallMax = finiteMaxs.length
    ? Math.max(...finiteMaxs)
    : (finiteVals.length ? Math.max(...finiteVals) : 1);

  const lim = getNiceLimits(overallMin, overallMax);
  state.barChart.options.scales.y.min = lim.min;
  state.barChart.options.scales.y.max = lim.max;
  state.barChart.options.scales.y.title.text = `Emissions (${state.unitLabel})`;
  state.barChart.options.plugins.title.text = `${place} – ${year} (${emisSourceLabel(emisSource)})`;
  state.barChart.update();

  // LINE
  const line = buildLineData(mode, sectorKey, emisSource);
  state.lineChart.data.labels = line.labels;

  if (hasUncertainty(emisSource)) {
    state.lineChart.data.datasets[0].data = line.mins;
    state.lineChart.data.datasets[1].data = line.maxs;
    state.lineChart.data.datasets[1].fill = "-1";
  } else {
    const blanks = line.labels.map(() => null);
    state.lineChart.data.datasets[0].data = blanks;
    state.lineChart.data.datasets[1].data = blanks;
    state.lineChart.data.datasets[1].fill = false;
  }

  state.lineChart.data.datasets[2].data = line.values;

  let lmin, lmax;
  if (hasUncertainty(emisSource)) {
    const finiteMins2 = line.mins.filter(Number.isFinite);
    const finiteMaxs2 = line.maxs.filter(Number.isFinite);
    lmin = finiteMins2.length ? Math.min(...finiteMins2) : 0;
    lmax = finiteMaxs2.length ? Math.max(...finiteMaxs2) : 1;
  } else {
    const finiteVals2 = line.values.filter(Number.isFinite);
    lmin = finiteVals2.length ? Math.min(...finiteVals2) : 0;
    lmax = finiteVals2.length ? Math.max(...finiteVals2) : 1;
  }

  const lim2 = getNiceLimits(lmin, lmax);
  state.lineChart.options.scales.y.min = lim2.min;
  state.lineChart.options.scales.y.max = lim2.max;
  state.lineChart.options.scales.y.title.text = `Emissions (${state.unitLabel})`;
  state.lineChart.options.plugins.title.text = `${place} – ${labelSector(sectorKey)} (${emisSourceLabel(emisSource)})`;
  state.lineChart.update();
}

function initCharts() {
  state.barChart = new Chart(state.el.barChart, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{ label: "Sector", data: [], _errMin: [], _errMax: [] }],
    },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: "Click a state" }, legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: `Emissions (${state.unitLabel})` } } },
    },
    plugins: [barErrorBarsPlugin],
  });

  state.lineChart = new Chart(state.el.lineChart, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "min", data: [], pointRadius: 0, borderWidth: 0 },
        { label: "max", data: [], pointRadius: 0, borderWidth: 0, fill: "-1", backgroundColor: "rgba(0,0,0,0.12)" },
        { label: "Value", data: [], tension: 0.2, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: "" }, legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: `Emissions (${state.unitLabel})` } } },
    },
  });
}

/* ===================== UI INIT + EVENTS ===================== */

function populateSelect(selectEl, items, defaultValue) {
  selectEl.innerHTML = "";
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = labelSector(item);
    selectEl.appendChild(opt);
  }
  selectEl.value = defaultValue ?? items[0] ?? "";
}

function initSelects() {
  const emisSource = getEmisSource();
  const yrs = activeYears(emisSource);

  // --- preserve current selections ---
  const prevYear = Number(state.el.yearSelect.value);
  const prevSector = state.el.sectorSelect.value;

  // --- year options (changes with source) ---
  state.el.yearSelect.innerHTML = "";
  for (const y of yrs) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    state.el.yearSelect.appendChild(opt);
  }

  // keep year if still available; otherwise fallback to latest
  const yearToUse = yrs.includes(prevYear) ? prevYear : yrs[yrs.length - 1];
  state.el.yearSelect.value = yearToUse;

  // --- sector options (should NOT depend on source) ---
  const defaultSector =
    state.sectorKeys.includes(DEFAULT_SECTOR) ? DEFAULT_SECTOR : (state.sectorKeys[0] ?? "");
  populateSelect(state.el.sectorSelect, state.sectorKeys, defaultSector);

  // restore sector if possible
  if (prevSector && state.sectorKeys.includes(prevSector)) {
    state.el.sectorSelect.value = prevSector;
  }
}

function updateDataHint() {
  if (!state.el.dataHint) return;
  state.el.dataHint.textContent =
    (getEmisSource() === "ghgi") ? "Note: GHGI selection only shows 2019–2020 data." : "";
}

function wireEvents() {
  // Mode toggle
  document.querySelectorAll('input[name="chartMode"]').forEach(el => {
    el.addEventListener("change", async () => {
      const mode = getChartMode();
      if (mode === "national") hideStatesOverlay();
      else { showStatesOverlay(); recolorStates(); }

      updateCharts();

      if (mode === "state" && state.gridLayer && state.statesLayer) {
        state.statesLayer.bringToFront();
      }
    });
  });

  // Data source selector
  state.el.dataSourceSelect?.addEventListener("change", async () => {
    state.emisSource = getEmisSource();

    initSelects();
    syncChartTitles();
    recolorStates();
    updateCharts();

    // Refresh grid to prior/posterior tif (and reset scaling)
    await setGridLayerForSelection();
  });

  // Year/Sector
  state.el.yearSelect.addEventListener("change", async () => {
    recolorStates();
    updateCharts();
    await setGridLayerForSelection();
  });

  state.el.sectorSelect.addEventListener("change", async () => {
    updateCharts();
    await setGridLayerForSelection();
  });

  // Units
  state.el.unitSelect.addEventListener("change", () => {
    setUnits(state.el.unitSelect.value);
    updateCharts();
  });

  // CSV export
  state.el.downloadBarCsv?.addEventListener("click", () => {
    const mode = getChartMode();
    if (mode === "state" && !state.selectedState) {
      alert("Click a state first (or switch to National).");
      return;
    }
    const year = state.el.yearSelect.value;
    const place = (mode === "national") ? "National" : state.selectedState;
    const filename = `bar_${mode}_${place}_${year}_${state.unit}.csv`.replace(/\s+/g, "_");
    downloadText(filename, toCSV(makeBarCsvRows(mode, Number(year))));
  });

  state.el.downloadLineCsv?.addEventListener("click", () => {
    const mode = getChartMode();
    if (mode === "state" && !state.selectedState) {
      alert("Click a state first (or switch to National).");
      return;
    }
    const sectorKey = state.el.sectorSelect.value;
    const place = (mode === "national") ? "National" : state.selectedState;
    const filename = `timeseries_${mode}_${place}_${labelSector(sectorKey)}_${state.unit}.csv`
      .replace(/\s+/g, "_");
    downloadText(filename, toCSV(makeLineCsvRows(mode, sectorKey)));
  });

  state.el.downloadNetcdf?.addEventListener("click", () => {
    const year = Number(state.el.yearSelect.value);
    const emisSource = getEmisSource();

    const url = NETCDF_PATH(year, emisSource); // or NETCDF_PATH(year, emisSource)
    const filename = `emissions_${emisSourceLabel(emisSource)}_${year}.nc`.replace(/\s+/g, "_");

    downloadUrl(filename, url);
  });

  // Grid toggle + slider
  state.el.gridOpacitySlider?.addEventListener("input", () => {
    applyGridOpacity();
  });

  state.el.gridMaxSlider.addEventListener("input", handleGridSliderInput);
}

function handleResponsiveResize() {
  state.map?.invalidateSize();
  state.barChart?.resize();
  state.lineChart?.resize();
}

/* ===================== MAP INIT ===================== */

async function initMap() {
  state.map = L.map("map").setView([39, -98], 4);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);

  const res = await fetch(STATES_GEOJSON_PATH);
  const statesGeo = await res.json();

  state.statesLayer = L.geoJSON(statesGeo, {
    style: (feature) => makeChoroplethStyle(Number(state.el.yearSelect.value), feature),
    onEachFeature: (feature, layer) => {
      layer.on("click", () => {
        const props = feature.properties || {};
        state.selectedState = props.name || props.NAME || props.STATE_NAME;

        recolorStates();
        updateCharts();
      });

      layer.on("mouseover", () => layer.setStyle({ weight: 2 }));
      layer.on("mouseout", () => recolorStates());
    },
  }).addTo(state.map);

  // Grid legend control
  state.gridLegendControl = L.control({ position: "bottomright" });
  state.gridLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div");
    div.className = "legend";
    div.innerHTML = "";
    return div;
  };
  state.gridLegendControl.addTo(state.map);
  L.DomEvent.disableClickPropagation(state.gridLegendControl.getContainer());
}

/* ===================== BOOTSTRAP ===================== */

async function main() {
  state.el = {
    yearSelect: $("yearSelect"),
    sectorSelect: $("sectorSelect"),
    unitSelect: $("unitSelect"),
    dataSourceSelect: $("dataSourceSelect"),
    gridOpacitySlider: $("gridOpacitySlider"),
    gridOpacityValue: $("gridOpacityValue"),
    gridMaxSlider: $("gridMaxSlider"),
    gridMaxValue: $("gridMaxValue"),
    selectedState: $("selectedState"),
    downloadBarCsv: $("downloadBarCsv"),
    downloadLineCsv: $("downloadLineCsv"),
    downloadNetcdf: $("downloadNetcdf"),
    barChart: $("barChart"),
    lineChart: $("lineChart"),
    barChartTitleText: $("barChartTitleText"),
    lineChartTitle: $("lineChartTitle"),
    dataHint: $("dataHint"),
  };

  await loadStateCSVs();
  await loadNationalCSVs();

  initSelects();
  setUnits(state.el.unitSelect.value);

  await initMap();
  initCharts();
  syncChartTitles();

  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer);
    window.__resizeTimer = setTimeout(handleResponsiveResize, 150);
  });


  if (getChartMode() === "national") hideStatesOverlay();

  recolorStates();
  updateCharts();

  syncGridOpacityUI();
  await setGridLayerForSelection();
  applyGridOpacity();

  wireEvents();
}

main();
