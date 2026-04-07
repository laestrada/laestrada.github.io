/* =========================================================
   app.js

   Responsibilities:
   - Load manifest-driven regional methane data
   - Render Leaflet map with GeoTIFF overlay
   - Show monthly regional summary charts
   - Export current chart data and source NetCDF
   ========================================================= */

const DASHBOARD_CONFIG = window.NRT_DASHBOARD_CONFIG ?? {};
const DATA_ROOT_URL = DASHBOARD_CONFIG.dataRootUrl ?? "https://conus-emissions-test-bucket.s3.amazonaws.com/";
const GRID_MANIFEST_PATH = DASHBOARD_CONFIG.manifestPath ?? "data/manifest.json";
const GRID_COLORMAP = "ylorrd";
const GRID_OPACITY = 0.5;
const GRID_RESOLUTION = 256;
const LINE_COLORS = [
  "#0e5a8a",
  "#b85c38",
  "#4e7f46",
  "#7d5ba6",
  "#a6466d",
  "#8a6a0e",
];

const state = {
  manifest: null,
  map: null,
  gridLayer: null,
  gridGeoraster: null,
  gridLegendControl: null,
  gridTooltip: null,
  gridDisplayMax: null,
  gridOpacity: GRID_OPACITY,
  barChart: null,
  lineChart: null,
  lineCompareDatasets: [],
  lineCompareCustomized: false,
  lineShowMovingAverage: false,
  chartsExpanded: false,
  el: {},
};

function $(id) {
  return document.getElementById(id);
}

function isAbsoluteUrl(value) {
  return /^[a-z]+:\/\//i.test(value);
}

