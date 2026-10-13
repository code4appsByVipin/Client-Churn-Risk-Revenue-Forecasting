import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import Chart from 'chart.js/auto';
import Papa from 'papaparse';
import './styles.css';
import {
  clamp,
  comparePanel,
  csvRowsToText,
  driverLabel,
  hydrateScores,
  simulateRetention,
  summarizeClients
} from './analytics.js';

const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
const byId = (id) => document.getElementById(id);
const state = {
  config: null,
  scores: [],
  drivers: [],
  panel: [],
  filtered: [],
  selectedSort: 'churn_probability_next_3m',
  sortAscending: false,
  driverChart: null,
  forecastChart: null,
  targetRate: null,
  summary: null
};

Chart.defaults.font.family = 'Inter';
Chart.defaults.font.size = 12;
Chart.defaults.plugins.tooltip.bodyFont = { family: 'JetBrains Mono', size: 11 };
Chart.defaults.plugins.tooltip.titleFont = { family: 'Inter', size: 12, weight: '600' };
Chart.defaults.color = '#5A6270';
Chart.defaults.animation = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function parseCsv(text, filename) {
  const result = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  if (result.errors.length) {
    const meaningful = result.errors.filter((error) => error.code !== 'TooManyFields');
    if (meaningful.length) throw new Error(`${filename} could not be parsed: ${meaningful[0].message}`);
  }
  return result.data;
}

async function loadText(filename) {
  const response = await fetch(`${DATA_BASE}${filename}`);
  if (!response.ok) throw new Error(`Could not load ${filename} (${response.status}).`);
  return response.text();
}

async function loadProjectData() {
  const [metricsText, scoresText, driversText, panelText] = await Promise.all([
    loadText('metrics.json'), loadText('scores.csv'), loadText('drivers.csv'), loadText('panel.csv')
  ]);
  const metrics = JSON.parse(metricsText);
  const scores = parseCsv(scoresText, 'scores.csv');
  const drivers = parseCsv(driversText, 'drivers.csv');
  const panel = parseCsv(panelText, 'panel.csv');
  const dataConfig = metrics.dataset_profile;
  const simulator = metrics.simulator;
  const model = metrics.model_metrics;
  const threshold = metrics.threshold_policy;
  if (!scores.length || !drivers.length || !panel.length || !dataConfig || !simulator || !model || !threshold) {
    throw new Error('One or more project data files are empty or incomplete.');
  }
  state.config = { ...dataConfig, ...simulator };
  state.config.display_scale_usd = Number(dataConfig.display_scale_usd ?? 1_000_000);
  state.metrics = metrics;
  state.scores = hydrateScores(scores, state.config);
  state.drivers = drivers.map((row) => ({
    ...row,
    rank: Number(row.rank),
    mean_abs_shap: Number(row.mean_abs_shap),
    share_of_total_shap: Number(row.share_of_total_shap)
  })).sort((a, b) => a.rank - b.rank);
  state.panel = panel;
  state.targetRate = Number(simulator.default_target_churn_rate);
  state.summary = summarizeClients(state.scores, state.config);
  state.filtered = [...state.scores];
}

function currencyCode() {
  return state.config?.currency ?? 'USD';
}

function roundForDisplay(value, fractionDigits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const rounded = Number(number.toFixed(fractionDigits));
  return Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
}

function formatCurrency(value, fractionDigits = 0) {
  const rounded = roundForDisplay(value, fractionDigits);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode(),
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits
  }).format(rounded);
}

function formatCompactCurrency(value, fractionDigits = 1) {
  const scale = Number(state.config?.display_scale_usd ?? 1_000_000);
  return `${formatCurrency((Number(value) || 0) / scale, fractionDigits)}M`;
}

function formatScenarioCurrency(value) {
  const scale = Number(state.config?.display_scale_usd ?? 1_000_000);
  const millions = roundForDisplay((Number(value) || 0) / scale, 2);
  const fractionDigits = millions === 0 ? 1 : 2;
  return `${formatCurrency(millions, fractionDigits)}M`;
}

