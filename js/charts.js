/**
 * Chart.js wrappers.
 *
 * Chart.js is vendored in /vendor (UMD, not an ES module), so it is loaded
 * lazily with a plain <script> tag the first time a chart is needed. The
 * service worker precaches it, so charts work offline too.
 *
 * All charts are themed from the brand palette and configured for Arabic
 * right-to-left labels/tooltips.
 */
import { num, numInt } from './utils.js';

const CHART_SRC = './vendor/chart.umd.js';
let chartPromise = null;
const registry = new Map(); // canvas → Chart instance

export const PALETTE = ['#6b1d2f', '#c99750', '#1b3b36', '#b06a76', '#8a9e6f', '#7d6ea8', '#5f8ba3', '#d19a4a'];

function loadChartJS() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (chartPromise) return chartPromise;
  chartPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHART_SRC;
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => {
      chartPromise = null;
      reject(new Error('failed to load chart library'));
    };
    document.head.appendChild(s);
  });
  return chartPromise;
}

/** Arabic font + RTL defaults applied to every chart we create. */
function baseOptions() {
  const font = "'IBM Plex Sans Arabic', 'Cairo', system-ui, sans-serif";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 750, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: false,
        rtl: true,
        textDirection: 'rtl',
        labels: { font: { family: font, size: 12 }, usePointStyle: true, boxWidth: 8 },
      },
      tooltip: {
        rtl: true,
        textDirection: 'rtl',
        backgroundColor: '#211d1d',
        titleFont: { family: font, size: 12.5, weight: '600' },
        bodyFont: { family: font, size: 12.5 },
        padding: 11,
        cornerRadius: 10,
        displayColors: false,
        boxPadding: 4,
      },
    },
    scales: {
      x: {
        grid: { display: false, drawBorder: false },
        border: { display: false },
        ticks: { font: { family: font, size: 11 }, color: '#8f787c', maxRotation: 0, autoSkipPadding: 14 },
      },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(33,29,29,0.055)', drawBorder: false },
        border: { display: false, dash: [4, 4] },
        ticks: { font: { family: font, size: 11 }, color: '#8f787c', padding: 8 },
      },
    },
  };
}

function destroy(canvas) {
  const c = registry.get(canvas);
  if (c) {
    c.destroy();
    registry.delete(canvas);
  }
}

/**
 * Sales trend line chart with a soft gradient fill.
 * @param {HTMLCanvasElement} canvas
 * @param {{labels:string[], values:number[], color?:string, currency?:string}} cfg
 */
export async function lineChart(canvas, cfg) {
  const Chart = await loadChartJS().catch(() => null);
  if (!Chart || !canvas) return null;
  destroy(canvas);

  const color = cfg.color || '#6b1d2f';
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 240);
  grad.addColorStop(0, hexA(color, 0.3));
  grad.addColorStop(1, hexA(color, 0.01));

  const opts = baseOptions();
  opts.plugins.tooltip.callbacks = {
    label: (c) => `${num(c.parsed.y)} ${cfg.currency || ''}`.trim(),
  };
  opts.scales.y.ticks.callback = (v) => numInt(v);

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: cfg.labels,
      datasets: [
        {
          data: cfg.values,
          borderColor: color,
          borderWidth: 2.5,
          backgroundColor: grad,
          fill: true,
          tension: 0.42,
          pointRadius: cfg.values.length > 14 ? 0 : 3.5,
          pointHoverRadius: 6,
          pointBackgroundColor: '#fff',
          pointBorderColor: color,
          pointBorderWidth: 2,
        },
      ],
    },
    options: opts,
  });
  registry.set(canvas, chart);
  return chart;
}

/**
 * Bar chart (best sellers / sales per day).
 * @param {HTMLCanvasElement} canvas
 * @param {{labels:string[], values:number[], horizontal?:boolean, currency?:string, colors?:string[]}} cfg
 */
export async function barChart(canvas, cfg) {
  const Chart = await loadChartJS().catch(() => null);
  if (!Chart || !canvas) return null;
  destroy(canvas);

  const opts = baseOptions();
  if (cfg.horizontal) {
    opts.indexAxis = 'y';
    opts.scales.x.beginAtZero = true;
    opts.scales.y.grid = { display: false };
    opts.scales.x.grid = { color: 'rgba(33,29,29,0.055)' };
  }
  opts.plugins.tooltip.callbacks = {
    label: (c) => `${num(cfg.horizontal ? c.parsed.x : c.parsed.y)} ${cfg.currency || ''}`.trim(),
  };

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: cfg.labels,
      datasets: [
        {
          data: cfg.values,
          backgroundColor: cfg.colors || PALETTE[0],
          hoverBackgroundColor: cfg.colors || '#4e051a',
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: cfg.horizontal ? 26 : 44,
        },
      ],
    },
    options: opts,
  });
  registry.set(canvas, chart);
  return chart;
}

/**
 * Doughnut breakdown (categories, payment methods).
 * @param {HTMLCanvasElement} canvas
 * @param {{labels:string[], values:number[], currency?:string}} cfg
 */
export async function doughnutChart(canvas, cfg) {
  const Chart = await loadChartJS().catch(() => null);
  if (!Chart || !canvas) return null;
  destroy(canvas);

  const opts = baseOptions();
  opts.cutout = '64%';
  opts.plugins.legend.display = true;
  opts.plugins.tooltip.callbacks = {
    label: (c) => {
      const total = c.dataset.data.reduce((a, b) => a + b, 0) || 1;
      const pct = Math.round((c.parsed / total) * 100);
      return `${c.label}: ${num(c.parsed)} ${cfg.currency || ''} (${pct}%)`;
    },
  };
  opts.plugins.tooltip.displayColors = true;
  delete opts.scales;

  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: cfg.labels,
      datasets: [
        {
          data: cfg.values,
          backgroundColor: PALETTE,
          borderColor: '#ffffff',
          borderWidth: 3,
          hoverOffset: 9,
        },
      ],
    },
    options: opts,
  });
  registry.set(canvas, chart);
  return chart;
}

/** Destroy every live chart (called when leaving a screen). */
export function destroyCharts() {
  registry.forEach((c) => {
    try {
      c.destroy();
    } catch (e) {
      /* already gone */
    }
  });
  registry.clear();
}

export function destroyChart(canvas) {
  destroy(canvas);
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export { loadChartJS };