function resolveDataUrl(path) {
  if (!path) return path;
  if (isAbsoluteUrl(path)) return path;
  return new URL(path.replace(/^\//, ""), DATA_ROOT_URL).toString();
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

function datasetOptions() {
  return state.manifest?.datasets ?? [];
}

function variableOptions() {
  return state.manifest?.variables ?? [];
}

function periodOptions() {
  return state.manifest?.periods ?? [];
}

function getSelectedDataset() {
  return state.el.datasetSelect.value;
}

function getSelectedVariable() {
  return state.el.variableSelect.value;
}

function getSelectedPeriod() {
  return state.el.periodSelect.value;
}

function getSelectedPeriodMeta() {
  return periodOptions().find((period) => period.key === getSelectedPeriod()) ?? null;
}

function getSelectedVariableMeta() {
  return variableOptions().find((variable) => variable.key === getSelectedVariable()) ?? null;
}

function getSelectedDatasetMeta() {
  return datasetOptions().find((dataset) => dataset.key === getSelectedDataset()) ?? null;
}

function getEntry(datasetKey, variableKey, periodKey) {
  return state.manifest?.data?.[datasetKey]?.[variableKey]?.[periodKey] ?? null;
}

function currentSummaryUnitLabel() {
  return state.el.unitSelect.value === "Gg" ? "Gg/month" : "Tg/month";
}

function scaleTotal(totalKg) {
  if (!Number.isFinite(totalKg)) return null;
  return state.el.unitSelect.value === "Gg" ? totalKg / 1e6 : totalKg / 1e9;
}

function datasetLabel(key) {
  return datasetOptions().find((dataset) => dataset.key === key)?.label ?? key;
}

function variableLabel(key) {
  return variableOptions().find((variable) => variable.key === key)?.label ?? key;
}

function periodLabel(key) {
  return state.manifest?.periods?.find((period) => period.key === key)?.label ?? key;
}

function toCSV(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function resizeChartsSoon() {
  setTimeout(() => {
    state.barChart?.resize();
    state.lineChart?.resize();
  }, 0);
}

function applyChartSizeState() {
  if (!state.el.layout || !state.el.toggleChartSize) return;
  state.el.layout.classList.toggle("chartsWide", state.chartsExpanded);
  state.el.toggleChartSize.setAttribute(
    "aria-label",
    state.chartsExpanded ? "Collapse charts panel width" : "Expand charts panel width"
  );
  if (state.el.toggleChartArrow) {
    state.el.toggleChartArrow.textContent = state.chartsExpanded ? "▶" : "◀";
  }
  state.map?.invalidateSize();
  resizeChartsSoon();
}

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadUrl(filename, url) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function getBarData() {
  const datasetKey = getSelectedDataset();
  const periodKey = getSelectedPeriod();

  const rows = variableOptions().map((variable) => {
    const entry = getEntry(datasetKey, variable.key, periodKey);
    return {
      key: variable.key,
      label: variable.label,
      value: scaleTotal(Number(entry?.total_kg)),
    };
  });

  return rows.filter((row) => Number.isFinite(row.value));
}

function getRawLineData(datasetKey) {
  const variableKey = getSelectedVariable();
  return periodOptions().map((period) => {
    const entry = getEntry(datasetKey, variableKey, period.key);
    return {
      key: period.key,
      label: period.label,
      value: scaleTotal(Number(entry?.total_kg)),
    };
  });
}

function centeredMovingAverage(rows) {
  return rows.map((row, index) => {
    if (index === 0 || index === rows.length - 1) {
      return { ...row, value: null };
    }

    const prev = rows[index - 1]?.value;
    const curr = rows[index]?.value;
    const next = rows[index + 1]?.value;
    const values = [prev, curr, next];

    if (!values.every(Number.isFinite)) {
      return { ...row, value: null };
    }

    return {
      ...row,
      value: (prev + curr + next) / 3,
    };
  });
}

function visibleLineDatasetKeys() {
  return datasetOptions()
    .map((dataset) => dataset.key)
    .filter((key) => state.lineCompareDatasets.includes(key));
}

function lineModeLabel() {
  return state.lineShowMovingAverage ? "Centered 3-month moving average" : "Monthly totals";
}

function buildLineSeries() {
  const visibleKeys = visibleLineDatasetKeys();
  return visibleKeys.map((datasetKey) => {
    const rawRows = getRawLineData(datasetKey);
    const rows = state.lineShowMovingAverage ? centeredMovingAverage(rawRows) : rawRows;

    return {
      key: datasetKey,
      label: datasetLabel(datasetKey),
      rows,
    };
  });
}

function getNiceLimits(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: undefined, max: undefined };

  const maxVal = Math.max(...finite);
  if (maxVal <= 0) return { min: 0, max: 1 };
  return { min: 0, max: maxVal * 1.1 };
}

function populateSelect(selectEl, items, getValue, getLabel, defaultValue) {
  selectEl.innerHTML = "";
  for (const item of items) {
    const option = document.createElement("option");
    option.value = getValue(item);
    option.textContent = getLabel(item);
    selectEl.appendChild(option);
  }
  const fallbackValue = items.length ? getValue(items[0]) : "";
  const nextValue = defaultValue ?? fallbackValue;
  selectEl.value = items.some((item) => getValue(item) === nextValue) ? nextValue : fallbackValue;
}

function updateSelectionSummary() {
  const dataset = getSelectedDatasetMeta();
  const variable = getSelectedVariableMeta();
  const period = getSelectedPeriodMeta();
  const entry = getEntry(getSelectedDataset(), getSelectedVariable(), getSelectedPeriod());

  state.el.selectionSummary.innerHTML = `
    <strong>Selected:</strong>
    ${dataset?.label ?? ""},
    ${variable?.label ?? ""},
    ${period?.label ?? ""}
  `;

  state.el.selectionStats.textContent = entry
    ? `Regional total: ${fmt(scaleTotal(Number(entry.total_kg)))} ${currentSummaryUnitLabel()}`
    : "No summary available for this selection.";
}

function getGlobalDomain(variableKey) {
  let min = Infinity;
  let max = -Infinity;

  for (const dataset of datasetOptions()) {
    const periodMap = state.manifest?.data?.[dataset.key]?.[variableKey] ?? {};
    for (const entry of Object.values(periodMap)) {
      if (!entry) continue;
      const entryMin = Number(entry.min);
      const entryMax = Number(entry.max);
      if (Number.isFinite(entryMin)) min = Math.min(min, entryMin);
      if (Number.isFinite(entryMax)) max = Math.max(max, entryMax);
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

function syncGridOpacityUI() {
  state.el.gridOpacityValue.textContent = `${Math.round(state.gridOpacity * 100)}%`;
}

function syncGridSlider() {
  const domain = getGlobalDomain(getSelectedVariable());
  if (!domain) {
    state.el.gridMaxSlider.disabled = true;
    state.el.gridMaxValue.textContent = "";
    return;
  }

  state.el.gridMaxSlider.disabled = false;
  if (state.gridDisplayMax == null) state.gridDisplayMax = domain.max;
  state.gridDisplayMax = Math.max(domain.min, Math.min(domain.max, state.gridDisplayMax));

  const t = (state.gridDisplayMax - domain.min) / (domain.max - domain.min);
  state.el.gridMaxSlider.value = String(Math.round(t * 1000));
  state.el.gridMaxValue.innerHTML = `${fmt(state.gridDisplayMax)} ${state.manifest.grid_units_html}`;
}

function updateGridLegend() {
  const container = state.gridLegendControl?._container;
  if (!container) return;

  const variable = getSelectedVariableMeta();
  const domain = getGlobalDomain(getSelectedVariable());
  if (!variable || !domain) {
    container.innerHTML = "";
    return;
  }

  const steps = 40;
  const colors = [];
  for (let i = 0; i < steps; i++) {
    colors.push(chroma.scale(GRID_COLORMAP)(i / (steps - 1)).hex());
  }

  container.innerHTML = `
    <div class="legend">
      <div class="title">${variable.label}</div>
      <div class="units">${state.manifest.grid_units_html}</div>
      <div class="bar" style="background:linear-gradient(to right, ${colors.join(",")});"></div>
      <div class="labels">
        <span>${fmt(domain.min)}</span>
        <span>${fmt(state.gridDisplayMax ?? domain.max)}</span>
      </div>
    </div>
  `;
}

function closeGridTooltip() {
  if (state.gridTooltip && state.map) {
    state.map.closeTooltip(state.gridTooltip);
  }
}

function getGridCellValue(latlng) {
  const georaster = state.gridGeoraster;
  if (!georaster) return null;

  const { xmin, xmax, ymin, ymax, width, height, values } = georaster;
  if (
    latlng.lng < xmin || latlng.lng > xmax ||
    latlng.lat < ymin || latlng.lat > ymax
  ) {
    return null;
  }

  const col = Math.floor(((latlng.lng - xmin) / (xmax - xmin)) * width);
  const row = Math.floor(((ymax - latlng.lat) / (ymax - ymin)) * height);
  const clampedCol = Math.max(0, Math.min(width - 1, col));
  const clampedRow = Math.max(0, Math.min(height - 1, row));
  const value = values?.[0]?.[clampedRow]?.[clampedCol];

  return Number.isFinite(value) ? value : null;
}

function updateGridTooltip(latlng) {
  const value = getGridCellValue(latlng);
  if (!Number.isFinite(value)) {
    closeGridTooltip();
    return;
  }

  const variable = getSelectedVariableMeta()?.label ?? "Emissions";
  const html = `
    <strong>${variable}</strong><br>
    ${fmt(value)} kg h<sup>-1</sup>
  `;

  if (!state.gridTooltip) {
    state.gridTooltip = L.tooltip({
      permanent: false,
      direction: "top",
      opacity: 0.95,
      sticky: true,
    });
  }

  state.gridTooltip
    .setLatLng(latlng)
    .setContent(html);

  if (state.map && !state.gridTooltip.isOpen?.()) {
    state.gridTooltip.addTo(state.map);
  }
}

async function setGridLayerForSelection() {
  const datasetKey = getSelectedDataset();
  const variableKey = getSelectedVariable();
  const periodKey = getSelectedPeriod();
  const entry = getEntry(datasetKey, variableKey, periodKey);

  if (state.gridLayer) {
    state.map.removeLayer(state.gridLayer);
    state.gridLayer = null;
  }
  state.gridGeoraster = null;
  closeGridTooltip();

  if (!entry) {
    updateGridLegend();
    syncGridSlider();
    return;
  }

  const response = await fetch(resolveDataUrl(entry.tif));
  const arrayBuffer = await response.arrayBuffer();
  const georaster = await parseGeoraster(arrayBuffer);
  state.gridGeoraster = georaster;
  const domain = getGlobalDomain(variableKey);

  state.gridLayer = new GeoRasterLayer({
    georaster,
    opacity: state.gridOpacity,
    resolution: GRID_RESOLUTION,
    pixelValuesToColorFn: (values) => {
      const value = values?.[0];
      if (value == null || Number.isNaN(value)) return null;
      const min = domain?.min ?? 0;
      const max = state.gridDisplayMax ?? domain?.max ?? 1;
      const t = Math.max(0, Math.min(1, (value - min) / ((max - min) || 1)));
      return chroma.scale(GRID_COLORMAP)(t).hex();
    },
  });

  state.gridLayer.addTo(state.map);
  syncGridSlider();
  updateGridLegend();
}

function updateBarChart() {
  const rows = getBarData();
  const values = rows.map((row) => row.value);
  const limits = getNiceLimits(values);

  state.barChart.data.labels = rows.map((row) => row.label);
  state.barChart.data.datasets[0].data = values;
  state.barChart.options.scales.y.min = limits.min;
  state.barChart.options.scales.y.max = limits.max;
  state.barChart.options.scales.y.title.text = `Regional emissions (${currentSummaryUnitLabel()})`;
  state.barChart.options.plugins.title.text =
    `${periodLabel(getSelectedPeriod())} sector totals (${datasetLabel(getSelectedDataset())})`;
  state.barChart.update();
}

function updateTimeseriesControls() {
  if (!state.el.lineDatasetList) return;

  const selected = new Set(state.lineCompareDatasets);
  state.el.lineDatasetList.innerHTML = "";

  for (const dataset of datasetOptions()) {
    const label = document.createElement("label");
    label.className = "dataset-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = dataset.key;
    input.checked = selected.has(dataset.key);
    input.addEventListener("change", () => {
      state.lineCompareCustomized = true;
      state.lineCompareDatasets = Array.from(
        state.el.lineDatasetList.querySelectorAll('input[type="checkbox"]:checked')
      ).map((el) => el.value);
      updateLineChart();
    });

    const text = document.createElement("span");
    text.textContent = dataset.label;

    label.appendChild(input);
    label.appendChild(text);
    state.el.lineDatasetList.appendChild(label);
  }
}

function syncDefaultLineDatasetSelection() {
  if (state.lineCompareCustomized) return;
  state.lineCompareDatasets = [getSelectedDataset()];
  updateTimeseriesControls();
}

function buildLineChartDatasets(seriesList) {
  return seriesList.map((series) => {
    const datasetIndex = datasetOptions().findIndex((dataset) => dataset.key === series.key);
    const color = LINE_COLORS[(datasetIndex >= 0 ? datasetIndex : 0) % LINE_COLORS.length];
    return {
      label: series.label,
      data: series.rows.map((row) => row.value),
      borderColor: color,
      backgroundColor: `${color}22`,
      fill: false,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.2,
      spanGaps: false,
    };
  });
}

function updateLineChart() {
  const seriesList = buildLineSeries();
  const labels = periodOptions().map((period) => period.label);
  const values = seriesList.flatMap((series) => series.rows.map((row) => row.value));
  const limits = getNiceLimits(values);

  state.lineChart.data.labels = labels;
  state.lineChart.data.datasets = buildLineChartDatasets(seriesList);
  state.lineChart.options.scales.y.min = limits.min;
  state.lineChart.options.scales.y.max = limits.max;
  state.lineChart.options.scales.y.title.text = `Regional emissions (${currentSummaryUnitLabel()})`;
  state.lineChart.options.plugins.title.text =
    `${variableLabel(getSelectedVariable())} ${lineModeLabel()}`;
  state.lineChart.update();
}

function updateCharts() {
  updateSelectionSummary();
  updateBarChart();
  updateLineChart();
}

function makeBarCsvRows() {
  const dataset = getSelectedDatasetMeta();
  const period = getSelectedPeriodMeta();
  const rows = [
    ["type", "regional_bar"],
    ["dataset", dataset?.label ?? ""],
    ["period", period?.label ?? ""],
    ["units", currentSummaryUnitLabel()],
    [],
    ["sector", "value"],
  ];

  for (const row of getBarData()) {
    rows.push([row.label, row.value]);
  }
  return rows;
}

function makeLineCsvRows() {
  const variable = getSelectedVariableMeta();
  const seriesList = buildLineSeries();
  const header = ["period", ...seriesList.map((series) => series.label)];
  const rows = [
    ["type", "regional_timeseries"],
    ["sector", variable?.label ?? ""],
    ["units", currentSummaryUnitLabel()],
    ["moving_average_enabled", state.lineShowMovingAverage ? "true" : "false"],
    ["moving_average_mode", "centered_3_month"],
    ["visible_datasets", seriesList.map((series) => series.label).join("; ")],
    [],
    header,
  ];

  const periods = periodOptions();
  for (let i = 0; i < periods.length; i++) {
    rows.push([
      periods[i].label,
      ...seriesList.map((series) => series.rows[i]?.value ?? null),
    ]);
  }

  return rows;
}

function initCharts() {
  state.barChart = new Chart(state.el.barChart, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        data: [],
        backgroundColor: "#d47d2a",
        borderColor: "#8f4d11",
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: "" },
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "" },
        },
      },
    },
  });

  state.lineChart = new Chart(state.el.lineChart, {
    type: "line",
    data: {
      labels: [],
      datasets: [],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: "" },
        legend: {
          display: true,
          position: "bottom",
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "" },
        },
      },
    },
  });
}

