# Client Churn Risk and Revenue Forecasting

A static, browser-based project for reviewing churn scores, model drivers, revenue forecasts and retention scenarios for a managed IT services portfolio. It uses simulated client records and needs no backend.

## Run locally

Use Node.js 20 or later.

```bash
npm install
npm run dev
```

Open the address printed by Vite. Do not open `index.html` directly, because the site loads local data files.

## Check, build and preview

```bash
npm run verify:data
npm run build
npm run preview
```

The build writes the static site to `dist/`. Preview it before deploying. To deploy, publish the contents of `dist/` to a static web host. The relative asset paths support a repository subpath.

## Files

- `index.html` — dashboard and navigation.
- `src/main.js` — data loading, charts, filters, sorting, CSV export and simulator.
- `src/analytics.js` — probability and revenue calculations.
- `src/styles.css` — layout, typography and mobile styles.
- `public/data/scores.csv` — client scores and risk drivers.
- `public/data/ranked_client_list.csv` — full ranked client list.
- `public/data/drivers.csv` — model driver contributions.
- `public/data/panel.csv` — client-month comparison data.
- `public/data/metrics.json` — model results and project assumptions.
- `public/data/report.pdf` — six-page report.
- `public/report.html` — interactive report companion.
- `scripts/verify.mjs` — numeric, schema and required-file checks.
- `scripts/build_report.py` — builds the PDF report with ReportLab.
- `package.json` and `package-lock.json` — project metadata and dependencies.

To rebuild the PDF, install ReportLab for Python and run `python scripts/build_report.py`.
