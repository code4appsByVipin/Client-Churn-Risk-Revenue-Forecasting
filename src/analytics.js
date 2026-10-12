export function parseBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

export function hydrateScores(rows, config) {
  const months = Number(config.forecast_months);
  const riskMonths = Number(config.risk_horizon_months);
  return rows.map((row) => {
    const p12 = clamp(Number(row.churn_probability_12m), 0, 1);
    return {
      ...row,
      tenure_months: Number(row.tenure_months),
      acv_usd: Number(row.acv_usd),
      churn_probability_12m: p12,
      churn_probability_next_3m: 1 - Math.pow(1 - p12, riskMonths / months),
      expected_exit_arr_at_risk_usd: Number(row.expected_exit_arr_at_risk_usd),
      priority_rank: Number(row.priority_rank),
      first_wave_top_60: parseBoolean(row.first_wave_top_60),
      flagged: parseBoolean(row.first_wave_top_60)
    };
  });
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function forecastRevenue(clients, config, probabilityForClient = (client) => client.churn_probability_12m) {
  const monthCount = Number(config.forecast_months);
  const currencyScale = Number(config.display_scale_usd ?? 1_000_000);
  const baselineMonthly = clients.reduce((sum, client) => sum + client.acv_usd, 0) / monthCount;
  const monthly = Array.from({ length: monthCount }, (_, index) => {
    const month = index + 1;
    const riskAdjusted = clients.reduce((sum, client) => {
      const p = clamp(Number(probabilityForClient(client)), 0, 1);
      const hazard = 1 - Math.pow(1 - p, 1 / monthCount);
      return sum + (client.acv_usd / monthCount) * Math.pow(1 - hazard, month - 1);
    }, 0);
    return {
      month,
      baselineRevenueUsd: baselineMonthly,
      riskAdjustedRevenueUsd: riskAdjusted
    };
  });
  const baselineTotal = monthly.reduce((sum, row) => sum + row.baselineRevenueUsd, 0);
  const riskAdjustedTotal = monthly.reduce((sum, row) => sum + row.riskAdjustedRevenueUsd, 0);
  return {
    monthly,
    baselineTotal,
    riskAdjustedTotal,
    revenueAtRisk: baselineTotal - riskAdjustedTotal,
    baselineMonthly,
    endingRiskAdjustedMonthly: monthly.at(-1)?.riskAdjustedRevenueUsd ?? 0,
    currencyScale
  };
}

export function simulateRetention(clients, config, targetRate) {
  const historicalRate = Number(config.historical_churn_rate);
  const adjusted = clients.map((client) => ({
    ...client,
    targetProbability12m: Math.min(1, client.churn_probability_12m * targetRate / historicalRate)
  }));
  const current = forecastRevenue(clients, config);
  const target = forecastRevenue(adjusted, config, (client) => client.targetProbability12m);
  const expectedClientsSaved = clients.reduce((sum, client) => {
    const pTarget = Math.min(1, client.churn_probability_12m * targetRate / historicalRate);
    return sum + client.churn_probability_12m - pTarget;
  }, 0);
  return {
    adjusted,
    current,
    target,
    expectedClientsSaved,
    revenueProtected: target.riskAdjustedTotal - current.riskAdjustedTotal
  };
}

export function summarizeClients(clients, config) {
  const baseRate = Number(config.historical_churn_rate);
  const targetRate = Number(config.default_target_churn_rate);
  const forecast = forecastRevenue(clients, config);
  const expectedNext3Months = clients.reduce((sum, client) => sum + client.churn_probability_next_3m, 0);
  const flagged = clients.filter((client) => client.flagged).length;
  const baselineExpectedLosses = clients.reduce((sum, client) => sum + client.churn_probability_12m, 0);
  const targetExpectedLosses = clients.reduce((sum, client) => {
    return sum + Math.min(1, client.churn_probability_12m * targetRate / baseRate);
  }, 0);
  return {
    clientCount: clients.length,
    portfolioAcv: clients.reduce((sum, client) => sum + client.acv_usd, 0),
    expectedNext3Months,
    flagged,
    targetRate,
    baseRate,
    forecast,
    baselineExpectedLosses,
    targetExpectedLosses,
    expectedClientsSaved: baselineExpectedLosses - targetExpectedLosses
  };
}

export function comparePanel(panelRows) {
  const features = [
    { key: 'spend_change_90d_pct', label: '90-day spend change', format: 'percent' },
    { key: 'sla_breach_rate_90d', label: 'SLA breach rate', format: 'percent' },
    { key: 'support_response_p90_hours_90d', label: 'Support response p90', format: 'hours' },
    { key: 'service_breadth_90d', label: 'Service breadth', format: 'number' },
    { key: 'payment_delay_days_avg_90d', label: 'Average payment delay', format: 'days' }
  ];
  const groups = { churned: [], retained: [] };
  for (const row of panelRows) {
    const target = Number(row.churn_12m) === 1 ? groups.churned : groups.retained;
    target.push(row);
  }
  const average = (rows, key) => {
    const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  };
  return features.map((feature) => {
    const churnedMean = average(groups.churned, feature.key);
    const retainedMean = average(groups.retained, feature.key);
    return { ...feature, churnedMean, retainedMean, difference: churnedMean - retainedMean };
  });
}

export function driverLabel(value) {
  const labels = {
    sla_breach_rate_90d: 'SLA breach rate',
    support_response_p90_hours_90d: 'Support response p90',
    spend_change_90d_pct: '90-day spend change',
    service_breadth_90d: 'Service breadth',
    payment_delay_days_avg_90d: 'Payment delay',
    tenure_months: 'Tenure',
    acv_usd: 'Annual contract value',
    contract_tier: 'Contract tier',
    missing_financial_share_90d: 'Financial missingness',
    region: 'Region'
  };
  return labels[value] ?? String(value).replaceAll('_', ' ');
}

export function csvRowsToText(rows, headers) {
  const quote = (value) => {
    const text = value == null ? '' : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [headers.map(quote).join(','), ...rows.map((row) => headers.map((header) => quote(row[header])).join(','))].join('\r\n');
}
