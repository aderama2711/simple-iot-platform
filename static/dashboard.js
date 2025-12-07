// static/dashboard.js — robust fix to prevent stacked charts / duplicate intervals
// Behavior:
// - Ensures only one <canvas id="chart"> exists (recreate it fresh each build)
// - Properly destroys previous Chart instance
// - Prevents duplicate polling intervals if script loads multiple times

const API_PATH = `/api/telemetry/${DEVICE_ID}`;
const POLL_INTERVAL = 3000;
const CHART_MAX_POINTS = 100;

// single global holder to avoid duplicates across hot-reloads
if (!window.__IOT_DASHBOARD) {
  window.__IOT_DASHBOARD = {
    chartInstance: null,
    pollHandle: null,
    lastKeysHash: null
  };
}
const glo = window.__IOT_DASHBOARD;

function colorForIndex(i) {
  const hue = (i * 47) % 360;
  return `hsl(${hue} 65% 45%)`;
}
function isoToLocalLabel(iso) {
  try { return new Date(iso).toLocaleTimeString(); } catch(e) { return iso || ""; }
}

async function fetchTelemetry(limit = 200) {
  const res = await fetch(`${API_PATH}?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function renderTable(items) {
  const tbody = document.querySelector("#telemetry-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  items.slice().reverse().forEach((it, idx) => {
    const tr = document.createElement("tr");
    const iCell = document.createElement("td"); iCell.textContent = idx + 1;
    const tsCell = document.createElement("td"); tsCell.textContent = isoToLocalLabel(it.timestamp || "");
    const payloadCell = document.createElement("td"); payloadCell.textContent = JSON.stringify(it.data || it, null, 0);
    tr.appendChild(iCell); tr.appendChild(tsCell); tr.appendChild(payloadCell);
    tbody.appendChild(tr);
  });
}

function buildSeries(items) {
  const timestamps = items.map(it => it.timestamp || "");
  const numericKeys = new Set();

  for (const it of items) {
    const data = it.data || {};
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (typeof v === 'number') numericKeys.add(k);
      else if (typeof v === 'string' && v !== "" && !isNaN(Number(v))) numericKeys.add(k);
    }
  }

  const keys = Array.from(numericKeys).sort();
  const series = {};
  for (const k of keys) series[k] = Array(items.length).fill(null);

  items.forEach((it, idx) => {
    const data = it.data || {};
    for (const k of keys) {
      if (k in data) {
        const raw = data[k];
        const num = (typeof raw === 'number') ? raw : (raw === "" ? null : Number(raw));
        series[k][idx] = Number.isFinite(num) ? num : null;
      } else {
        series[k][idx] = null;
      }
    }
  });

  return { timestamps, keys, series };
}

function chartDatasetsFromSeries(keys, series) {
  return keys.map((k, i) => ({
    label: k,
    data: series[k].slice(-CHART_MAX_POINTS),
    tension: 0.25,
    spanGaps: false,
    borderColor: colorForIndex(i),
    backgroundColor: colorForIndex(i),
    pointRadius: 2,
    pointHoverRadius: 4,
  }));
}

// Ensure a single canvas element exists: if not exist create, else reuse but clear parent to avoid duplicates
function ensureSingleCanvas() {
  const container = document.getElementById('chart-container');
  if (!container) {
    // if user didn't set wrapper, fallback to body area near canvas id
    const canvas = document.getElementById('chart');
    if (canvas) return canvas;
    // No canvas anywhere — create at end of body
    const newC = document.createElement('canvas');
    newC.id = 'chart';
    document.body.appendChild(newC);
    return newC;
  }

  // If container has other children, remove only canvas children to avoid duplicates, then create one canvas
  // We recreate canvas element fresh each time to avoid Chart.js internal issues
  // but keep non-canvas children intact (like headings)
  // Remove existing canvas elements
  const existingCanvases = container.querySelectorAll('canvas#chart');
  existingCanvases.forEach(c => c.remove());

  // Create fresh canvas
  const canvas = document.createElement('canvas');
  canvas.id = 'chart';
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '360px';
  container.appendChild(canvas);
  // set internal pixel height for crispness
  const cssHeight = parseInt(window.getComputedStyle(canvas).height, 10) || 360;
  canvas.height = cssHeight * (window.devicePixelRatio || 1);
  return canvas;
}

// Destroy previous chart safely
function safeDestroyChart() {
  try {
    if (glo.chartInstance) {
      try { glo.chartInstance.destroy(); } catch(e) { console.warn("chart destroy err", e); }
      glo.chartInstance = null;
    }
  } catch (e) {
    console.warn("safeDestroyChart err", e);
    glo.chartInstance = null;
  }
}

function buildChartOnCanvas(canvasElem, labels = [], datasets = []) {
  // ensure single canvas exists (we recreate canvas earlier)
  // destroy previous chart
  safeDestroyChart();

  const ctx = canvasElem.getContext('2d');
  const cfg = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', axis: 'x', intersect: false },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: {
          title: { display: true, text: 'time' },
          ticks: { autoSkip: true, maxRotation: 0, minRotation: 0 }
        },
        y: {
          title: { display: true, text: 'value' },
          beginAtZero: false
        }
      }
    }
  };

  glo.chartInstance = new Chart(ctx, cfg);
  return glo.chartInstance;
}

async function refreshOnce() {
  try {
    const items = await fetchTelemetry(200);
    if (!Array.isArray(items)) return;
    renderTable(items);

    const { timestamps, keys, series } = buildSeries(items);
    const labels = timestamps.slice(-CHART_MAX_POINTS).map(t => isoToLocalLabel(t));
    const datasets = chartDatasetsFromSeries(keys, series);

    // create or reset canvas safely
    const canvas = ensureSingleCanvas();
    if (!canvas) return;

    // build chart on canvas (destroy old if present)
    buildChartOnCanvas(canvas, labels, datasets);

  } catch (err) {
    console.error("refreshOnce error:", err);
  }
}

function startPolling() {
  if (glo.pollHandle) {
    // already polling
    return;
  }
  // do first immediately, then periodic
  refreshOnce();
  glo.pollHandle = setInterval(refreshOnce, POLL_INTERVAL);
}

function stopPolling() {
  if (glo.pollHandle) {
    clearInterval(glo.pollHandle);
    glo.pollHandle = null;
  }
}

// initialize
(function init() {
  // Provide a stable wrapper element expected by ensureSingleCanvas
  // If there's no #chart-container in template, try to create it immediately next to existing canvas
  if (!document.getElementById('chart-container')) {
    const existingCanvas = document.getElementById('chart');
    if (existingCanvas && existingCanvas.parentElement) {
      // wrap existing canvas in a container div (preserve other siblings)
      const wrapper = document.createElement('div');
      wrapper.id = 'chart-container';
      existingCanvas.parentElement.insertBefore(wrapper, existingCanvas);
      wrapper.appendChild(existingCanvas);
    } else {
      // create container at end of first main wrapper if exists
      const mainWrap = document.querySelector('.wrap') || document.body;
      const wrapper = document.createElement('div');
      wrapper.id = 'chart-container';
      // insert before the telemetry table section if exists
      const table = document.getElementById('telemetry-table');
      if (table && table.parentElement) {
        table.parentElement.insertBefore(wrapper, table);
      } else {
        mainWrap.insertBefore(wrapper, mainWrap.firstChild);
      }
    }
  }

  // Start polling but avoid duplicate intervals across hot reloads
  startPolling();
})();