function formatPercent(value, fractionDigits = 1) {
  const percentValue = roundForDisplay((Number(value) || 0) * 100, fractionDigits) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(percentValue);
}

function formatNumber(value, fractionDigits = 0) {
  const rounded = roundForDisplay(value, fractionDigits);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(rounded);
}

function formatClientCurrency(value) {
  const scale = Number(state.config?.display_scale_usd ?? 1_000_000);
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= scale) return formatCompactCurrency(amount, 1);
  return formatCurrency(amount, 0);
}

function greatestCommonDivisor(a, b) {
  let left = Math.abs(Number(a));
  let right = Math.abs(Number(b));
  while (right) [left, right] = [right, left % right];
  return left || 1;
}

function updateLoadStatus(message, isError = false) {
  const status = byId('load-status');
  status.textContent = message;
  status.classList.toggle('is-error', isError);
  status.setAttribute('role', isError ? 'alert' : 'status');
}

function activateSection(requestedId, scroll = false) {
  const sections = [...document.querySelectorAll('.page-section')];
  const validId = sections.some((section) => section.id === requestedId) ? requestedId : 'overview';
  for (const section of sections) section.hidden = section.id !== validId;
  for (const link of document.querySelectorAll('[data-page-link]')) {
    if (link.dataset.pageLink === validId) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (scroll) window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (validId === 'drivers') drawDriversChart();
  if (validId === 'forecast') drawForecastChart();
}

function connectNavigation() {
  for (const link of document.querySelectorAll('[data-page-link]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const id = link.dataset.pageLink;
      if (window.location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
      activateSection(id, true);
    });
  }
  window.addEventListener('popstate', () => activateSection(window.location.hash.slice(1)));
  window.addEventListener('hashchange', () => activateSection(window.location.hash.slice(1)));
  activateSection(window.location.hash.slice(1));
}

function renderOverview() {
  const result = state.summary;
  const metrics = state.metrics;
  const target = state.config.default_target_churn_rate;
  byId('stat-expected-churners').textContent = formatNumber(result.expectedNext3Months, 1);
  byId('stat-expected-churners-foot').textContent = `Expected value across ${formatNumber(result.clientCount)} scored clients`;
  byId('stat-flagged').textContent = formatNumber(result.flagged);
  byId('stat-flagged-foot').textContent = `${formatPercent(result.flagged / result.clientCount)} of the scored portfolio`;
  byId('stat-revenue-risk').textContent = formatCompactCurrency(result.forecast.revenueAtRisk);
  byId('stat-risk-horizon').textContent = formatNumber(state.config.forecast_months);
  byId('forecast-period-label-summary').textContent = formatNumber(state.config.forecast_months);
  byId('forecast-period-risk-summary').textContent = formatNumber(state.config.forecast_months);
  byId('forecast-period-gap-summary').textContent = formatNumber(state.config.forecast_months);
  byId('forecast-baseline-total').textContent = formatCompactCurrency(result.forecast.baselineTotal);
  byId('forecast-risk-total').textContent = formatCompactCurrency(result.forecast.riskAdjustedTotal);
  byId('forecast-revenue-gap').textContent = formatCompactCurrency(result.forecast.revenueAtRisk);
  byId('forecast-baseline-exact').textContent = `Exact: ${formatCurrency(result.forecast.baselineTotal)}`;
  byId('forecast-risk-exact').textContent = `Exact: ${formatCurrency(result.forecast.riskAdjustedTotal)}`;
  byId('forecast-gap-exact').textContent = `Exact: ${formatCurrency(result.forecast.revenueAtRisk)}`;
  byId('stat-target-churn').textContent = formatPercent(target);
  byId('stat-target-foot').textContent = `I set the target below the ${formatPercent(result.baseRate)} historical rate.`;
  byId('constraints-title').textContent = 'Scale, completeness and class balance';
  const threshold = metrics.threshold_policy;
  const rows = [
    ['Transaction scale', `${formatNumber(metrics.dataset_profile.transaction_rows)} transaction rows`, 'I would group activity by client and month before scoring.'],
    ['Missing financial values', `${formatPercent(metrics.dataset_profile.financial_missing_rate)} of financial values are missing`, 'I fill gaps with the training-period median for similar records and keep a missing-value flag.'],
    ['Churn rate', `${formatPercent(metrics.dataset_profile.historical_churn_rate)} annual churn; ${formatPercent(metrics.model_metrics.test_positive_rate)} in the test sample`, `I weight churners ${formatNumber(metrics.model_metrics.scale_pos_weight, 1)} times more and check recall and PR-AUC.`],
    ['Contact limit', `I can contact up to ${formatPercent(threshold.maximum_contact_share)} of clients in one wave`, `I compare the ${formatCurrency(threshold.false_positive_touch_cost_usd)} call cost with the cost of a missed renewal.`]
  ];
  byId('constraints-body').innerHTML = rows.map(([name, problem, treatment]) => `<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(problem)}</td><td>${escapeHtml(treatment)}</td></tr>`).join('');
}

function renderMethod() {
  const { metrics } = state;
  const sourceRows = formatNumber(metrics.dataset_profile.transaction_rows);
  const forecastMonths = Number(state.config.forecast_months);
  const riskMonths = Number(state.config.risk_horizon_months);
  const divisor = greatestCommonDivisor(riskMonths, forecastMonths);
  byId('probability-formula').textContent = `p${formatNumber(riskMonths)}m = 1 − (1 − p${formatNumber(forecastMonths)})^(${formatNumber(riskMonths / divisor)}/${formatNumber(forecastMonths / divisor)})`;
  byId('forecast-period-label').textContent = formatNumber(forecastMonths);
  byId('monthly-hazard-formula').textContent = `h = 1 − (1 − p${formatNumber(forecastMonths)})^(1/${formatNumber(forecastMonths)})`;
  byId('monthly-revenue-formula').textContent = `sum(acv / ${formatNumber(forecastMonths)} × (1 − h)^(month − 1))`;
  const steps = [
    ['Summarise transactions by client and month', `I would group ${sourceRows} transaction rows before scoring.`],
    ['Fill missing values', 'I use training-period medians for similar records and keep a missing-value flag.'],
    ['Use only data available at each month', 'I build the account measures from records available by that month.'],
    ['Prepare tier and region fields', 'I use the same category labels in training and testing.'],
    ['Weight churners more heavily', `I give churn cases a weight of ${formatNumber(metrics.model_metrics.scale_pos_weight, 1)} and save each client score.`],
    ['Test on later months', `I check ${formatNumber(metrics.model_metrics.test_rows)} later client-month records with ROC-AUC, PR-AUC, recall and precision.`]
  ];
  byId('pipeline-list').innerHTML = steps.map(([title, detail]) => `<li><span class="pipeline-title">${escapeHtml(title)}</span><span class="pipeline-detail">${escapeHtml(detail)}</span></li>`).join('');
  const md = metrics.model_metrics;
  const metricRows = [
    ['ROC-AUC', formatNumber(md.roc_auc, 2), 'How often a churner ranks above a client who renews.'],
    ['PR-AUC', formatNumber(md.pr_auc_average_precision, 2), 'Summarises precision and recall for churn cases.'],
    ['Recall', formatPercent(md.recall_churn_class_at_cost_threshold), 'Share of churn cases found by the model.'],
    ['Precision', formatPercent(md.precision_at_cost_threshold), 'Share of alerts that were churn cases in testing.'],
    ['Test churn rate', formatPercent(md.test_positive_rate), 'Share of test records labelled as churn.']
  ];
  byId('metrics-body').innerHTML = metricRows.map(([name, value, use]) => `<tr><th scope="row">${escapeHtml(name)}</th><td class="numeric mono">${escapeHtml(value)}</td><td>${escapeHtml(use)}</td></tr>`).join('');
  const policy = metrics.threshold_policy;
  byId('threshold-copy').textContent = `In testing, I contacted ${formatPercent(policy.validation_contact_share)} of records, under the ${formatPercent(policy.maximum_contact_share)} limit. The annual score cutoff was ${formatPercent(policy.selected_threshold_12m, 2)}; its 3-month equivalent was ${formatPercent(policy.equivalent_threshold_3m, 2)}. I assume a ${formatCurrency(policy.false_positive_touch_cost_usd)} call cost. A missed churner costs ACV × ${formatPercent(policy.gross_margin_assumption)} margin × ${formatPercent(policy.lost_margin_fraction)} of a year.`;
}

function fillFilters() {
  const tiers = [...new Set(state.scores.map((client) => client.contract_tier))].sort();
  const regions = [...new Set(state.scores.map((client) => client.region))].sort();
  byId('tier-filter').innerHTML = '<option value="">All tiers</option>' + tiers.map((tier) => `<option value="${escapeHtml(tier)}">${escapeHtml(tier)}</option>`).join('');
  byId('region-filter').innerHTML = '<option value="">All regions</option>' + regions.map((region) => `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`).join('');
}

function getFilteredClients() {
  const query = byId('client-search').value.trim().toLowerCase();
  const tier = byId('tier-filter').value;
  const region = byId('region-filter').value;
  const flaggedOnly = byId('flagged-filter').checked;
  const matches = state.scores.filter((client) => {
    const driver = driverLabel(client.top_positive_driver).toLowerCase();
    const searchText = [client.client_id, client.contract_tier, client.region, driver].join(' ').toLowerCase();
    return (!query || searchText.includes(query)) && (!tier || client.contract_tier === tier) && (!region || client.region === region) && (!flaggedOnly || client.flagged);
  });
  const field = state.selectedSort;
  matches.sort((a, b) => {
    const left = a[field];
    const right = b[field];
    let compared;
    if (typeof left === 'number' && typeof right === 'number') compared = left - right;
    else compared = String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return state.sortAscending ? compared : -compared;
  });
  return matches;
}

function renderRiskTable() {
  state.filtered = getFilteredClients();
  const body = byId('risk-tbody');
  if (!state.filtered.length) {
    body.innerHTML = '<tr><td colspan="7">No clients match these filters.</td></tr>';
  } else {
    body.innerHTML = state.filtered.map((client) => {
      const risk = client.churn_probability_next_3m;
      const badge = client.flagged ? '<span class="status-badge">Flagged</span>' : '<span class="status-badge is-review">Not in first wave</span>';
      return `<tr>
        <td><button class="client-link" type="button" data-client-id="${escapeHtml(client.client_id)}">${escapeHtml(client.client_id)}</button></td>
        <td>${escapeHtml(client.contract_tier)}</td>
        <td>${escapeHtml(client.region)}</td>
        <td class="numeric risk-cell"><span class="risk-number">${escapeHtml(formatPercent(risk))}</span><span class="risk-track" aria-hidden="true"><span class="risk-fill" style="width:${clamp(risk * 100, 0, 100)}%"></span></span></td>
        <td class="numeric mono">${escapeHtml(formatClientCurrency(client.acv_usd))}</td>
        <td>${badge}</td>
        <td class="driver-cell">${escapeHtml(driverLabel(client.top_positive_driver))}</td>
      </tr>`;
    }).join('');
  }
  byId('table-count').textContent = `${formatNumber(state.filtered.length)} of ${formatNumber(state.scores.length)} clients shown`;
  for (const button of document.querySelectorAll('.sort-button')) {
    const active = button.dataset.sort === state.selectedSort;
    const direction = active ? (state.sortAscending ? 'ascending' : 'descending') : 'unsorted';
    button.setAttribute('aria-label', `${button.textContent.replace('↕', '').trim()}, ${direction}`);
    button.querySelector('span').textContent = active ? (state.sortAscending ? '↑' : '↓') : '↕';
  }
}

function openClientDetail(clientId) {
  const client = state.scores.find((item) => item.client_id === clientId);
  if (!client) return;
  const explain = driverExplanation(client.top_positive_driver);
  byId('client-dialog-title').textContent = client.client_id;
  byId('client-detail-content').innerHTML = `
    <div class="detail-risk"><span>Estimated churn risk over the next 3 months</span><strong>${escapeHtml(formatPercent(client.churn_probability_next_3m))}</strong></div>
    <div class="detail-grid">
      <div class="detail-item"><span>Annual probability</span><strong>${escapeHtml(formatPercent(client.churn_probability_12m))}</strong></div>
      <div class="detail-item"><span>Annual contract value</span><strong>${escapeHtml(formatClientCurrency(client.acv_usd))}</strong></div>
      <div class="detail-item"><span>Contract tier</span><strong>${escapeHtml(client.contract_tier)}</strong></div>
      <div class="detail-item"><span>Region</span><strong>${escapeHtml(client.region)}</strong></div>
      <div class="detail-item"><span>Tenure</span><strong>${escapeHtml(formatNumber(client.tenure_months))} months</strong></div>
      <div class="detail-item"><span>Priority rank</span><strong>${escapeHtml(formatNumber(client.priority_rank))}</strong></div>
      <div class="detail-item"><span>Expected annual contract value at risk</span><strong>${escapeHtml(formatClientCurrency(client.expected_exit_arr_at_risk_usd))}</strong></div>
      <div class="detail-item"><span>First-wave review</span><strong>${client.flagged ? 'Flagged' : 'Not flagged'}</strong></div>
    </div>
    <div class="driver-explanation"><strong>Main positive model driver: ${escapeHtml(driverLabel(client.top_positive_driver))}</strong><p>${escapeHtml(explain)}</p></div>`;
  const dialog = byId('client-dialog');
  if (!dialog.open) dialog.showModal();
}

function driverExplanation(driver) {
  const explanations = {
    sla_breach_rate_90d: 'Recent SLA breaches raise this client’s model score. I would check each incident and ask the service lead what happened.',
    support_response_p90_hours_90d: 'A longer response time raises this client’s model score. I would check open tickets and escalation delays.',
    spend_change_90d_pct: 'Falling spend raises this client’s model score. I would check usage and discuss the change with the account owner.',
    service_breadth_90d: 'Fewer services raise this client’s model score. I would ask which services the client uses and needs.',
    payment_delay_days_avg_90d: 'Late payments raise this client’s model score. I would check the invoices and resolve any billing dispute.'
  };
  return explanations[driver] ?? 'This input contributed to the client score. I would check the account record before acting.';
}

function connectRiskDashboard() {
  for (const id of ['client-search', 'tier-filter', 'region-filter', 'flagged-filter']) {
    byId(id).addEventListener(id === 'client-search' ? 'input' : 'change', renderRiskTable);
  }
  document.querySelectorAll('.sort-button').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.selectedSort === button.dataset.sort) state.sortAscending = !state.sortAscending;
      else {
        state.selectedSort = button.dataset.sort;
        state.sortAscending = state.selectedSort === 'client_id' || state.selectedSort === 'contract_tier' || state.selectedSort === 'region';
      }
      renderRiskTable();
    });
  });
  byId('risk-tbody').addEventListener('click', (event) => {
    const button = event.target.closest('[data-client-id]');
    if (button) openClientDetail(button.dataset.clientId);
  });
  byId('close-dialog').addEventListener('click', () => byId('client-dialog').close());
  byId('client-dialog').addEventListener('click', (event) => {
    if (event.target === byId('client-dialog')) byId('client-dialog').close();
  });
  byId('export-csv').addEventListener('click', exportFilteredCsv);
}

