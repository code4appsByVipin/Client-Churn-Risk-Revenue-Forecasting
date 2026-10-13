import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { forecastRevenue, hydrateScores, simulateRetention, summarizeClients } from '../src/analytics.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'public/data');
const read = (name) => readFile(resolve(dataDir, name), 'utf8');
const parse = (text) => {
  const result = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  assert.equal(result.errors.length, 0, 'CSV files must parse without errors');
  return result.data;
};
const metrics = JSON.parse(await read('metrics.json'));
const config = {
  ...metrics.dataset_profile,
  ...metrics.simulator,
  display_scale_usd: metrics.dataset_profile.display_scale_usd
};
const rawScores = parse(await read('scores.csv'));
const scores = hydrateScores(rawScores, config);
const summary = summarizeClients(scores, config);
const current = forecastRevenue(scores, config);

const expected = {
  clients: 200,
  flagged: 60,
  baselineUsd: 97_773_565.35,
  riskAdjustedUsd: 89_491_985.65,
  revenueAtRiskUsd: 8_281_579.70,
  expectedNext3Months: 11.57941920020871,
  expectedAnnualExits: 36
};

assert.equal(scores.length, expected.clients, 'Client count');
assert.equal(summary.flagged, expected.flagged, 'Flagged client count');
assert.ok(Math.abs(current.baselineTotal - expected.baselineUsd) <= 0.02, 'Baseline revenue calculation');
assert.ok(Math.abs(current.riskAdjustedTotal - expected.riskAdjustedUsd) <= 0.02, 'Risk-adjusted revenue calculation');
assert.ok(Math.abs(current.revenueAtRisk - expected.revenueAtRiskUsd) <= 0.02, 'Revenue at risk calculation');
assert.ok(Math.abs(summary.expectedNext3Months - expected.expectedNext3Months) <= 0.000001, 'Expected churn over the next 3 months');
assert.ok(Math.abs(summary.baselineExpectedLosses - expected.expectedAnnualExits) <= 0.000001, 'Expected annual exits');

const scenarios = [
  { rate: 0.13, clientsSaved: 10, protectedUsd: 2_564_043.144883409, targetRevenueUsd: 92_056_028.79268835 },
  { rate: 0.15, clientsSaved: 6, protectedUsd: 1_578_785.055761516, targetRevenueUsd: 91_070_770.70356646 },
  { rate: 0.18, clientsSaved: 0, protectedUsd: 0, targetRevenueUsd: 89_491_985.64780495 }
];
for (const scenario of scenarios) {
  const result = simulateRetention(scores, config, scenario.rate);
  assert.ok(Math.abs(result.expectedClientsSaved - scenario.clientsSaved) <= 0.000001, `Clients saved at ${(scenario.rate * 100).toFixed(0)}%`);
  assert.ok(Math.abs(result.revenueProtected - scenario.protectedUsd) <= 0.02, `Revenue protected at ${(scenario.rate * 100).toFixed(0)}%`);
  assert.ok(Math.abs(result.target.riskAdjustedTotal - scenario.targetRevenueUsd) <= 0.02, `Target revenue at ${(scenario.rate * 100).toFixed(0)}%`);
}
const defaultScenario = simulateRetention(scores, config, config.default_target_churn_rate);
const flaggedClients = scores.filter((client) => client.flagged);
const averageFlaggedAcv = flaggedClients.reduce((sum, client) => sum + client.acv_usd, 0) / flaggedClients.length;
const expectedAcvFromSaves = averageFlaggedAcv * defaultScenario.expectedClientsSaved;
assert.ok(Math.abs(expectedAcvFromSaves - 4_471_176.91) <= 0.02, 'Annual contract value associated with expected saves');

assert.equal(metrics.source_label, 'Simulated dataset', 'Dataset label');
assert.equal(metrics.simulator.minimum_target_churn_rate, 0.13, 'Minimum target');
assert.equal(metrics.simulator.maximum_target_churn_rate, 0.18, 'Maximum target');
assert.equal(metrics.simulator.step, 0.005, 'Target step');
assert.equal(metrics.simulator.default_target_churn_rate, 0.13, 'Default target');

const requiredFiles = [
  'scores.csv', 'ranked_client_list.csv', 'drivers.csv', 'panel.csv', 'metrics.json', 'report.pdf'
];
for (const file of requiredFiles) await stat(resolve(dataDir, file));
for (const file of ['index.html', 'public/report.html', 'src/main.js', 'src/analytics.js', 'src/styles.css']) {
  await stat(resolve(root, file));
}

const ranked = parse(await read('ranked_client_list.csv'));
assert.equal(ranked.length, expected.clients, 'Ranked client row count');
assert.equal(ranked[0].client_id, 'ACCT-143', 'First ranked client');

const expectedHeaders = {
  'scores.csv': ['client_id', 'contract_tier', 'region', 'tenure_months', 'acv_usd', 'churn_probability_12m', 'churn_probability_next_3m', 'expected_exit_arr_at_risk_usd', 'priority_rank', 'first_wave_top_60', 'top_positive_driver'],
  'ranked_client_list.csv': ['rank', 'client_id', 'contract_tier', 'contract_value_usd', 'probability_12m', 'probability_3m', 'main_driver', 'first_wave_flag'],
  'drivers.csv': ['rank', 'driver', 'mean_abs_shap', 'share_of_total_shap'],
  'panel.csv': ['client_id', 'snapshot_month_num', 'snapshot_month', 'spend_change_90d_pct', 'sla_breach_rate_90d', 'support_response_p90_hours_90d', 'service_breadth_90d', 'payment_delay_days_avg_90d', 'tenure_months', 'missing_financial_share_90d', 'acv_usd', 'contract_tier', 'region', 'churn_12m']
};
for (const [file, columns] of Object.entries(expectedHeaders)) {
  const rows = parse(await read(file));
  assert.ok(rows.length > 0, `${file} has data rows`);
  assert.deepEqual(Object.keys(rows[0]), columns, `${file} columns`);
}

console.log('PASS: 200 client records and 60 flagged clients');
console.log(`PASS: baseline $${current.baselineTotal.toFixed(2)}`);
console.log(`PASS: risk-adjusted $${current.riskAdjustedTotal.toFixed(2)}`);
console.log(`PASS: revenue at risk $${current.revenueAtRisk.toFixed(2)}`);
console.log(`PASS: ${summary.expectedNext3Months.toFixed(1)} expected churners in the next 3 months and ${summary.baselineExpectedLosses.toFixed(1)} expected annual exits`);
console.log('PASS: 13%, 15% and 18% simulator values');
console.log(`PASS: annual contract value from expected saves $${(expectedAcvFromSaves / 1_000_000).toFixed(1)}M`);
console.log('PASS: target bounds, required files and CSV columns');