async function initMap() {
  const bounds = state.manifest.bounds;
  state.map = L.map("map", { zoomControl: false });
  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);

  state.map.fitBounds([
    [bounds.south, bounds.west],
    [bounds.north, bounds.east],
  ], { padding: [20, 20] });

  state.gridLegendControl = L.control({ position: "bottomleft" });
  state.gridLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div");
    div.className = "legend-wrap";
    return div;
  };
  state.gridLegendControl.addTo(state.map);
  L.DomEvent.disableClickPropagation(state.gridLegendControl.getContainer());

  state.map.on("mousemove", (event) => {
    updateGridTooltip(event.latlng);
  });
  state.map.on("mouseout", () => {
    closeGridTooltip();
  });
}

function wireEvents() {
  state.el.datasetSelect.addEventListener("change", async () => {
    state.gridDisplayMax = null;
    syncDefaultLineDatasetSelection();
    await setGridLayerForSelection();
    updateCharts();
  });

  state.el.variableSelect.addEventListener("change", async () => {
    state.gridDisplayMax = null;
    await setGridLayerForSelection();
    updateCharts();
  });

  state.el.periodSelect.addEventListener("change", async () => {
    await setGridLayerForSelection();
    updateCharts();
  });

  state.el.unitSelect.addEventListener("change", () => {
    updateCharts();
  });

  state.el.lineMovingAverageToggle.addEventListener("change", () => {
    state.lineShowMovingAverage = state.el.lineMovingAverageToggle.checked;
    updateLineChart();
  });

  state.el.gridOpacitySlider.addEventListener("input", () => {
    state.gridOpacity = Number(state.el.gridOpacitySlider.value) / 100;
    syncGridOpacityUI();
    if (state.gridLayer?.setOpacity) {
      state.gridLayer.setOpacity(state.gridOpacity);
    } else if (state.gridLayer?.options) {
      state.gridLayer.options.opacity = state.gridOpacity;
      state.gridLayer.redraw?.();
    }
  });

  state.el.gridMaxSlider.addEventListener("input", () => {
    const domain = getGlobalDomain(getSelectedVariable());
    if (!domain) return;
    const t = Number(state.el.gridMaxSlider.value) / 1000;
    state.gridDisplayMax = domain.min + t * (domain.max - domain.min);
    state.el.gridMaxValue.innerHTML = `${fmt(state.gridDisplayMax)} ${state.manifest.grid_units_html}`;
    state.gridLayer?.redraw?.();
    updateGridLegend();
  });

  state.el.downloadBarCsv.addEventListener("click", () => {
    const dataset = datasetLabel(getSelectedDataset()).replace(/\s+/g, "_");
    const period = periodLabel(getSelectedPeriod()).replace(/\s+/g, "_");
    downloadText(`regional_bar_${dataset}_${period}.csv`, toCSV(makeBarCsvRows()));
  });

  state.el.downloadLineCsv.addEventListener("click", () => {
    const variable = variableLabel(getSelectedVariable()).replace(/\s+/g, "_");
    downloadText(`regional_timeseries_${variable}.csv`, toCSV(makeLineCsvRows()));
  });

  state.el.downloadNetcdf.addEventListener("click", () => {
    const entry = getEntry(getSelectedDataset(), getSelectedVariable(), getSelectedPeriod());
    if (!entry?.nc) return;
    const dataset = datasetLabel(getSelectedDataset()).replace(/\s+/g, "_");
    const period = periodLabel(getSelectedPeriod()).replace(/\s+/g, "_");
    downloadUrl(`emissions_${dataset}_${period}.nc`, resolveDataUrl(entry.nc));
  });

  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer);
    window.__resizeTimer = setTimeout(() => {
      state.map?.invalidateSize();
      state.barChart?.resize();
      state.lineChart?.resize();
    }, 150);
  });

  state.el.toggleChartSize?.addEventListener("click", () => {
    state.chartsExpanded = !state.chartsExpanded;
    applyChartSizeState();
  });
}