function exportFilteredCsv() {
  const fields = [
    'client_id', 'contract_tier', 'region', 'tenure_months', 'acv_usd',
    'churn_probability_12m', 'churn_probability_next_3m',
    'expected_exit_arr_at_risk_usd', 'priority_rank', 'first_wave_top_60', 'top_positive_driver'
  ];
  const csv = csvRowsToText(state.filtered, fields);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'filtered_client_risk.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  updateLoadStatus(`CSV exported with ${formatNumber(state.filtered.length)} filtered records.`);
}

function renderDrivers() {
  byId('drivers-body').innerHTML = state.drivers.map((row) => `<tr>
    <td class="mono">${escapeHtml(formatNumber(row.rank))}</td>
    <th scope="row">${escapeHtml(driverLabel(row.driver))}</th>
    <td class="numeric mono">${escapeHtml(formatNumber(row.mean_abs_shap, 4))}</td>
    <td class="numeric mono">${escapeHtml(formatPercent(row.share_of_total_shap))}</td>
  </tr>`).join('');
  const comparisons = comparePanel(state.panel);
  byId('comparison-body').innerHTML = comparisons.map((row) => `<tr>
    <th scope="row">${escapeHtml(row.label)}</th>
    <td class="numeric mono">${escapeHtml(formatComparison(row.churnedMean, row.format))}</td>
    <td class="numeric mono">${escapeHtml(formatComparison(row.retainedMean, row.format))}</td>
    <td class="numeric mono">${escapeHtml(formatComparison(row.difference, row.format, true))}</td>
  </tr>`).join('');
  byId('driver-takeaways').innerHTML = state.drivers.slice(0, 3).map((row) => `<article class="takeaway-card"><strong>${escapeHtml(driverLabel(row.driver))} · ${escapeHtml(formatPercent(row.share_of_total_shap))}</strong><p>${escapeHtml(driverExplanation(row.driver))}</p></article>`).join('');
}

function formatComparison(value, format, signed = false) {
  const prefix = signed && value > 0 ? '+' : '';
  if (format === 'percent') return `${prefix}${formatPercent(value)}`;
  if (format === 'hours') return `${prefix}${formatNumber(value, 1)} h`;
  if (format === 'days') return `${prefix}${formatNumber(value, 1)} days`;
  return `${prefix}${formatNumber(value, 2)}`;
}

function drawDriversChart() {
  const canvas = byId('drivers-chart');
  if (!canvas || !state.drivers.length) return;
  if (state.driverChart) state.driverChart.destroy();
  state.driverChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: state.drivers.map((row) => driverLabel(row.driver)),
      datasets: [{
        data: state.drivers.map((row) => row.share_of_total_shap),
        backgroundColor: '#1F3A5F',
        borderColor: '#1F3A5F',
        borderWidth: 1,
        borderRadius: 3,
        barThickness: 17
      }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => `Share: ${formatPercent(context.parsed.x)}` } }
      },
      scales: {
        x: {
          beginAtZero: true,
          max: Math.max(...state.drivers.map((row) => row.share_of_total_shap)) * 1.22,
          grid: { color: '#E7EAEE' },
          ticks: { callback: (value) => formatPercent(value, 0) },
          title: { display: true, text: 'Share of mean absolute contribution' }
        },
        y: { grid: { display: false }, ticks: { autoSkip: false } }
      }
    }
  });
}