function initControls() {
  populateSelect(
    state.el.datasetSelect,
    datasetOptions(),
    (item) => item.key,
    (item) => item.label,
    state.manifest.defaults?.dataset ?? "posterior"
  );

  populateSelect(
    state.el.variableSelect,
    variableOptions(),
    (item) => item.key,
    (item) => item.label,
    state.manifest.defaults?.variable ?? variableOptions()[0]?.key
  );

  populateSelect(
    state.el.periodSelect,
    periodOptions(),
    (item) => item.key,
    (item) => item.label,
    periodOptions()[periodOptions().length - 1]?.key
  );

  state.lineCompareDatasets = [getSelectedDataset()];
  state.lineCompareCustomized = false;
  state.lineShowMovingAverage = false;
  state.chartsExpanded = false;
  state.el.lineMovingAverageToggle.checked = false;
  updateTimeseriesControls();
  syncGridOpacityUI();
  applyChartSizeState();
}

async function main() {
  state.el = {
    datasetSelect: $("datasetSelect"),
    variableSelect: $("variableSelect"),
    periodSelect: $("periodSelect"),
    unitSelect: $("unitSelect"),
    lineMovingAverageToggle: $("lineMovingAverageToggle"),
    lineDatasetList: $("lineDatasetList"),
    gridOpacitySlider: $("gridOpacitySlider"),
    gridOpacityValue: $("gridOpacityValue"),
    gridMaxSlider: $("gridMaxSlider"),
    gridMaxValue: $("gridMaxValue"),
    selectionSummary: $("selectionSummary"),
    selectionStats: $("selectionStats"),
    chartsSection: $("chartsSection"),
    layout: $("layout"),
    toggleChartSize: $("toggleChartSize"),
    toggleChartArrow: $("toggleChartArrow"),
    downloadBarCsv: $("downloadBarCsv"),
    downloadLineCsv: $("downloadLineCsv"),
    downloadNetcdf: $("downloadNetcdf"),
    barChart: $("barChart"),
    lineChart: $("lineChart"),
  };

  state.manifest = await (await fetch(resolveDataUrl(GRID_MANIFEST_PATH))).json();
  document.title = state.manifest.title ?? document.title;
  $("panelTitle").textContent = state.manifest.title ?? $("panelTitle").textContent;
  $("panelSubtitle").textContent =
    state.manifest.description ?? $("panelSubtitle").textContent;

  initControls();
  await initMap();
  initCharts();
  wireEvents();
  await setGridLayerForSelection();
  updateCharts();
}

main().catch((error) => {
  console.error(error);
  const subtitle = $("panelSubtitle");
  if (subtitle) subtitle.textContent = "Failed to load dashboard data. Check the browser console for details.";
});