function setUpSimulator() {
  const slider = byId('target-churn-slider');
  const config = state.config;
  const min = Number(config.minimum_target_churn_rate);
  const max = Number(config.maximum_target_churn_rate);
  const step = Number(config.step);
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(clamp(state.targetRate, min, max));
  byId('target-min-label').textContent = formatPercent(min);
  byId('target-max-label').textContent = formatPercent(max);
  slider.addEventListener('input', () => {
    state.targetRate = Number(slider.value);
    updateSimulator();
  });
  updateSimulator();
}

function updateSimulator() {
  const result = simulateRetention(state.scores, state.config, state.targetRate);
  byId('target-churn-output').textContent = formatPercent(state.targetRate);
  byId('sim-saved').textContent = formatNumber(result.expectedClientsSaved, 1);
  byId('sim-protected').textContent = formatScenarioCurrency(result.revenueProtected);
  byId('sim-target-revenue').textContent = formatScenarioCurrency(result.target.riskAdjustedTotal);
  if (state.forecastChart) drawForecastChart();
  renderQuarterlyTable(result.target.monthly);
  renderStrategy(result);
}

function renderQuarterlyTable(targetMonthly) {
  const quarterMonths = Number(state.config.forecast_months) / Number(state.config.quarters_per_year);
  const baselineMonthly = state.summary.forecast.baselineMonthly;
  const current = state.summary.forecast.monthly;
  const rows = [];
  for (let index = 0; index < Number(state.config.quarters_per_year); index += 1) {
    const start = Math.floor(index * quarterMonths);
    const end = Math.floor((index + 1) * quarterMonths);
    const currentTotal = current.slice(start, end).reduce((sum, row) => sum + row.riskAdjustedRevenueUsd, 0);
    const targetTotal = targetMonthly.slice(start, end).reduce((sum, row) => sum + row.riskAdjustedRevenueUsd, 0);
    rows.push(`<tr><th scope="row">Q${formatNumber(index + 1)}</th><td class="numeric mono">${escapeHtml(formatCompactCurrency(baselineMonthly * (end - start)))}</td><td class="numeric mono">${escapeHtml(formatCompactCurrency(currentTotal))}</td><td class="numeric mono">${escapeHtml(formatCompactCurrency(targetTotal))}</td></tr>`);
  }
  byId('quarterly-body').innerHTML = rows.join('');
}

function drawForecastChart() {
  const canvas = byId('forecast-chart');
  if (!canvas || !state.scores.length) return;
  const simulated = simulateRetention(state.scores, state.config, state.targetRate);
  if (state.forecastChart) state.forecastChart.destroy();
  const scale = Number(state.config.display_scale_usd ?? 1_000_000);
  state.forecastChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: state.summary.forecast.monthly.map((row) => `M${formatNumber(row.month)}`),
      datasets: [
        { label: 'No churn', data: state.summary.forecast.monthly.map((row) => row.baselineRevenueUsd / scale), borderColor: '#8893A0', backgroundColor: '#8893A0', pointRadius: 0, borderWidth: 2, tension: 0 },
        { label: 'Current risk', data: state.summary.forecast.monthly.map((row) => row.riskAdjustedRevenueUsd / scale), borderColor: '#B3402A', backgroundColor: '#B3402A', pointRadius: 0, borderWidth: 2, tension: 0 },
        { label: `At ${formatPercent(state.targetRate)} target`, data: simulated.target.monthly.map((row) => row.riskAdjustedRevenueUsd / scale), borderColor: '#1F3A5F', backgroundColor: '#1F3A5F', pointRadius: 0, borderWidth: 2, borderDash: [5, 4], tension: 0 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 15 } },
        tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${formatCompactCurrency(context.parsed.y * scale)}` } }
      },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'Month in forecast horizon' } },
        y: { beginAtZero: false, grid: { color: '#E7EAEE' }, ticks: { callback: (value) => `${formatCurrency(value, 0)}M` }, title: { display: true, text: `Revenue (${currencyCode()} millions)` } }
      }
    }
  });
  renderQuarterlyTable(simulated.target.monthly);
}

function renderStrategy(simulation = simulateRetention(state.scores, state.config, state.targetRate)) {
  const flagged = state.scores.filter((client) => client.flagged);
  const actions = {
    sla_breach_rate_90d: ['Review each breach, name an escalation contact, and discuss service credits after a breach.', 'Breach rate near 3%.'],
    support_response_p90_hours_90d: ['Use the priority queue and 24/7 escalation. Review open tickets each week.', 'Response time near 6 hours.'],
    spend_change_90d_pct: ['Flag a 90-day spend drop over 10%. Meet with the account owner within two weeks.', 'Reverse the decline within a quarter.'],
    service_breadth_90d: ['Ask which services the client needs. Help set up services already in the contract.', 'Move from about 2.2 to 3 services per client.'],
    payment_delay_days_avg_90d: ['Check invoice accuracy and settle disputes early. Offer flexible terms when appropriate.', 'Average delay under 10 days.']
  };
  byId('strategy-body').innerHTML = state.drivers.slice(0, 5).map((row) => {
    const count = flagged.filter((client) => client.top_positive_driver === row.driver).length;
    const [action, target] = actions[row.driver] ?? ['I would check the account record with its owner.', 'Review the client record.'];
    return `<tr><th scope="row">${escapeHtml(driverLabel(row.driver))}</th><td>${escapeHtml(action)}</td><td>${escapeHtml(formatNumber(count))} flagged ${count === 1 ? 'account' : 'accounts'}</td><td>${escapeHtml(target)}</td></tr>`;
  }).join('');
  byId('impact-baseline').textContent = formatNumber(state.summary.baselineExpectedLosses, 1);
  byId('impact-target').textContent = formatNumber(state.summary.baselineExpectedLosses - simulation.expectedClientsSaved, 1);
  byId('impact-saved').textContent = formatNumber(simulation.expectedClientsSaved, 1);
  const flaggedAcv = flagged.reduce((sum, client) => sum + client.acv_usd, 0);
  const averageFlaggedAcv = flagged.length ? flaggedAcv / flagged.length : 0;
  byId('impact-acv-protected').textContent = formatCompactCurrency(simulation.expectedClientsSaved * averageFlaggedAcv);
}

function renderAbout() {
  const cfg = state.config;
  const metrics = state.metrics;
  const items = [
    `The score file has ${formatNumber(state.summary.clientCount)} client records. The browser reads client-level files, not the transaction rows.`,
    `I use an ${formatPercent(cfg.historical_churn_rate)} yearly churn rate. My target ranges from ${formatPercent(cfg.minimum_target_churn_rate)} to ${formatPercent(cfg.maximum_target_churn_rate)} in ${formatPercent(cfg.step)} steps.`,
    `At the default ${formatPercent(cfg.default_target_churn_rate)} target, I scale each yearly client score by the target rate divided by the historical rate.`,
    `I forecast ${formatNumber(cfg.forecast_months)} months. I convert yearly risk to risk over the next ${formatNumber(cfg.risk_horizon_months)} months using a steady monthly rate.`,
    `I assume ${formatPercent(cfg.financial_missing_rate)} of financial values are missing. I fill gaps from similar records in the training period.`,
    `The test results use ${formatNumber(metrics.model_metrics.test_rows)} client-month records. Several months from one client may be related.`
  ];
  byId('assumptions-list').innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const fileList = [
    ['scores.csv', 'Client scores'],
    ['ranked_client_list.csv', 'Full ranked client list'],
    ['drivers.csv', 'Model driver shares'],
    ['panel.csv', 'Client-month comparison data'],
    ['metrics.json', 'Model results and assumptions'],
    ['report.pdf', 'Six-page report']
  ];
  const downloads = document.createElement('section');
  downloads.className = 'content-panel';
  downloads.innerHTML = `<div class="section-heading"><h2>Project downloads</h2></div><ul class="file-download-list">${fileList.map(([file, detail]) => `<li><a href="${escapeHtml(DATA_BASE + file)}" download>${escapeHtml(file)}</a><span>${escapeHtml(detail)}</span></li>`).join('')}</ul>`;
  const aboutSection = byId('about');
  const existing = byId('project-files-panel');
  if (existing) existing.remove();
  downloads.id = 'project-files-panel';
  aboutSection.insertBefore(downloads, aboutSection.querySelector('.content-panel:last-child'));
}

function initialize() {
  renderOverview();
  renderMethod();
  fillFilters();
  renderRiskTable();
  connectRiskDashboard();
  renderDrivers();
  setUpSimulator();
  renderAbout();
  connectNavigation();
  updateLoadStatus(`Data loaded · ${formatNumber(state.scores.length)} client records.`);
}

async function bootstrap() {
  try {
    await loadProjectData();
    initialize();
  } catch (error) {
    console.error(error);
    updateLoadStatus(`Project data could not be loaded. ${error.message} Run the site through the Vite development server or preview the production build.`, true);
  }
}

bootstrap();
