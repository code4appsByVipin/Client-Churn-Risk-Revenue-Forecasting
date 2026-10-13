from __future__ import annotations

import csv
import json
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.graphics.shapes import Drawing, Line, Rect, String


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
OUTPUT = DATA / "report.pdf"
NAVY = colors.HexColor("#1F3A5F")
INK = colors.HexColor("#171A1F")
MUTED = colors.HexColor("#5A6270")
GRAY = colors.HexColor("#87919D")
PALE = colors.HexColor("#EEF1F4")
LINE = colors.HexColor("#D9DEE4")
WHITE = colors.white


def read_csv(name: str) -> list[dict[str, str]]:
    with (DATA / name).open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def number(value: object) -> float:
    return float(value or 0)


def rounded(value: float, digits: int = 1) -> float:
    result = round(value, digits)
    return 0.0 if result == 0 else result


def fmt_n(value: float, digits: int = 0) -> str:
    return f"{rounded(value, digits):,.{digits}f}"


def fmt_pct(value: float, digits: int = 0) -> str:
    return f"{rounded(value * 100, digits):,.{digits}f}%"


def fmt_money(value: float, digits: int = 0) -> str:
    return f"${rounded(value, digits):,.{digits}f}"


def fmt_m(value: float, digits: int = 1) -> str:
    return f"{fmt_money(value / 1_000_000, digits)}M"


def scenario_money(value: float) -> str:
    millions = rounded(value / 1_000_000, 2)
    return f"{fmt_money(millions, 1 if millions == 0 else 2)}M"


def load_project() -> dict:
    metrics = json.loads((DATA / "metrics.json").read_text(encoding="utf-8"))
    scores = read_csv("scores.csv")
    drivers = read_csv("drivers.csv")
    panel = read_csv("panel.csv")
    ranked = read_csv("ranked_client_list.csv")
    config = {**metrics["dataset_profile"], **metrics["simulator"]}
    months = int(config["forecast_months"])
    risk_months = int(config["risk_horizon_months"])

    for row in scores:
        row["acv"] = number(row["acv_usd"])
        row["p12"] = min(1.0, max(0.0, number(row["churn_probability_12m"])))
        row["p3"] = 1 - (1 - row["p12"]) ** (risk_months / months)
        row["flagged"] = str(row["first_wave_top_60"]).lower() == "true"
        row["rank"] = int(number(row["priority_rank"]))

    baseline = sum(row["acv"] for row in scores)
    monthly = []
    for month_index in range(months):
        revenue = 0.0
        for row in scores:
            hazard = 1 - (1 - row["p12"]) ** (1 / months)
            revenue += row["acv"] / months * (1 - hazard) ** month_index
        monthly.append(revenue)
    current_revenue = sum(monthly)

    def scenario(target: float) -> dict[str, float]:
        adjusted = [min(1.0, row["p12"] * target / number(config["historical_churn_rate"])) for row in scores]
        target_monthly = []
        for month_index in range(months):
            revenue = 0.0
            for row, probability in zip(scores, adjusted):
                hazard = 1 - (1 - probability) ** (1 / months)
                revenue += row["acv"] / months * (1 - hazard) ** month_index
            target_monthly.append(revenue)
        saved = sum(row["p12"] - probability for row, probability in zip(scores, adjusted))
        return {
            "saved": saved,
            "protected": sum(target_monthly) - current_revenue,
            "revenue": sum(target_monthly),
        }

    groups: dict[int, list[dict[str, str]]] = {0: [], 1: []}
    for row in panel:
        groups[1 if int(number(row["churn_12m"])) == 1 else 0].append(row)

    features = [
        ("SLA breach rate", "sla_breach_rate_90d", "percent", 1),
        ("Support response P90", "support_response_p90_hours_90d", "hours", 1),
        ("90-day spend change", "spend_change_90d_pct", "percent", 1),
        ("Services per client", "service_breadth_90d", "number", 1),
        ("Payment delay", "payment_delay_days_avg_90d", "days", 0),
    ]
    comparisons = []
    for label, key, kind, digits in features:
        means = []
        for group in (groups[0], groups[1]):
            values = [number(row[key]) for row in group]
            means.append(sum(values) / len(values) if values else 0.0)
        retained, churned = means
        if kind == "percent":
            retained_text, churned_text = fmt_pct(retained, digits), fmt_pct(churned, digits)
            difference = f"{fmt_n((churned - retained) * 100, 1)} pp"
        elif kind == "hours":
            retained_text, churned_text = f"{fmt_n(retained, 1)} h", f"{fmt_n(churned, 1)} h"
            difference = f"{fmt_n(churned - retained, 1)} h"
        elif kind == "days":
            retained_text, churned_text = f"{fmt_n(retained, 0)} days", f"{fmt_n(churned, 0)} days"
            difference = f"{fmt_n(churned - retained, 0)} days"
        else:
            retained_text, churned_text = fmt_n(retained, 1), fmt_n(churned, 1)
            difference = fmt_n(churned - retained, 1)
        comparisons.append([label, retained_text, churned_text, difference])

    flagged = [row for row in scores if row["flagged"]]
    scenarios = {rate: scenario(rate) for rate in (0.13, 0.15, 0.18)}
    return {
        "metrics": metrics,
        "config": config,
        "scores": scores,
        "drivers": sorted(drivers, key=lambda row: int(number(row["rank"]))),
        "ranked": sorted(ranked, key=lambda row: int(number(row["rank"]))),
        "baseline": baseline,
        "monthly": monthly,
        "current_revenue": current_revenue,
        "gap": baseline - current_revenue,
        "expected_next_3": sum(row["p3"] for row in scores),
        "expected_annual": sum(row["p12"] for row in scores),
        "flagged": flagged,
        "flagged_expected_3": sum(row["p3"] for row in flagged),
        "flagged_acv": sum(row["acv"] for row in flagged),
        "weighted_acv": sum(row["acv"] * row["p12"] for row in scores),
        "comparisons": comparisons,
        "scenarios": scenarios,
    }


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="ReportTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=22,
    leading=26, textColor=NAVY, alignment=TA_CENTER, spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="ReportSubtitle", parent=styles["Normal"], fontName="Helvetica", fontSize=10,
    leading=13, textColor=MUTED, alignment=TA_CENTER, spaceAfter=11,
))
styles.add(ParagraphStyle(
    name="SectionHead", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=14,
    leading=17, textColor=NAVY, spaceBefore=2, spaceAfter=7, keepWithNext=True,
))
styles.add(ParagraphStyle(
    name="SubHead", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=10.5,
    leading=13, textColor=INK, spaceBefore=5, spaceAfter=4, keepWithNext=True,
))
styles.add(ParagraphStyle(
    name="BodyTextCustom", parent=styles["BodyText"], fontName="Times-Roman", fontSize=9.3,
    leading=12.1, textColor=INK, spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="SmallBody", parent=styles["BodyTextCustom"], fontSize=8.4, leading=10.5, spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="CaptionCustom", parent=styles["BodyText"], fontName="Times-Italic", fontSize=8.1,
    leading=10.2, textColor=MUTED, spaceBefore=4, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="NoteCustom", parent=styles["BodyTextCustom"], fontName="Helvetica", fontSize=8.5,
    leading=11, textColor=INK, borderColor=LINE, borderWidth=0.6, borderPadding=7,
    backColor=colors.HexColor("#F8F9FB"), spaceBefore=4, spaceAfter=9,
))
styles.add(ParagraphStyle(
    name="FormulaCustom", parent=styles["BodyTextCustom"], fontName="Courier", fontSize=9,
    leading=12, textColor=NAVY, backColor=PALE, borderColor=LINE, borderWidth=0.5,
    borderPadding=6, spaceBefore=3, spaceAfter=7,
))
styles.add(ParagraphStyle(
    name="TableHeadCustom", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=7.4,
    leading=8.7, textColor=WHITE,
))
styles.add(ParagraphStyle(
    name="TableCellCustom", parent=styles["BodyText"], fontName="Helvetica", fontSize=7.6,
    leading=9, textColor=INK,
))
styles.add(ParagraphStyle(
    name="TableCellSmall", parent=styles["BodyText"], fontName="Helvetica", fontSize=6.9,
    leading=8.1, textColor=INK,
))
styles.add(ParagraphStyle(
    name="TableNumCustom", parent=styles["BodyText"], fontName="Courier", fontSize=7.2,
    leading=8.5, textColor=INK, alignment=TA_RIGHT,
))
styles.add(ParagraphStyle(
    name="SmallCentered", parent=styles["BodyText"], fontName="Helvetica", fontSize=8,
    leading=10, textColor=MUTED, alignment=TA_CENTER,
))


def P(text: str, style: str = "BodyTextCustom") -> Paragraph:
    return Paragraph(text, styles[style])


def safe(value: object) -> str:
    return escape(str(value))


def report_table(headers: list[str], rows: list[list[object]], widths: list[float], small: bool = False) -> Table:
    head = [P(safe(value), "TableHeadCustom") for value in headers]
    cell_style = "TableCellSmall" if small else "TableCellCustom"
    body = []
    for row in rows:
        body.append([P(safe(value), cell_style) for value in row])
    table = Table([head, *body], colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING", (0, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, colors.HexColor("#F7F8FA")]),
    ]))
    return table


def chart_drivers(drivers: list[dict[str, str]]) -> Drawing:
    width, height = 500, 226
    drawing = Drawing(width, height)
    label_x, bar_x, bar_width = 0, 142, 310
    max_share = 0.25
    for tick in (0, 0.05, 0.10, 0.15, 0.20, 0.25):
        x = bar_x + bar_width * tick / max_share
        drawing.add(Line(x, 18, x, height - 6, strokeColor=LINE, strokeWidth=0.45))
        drawing.add(String(x, 3, f"{int(tick * 100)}%", textAnchor="middle", fontName="Helvetica", fontSize=7, fillColor=MUTED))
    for index, row in enumerate(drivers[:10]):
        y = height - 17 - index * 20
        driver = row["driver"]
        label = {
            "sla_breach_rate_90d": "SLA breach rate",
            "support_response_p90_hours_90d": "Support response time",
            "spend_change_90d_pct": "90-day spend change",
            "service_breadth_90d": "Services per client",
            "payment_delay_days_avg_90d": "Payment delay",
            "tenure_months": "Tenure",
            "acv_usd": "Annual contract value",
            "contract_tier": "Contract tier",
            "missing_financial_share_90d": "Missing financial data",
            "region": "Region",
        }.get(driver, driver.replace("_", " "))
        share = number(row["share_of_total_shap"])
        fill = NAVY if index < 3 else GRAY
        drawing.add(String(label_x, y + 1, label, fontName="Helvetica", fontSize=7.5, fillColor=INK))
        drawing.add(Rect(bar_x, y, bar_width * share / max_share, 9, fillColor=fill, strokeColor=None))
        drawing.add(String(bar_x + bar_width * share / max_share + 5, y + 1, fmt_pct(share, 0), fontName="Courier", fontSize=7.2, fillColor=INK))
    return drawing


def chart_forecast(monthly: list[float], baseline: float) -> Drawing:
    width, height = 500, 206
    drawing = Drawing(width, height)
    left, right, bottom, top = 43, 482, 30, 190
    low = min(min(monthly) / 1_000_000 - 0.12, baseline / 12 / 1_000_000 - 0.12)
    high = max(baseline / 12 / 1_000_000 + 0.12, max(monthly) / 1_000_000 + 0.12)
    if high - low < 0.5:
        high = low + 0.5

    def x(index: int) -> float:
        return left + (right - left) * index / max(1, len(monthly) - 1)

    def y(value: float) -> float:
        return bottom + (top - bottom) * (value - low) / (high - low)

    for tick_index in range(5):
        value = low + (high - low) * tick_index / 4
        yt = y(value)
        drawing.add(Line(left, yt, right, yt, strokeColor=LINE, strokeWidth=0.5))
        drawing.add(String(left - 5, yt - 2.5, f"${value:.1f}M", textAnchor="end", fontName="Helvetica", fontSize=7, fillColor=MUTED))
    base_y = y(baseline / 12 / 1_000_000)
    drawing.add(Line(left, base_y, right, base_y, strokeColor=GRAY, strokeWidth=1.5, strokeDashArray=[5, 3]))
    points = [(x(i), y(value / 1_000_000)) for i, value in enumerate(monthly)]
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        drawing.add(Line(x1, y1, x2, y2, strokeColor=NAVY, strokeWidth=2.2))
    for index, (xp, yp) in enumerate(points):
        drawing.add(Rect(xp - 1.8, yp - 1.8, 3.6, 3.6, fillColor=NAVY, strokeColor=NAVY))
        if index % 2 == 0 or index == len(points) - 1:
            drawing.add(String(xp, 14, f"M{index + 1}", textAnchor="middle", fontName="Helvetica", fontSize=6.6, fillColor=MUTED))
    drawing.add(Line(left + 8, height - 5, left + 32, height - 5, strokeColor=GRAY, strokeWidth=1.5, strokeDashArray=[5, 3]))
    drawing.add(String(left + 37, height - 8, "No-churn baseline", fontName="Helvetica", fontSize=7.2, fillColor=MUTED))
    drawing.add(Line(left + 164, height - 5, left + 188, height - 5, strokeColor=NAVY, strokeWidth=2))
    drawing.add(String(left + 193, height - 8, "Risk-adjusted revenue", fontName="Helvetica", fontSize=7.2, fillColor=MUTED))
    return drawing


def add_caption(story: list, number_text: str, text: str) -> None:
    story.append(P(f"<b>{safe(number_text)}.</b> {text}", "CaptionCustom"))


def draw_page(canvas, doc) -> None:
    canvas.saveState()
    page_width, page_height = A4
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(18 * mm, page_height - 16 * mm, page_width - 18 * mm, page_height - 16 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, page_height - 12 * mm, "Data Analytics Project · Question 2")
    canvas.drawRightString(page_width - 18 * mm, page_height - 12 * mm, "Managed IT Services")
    canvas.line(18 * mm, 15 * mm, page_width - 18 * mm, 15 * mm)
    canvas.drawString(18 * mm, 9 * mm, "Client Churn Risk and Revenue Forecasting")
    canvas.drawRightString(page_width - 18 * mm, 9 * mm, f"Page {doc.page} of 6")
    canvas.restoreState()


def build_report() -> None:
    data = load_project()
    metrics = data["metrics"]
    model = metrics["model_metrics"]
    config = data["config"]
    page_width, _ = A4
    content_width = page_width - 36 * mm
    doc = SimpleDocTemplate(
        str(OUTPUT), pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=21 * mm, bottomMargin=20 * mm,
        title="Client Churn Risk and Revenue Forecasting",
        author="Data Analytics Project",
        subject="Managed IT Services churn risk and revenue forecast",
    )
    story: list = []

    # Page 1: problem and scope.
    story.extend([
        Spacer(1, 6 * mm),
        P("Client Churn Risk and Revenue Forecasting", "ReportTitle"),
        P("Question 2 · Managed IT Services · 200 client records", "ReportSubtitle"),
        P("<b>Simulation note.</b> I use simulated client records, not real company data. The values explain the analysis method and are not real account results.", "NoteCustom"),
        P("1. Problem and approach", "SectionHead"),
        P("I study a managed IT services portfolio that provides infrastructure management, cloud migration, security and 24/7 support. I estimate which clients may not renew, review the signals behind their scores, forecast revenue and plan retention work."),
        P("The portfolio has about 10 million transaction rows, 12% missing financial values and an 18% annual churn rate. The transaction volume is a scale assumption. A client-month summary is more useful for scoring than a raw transaction row."),
        P("I define churn as not renewing within 12 months and treat 18% as the yearly rate. I interpret “reduce churn by 5%” as a five-percentage-point change, from 18% to 13%. All amounts are in USD."),
        P("I group activity by client and month, fill missing values using information from the training period, fit a churn model, score clients and explain the leading signals. I use later months to test the model."),
        P("At the current scores, the no-churn baseline is <b>{}</b> ({}), the risk-adjusted forecast is <b>{}</b> ({}), and revenue at risk is <b>{}</b> ({}). I estimate <b>{}</b> expected exits over the next 3 months and flag <b>{}</b> records for first-wave review.".format(
            fmt_money(data["baseline"]), fmt_m(data["baseline"]),
            fmt_money(data["current_revenue"]), fmt_m(data["current_revenue"]),
            fmt_money(data["gap"]), fmt_m(data["gap"]),
            fmt_n(data["expected_next_3"], 1), fmt_n(len(data["flagged"]), 0),
        )), 
        PageBreak(),
    ])

    # Page 2: preparation and example aggregation.
    story.extend([
        P("2. Data preparation", "SectionHead"),
        P("I would use SQL or Spark to group billing, support and service events into one row per client per month. At 200 clients and about 25 monthly snapshots, the example panel has about 5,000 rows. The 10 million raw transactions set the scale; they are not loaded in this project."),
        P("This SQL is an aggregation example only. I did not run it on real data:", "BodyTextCustom"),
        P("SELECT client_id, month,\n       SUM(amount) AS monthly_spend,\n       AVG(CASE WHEN sla_met = 0 THEN 1.0 ELSE 0.0 END) AS sla_breach_rate,\n       percentile_approx(response_hours, 0.90) AS response_p90_hours,\n       AVG(payment_delay_days) AS payment_delay_days,\n       COUNT(DISTINCT service) AS service_breadth\nFROM client_activity\nGROUP BY client_id, month;", "FormulaCustom"),
        P("<b>Listing 1.</b> Example SQL aggregation by client and month.", "CaptionCustom"),
        P("3. Missing values and churn labels", "SubHead"),
        P("I do not drop incomplete records. I would fill missing financial amounts with a median from similar service and contract groups, using training months only, and keep a flag for missing values. This lets the model use the missingness information without treating it as a true spend value."),
        P("Churn is less common than renewal. I weight churn cases about {} times more heavily and check recall and PR-AUC rather than accuracy alone. An all-renew prediction would be 82% accurate at an 18% churn rate but would find no churners. I train on earlier months and test on the last two months.".format(fmt_n(model["scale_pos_weight"], 1))),
        PageBreak(),
    ])

    # Page 3: model results, near-term risk, top clients.
    story.extend([
        P("4. Model and client risk", "SectionHead"),
        P("I use an XGBoost classifier, a tree model that combines many decision trees. Its 10 inputs cover SLA breaches, support response time, spend change, services used, payment delay, tenure, annual contract value, contract tier, region and missing financial data."),
        P("The test set contains {} later client-month records, with a {} churn rate. Table 1 shows the results. I use a 30% contact limit and compare the assumed $3,000 cost of an outreach call with the cost of a missed renewal.".format(fmt_n(model["test_rows"]), fmt_pct(model["test_positive_rate"]))),
    ])
    metric_rows = [
        ["ROC-AUC", fmt_n(model["roc_auc"], 2), "How often a churner ranks above a client who renews."],
        ["PR-AUC", fmt_n(model["pr_auc_average_precision"], 2), "Summarises precision and recall for churn cases."],
        ["Recall", fmt_pct(model["recall_churn_class_at_cost_threshold"], 0), "Share of churn cases found in the test set."],
        ["Precision", fmt_pct(model["precision_at_cost_threshold"], 0), "Share of test alerts that were churn cases."],
    ]
    story.append(report_table(["Metric", "Result", "Meaning"], metric_rows, [28 * mm, 23 * mm, content_width - 51 * mm]))
    add_caption(story, "Table 1", "Model results on the later client-month test records.")
    story.extend([
        P("The annual probability p12 becomes a 3-month probability using <font name='Courier'>p3 = 1 - (1 - p12)<super>3/12</super></font>. The current file has {} clients, {} first-wave flags and {} expected exits over the next 3 months. The 60 flagged clients account for {} expected near-term exits and {} in annual contract value.".format(
            fmt_n(len(data["scores"])), fmt_n(len(data["flagged"])), fmt_n(data["expected_next_3"], 1),
            fmt_n(data["flagged_expected_3"], 1), fmt_m(data["flagged_acv"]),
        )),
        P("Table 2 lists the first ten client records by score. I would review the top 20 first, then continue through the flagged group."),
    ])
    top_rows = []
    driver_labels = {
        "sla_breach_rate_90d": "SLA breaches",
        "support_response_p90_hours_90d": "Support response",
        "spend_change_90d_pct": "Falling spend",
        "service_breadth_90d": "Services used",
        "payment_delay_days_avg_90d": "Payment delay",
        "tenure_months": "Tenure",
        "acv_usd": "Contract value",
    }
    for rank, row in enumerate(data["ranked"][:10], 1):
        acv = number(row["contract_value_usd"])
        top_rows.append([
            str(rank), row["client_id"], row["contract_tier"],
            (fmt_money(acv / 1_000, 0) + "K") if acv < 1_000_000 else fmt_m(acv, 2),
            fmt_pct(number(row["probability_12m"]), 0),
            fmt_pct(number(row["probability_3m"]), 0),
            driver_labels.get(row["main_driver"], row["main_driver"].replace("_", " ")),
        ])
    story.append(report_table(
        ["#", "Client", "Tier", "Contract value", "12-month risk", "3-month risk", "Main driver"],
        top_rows,
        [8 * mm, 22 * mm, 18 * mm, 24 * mm, 22 * mm, 20 * mm, content_width - 114 * mm],
        small=True,
    ))
    add_caption(story, "Table 2", "Ten highest-priority client records. Amounts and risks are rounded for display.")
    story.extend([P("The full ranked list contains all 200 client records. I would refresh the scores monthly."), PageBreak()])

    # Page 4: model drivers and panel comparisons.
    story.extend([
        P("5. Main factors behind churn", "SectionHead"),
        P("I use SHAP values to show how the model shares a score across its input features. Figure 1 ranks the mean absolute contribution. The three leading features account for about {} of total importance.".format(
            fmt_pct(sum(number(row["share_of_total_shap"]) for row in data["drivers"][:3]), 0),
        )),
        chart_drivers(data["drivers"]),
    ])
    add_caption(story, "Figure 1", "Model driver importance by share of mean absolute contribution.")
    story.append(P("These patterns are associations, not causes.", "SmallCentered"))
    story.extend([
        P("Table 3 compares average values for client-months labelled churned and retained. P90 is the response time at or below which 90% of responses fall."),
        report_table(
            ["Feature", "Retained mean", "Churned mean", "Difference"],
            data["comparisons"],
            [42 * mm, 29 * mm, 29 * mm, content_width - 100 * mm],
        ),
    ])
    add_caption(story, "Table 3", "Feature averages for retained and churned client-month records.")
    story.extend([
        P("Service quality stands out: the churned group has a higher breach rate and slower response time. Spend also falls more in the churned group, and those clients use fewer services. I would check each client’s situation before deciding what to do."),
        PageBreak(),
    ])

    # Page 5: forecast and simulator.
    story.extend([
        P("6. Revenue forecast for the next 12 months", "SectionHead"),
        P("I spread each client’s annual contract value evenly across 12 months. For annual churn probability p12, I calculate a steady monthly hazard h = 1 - (1 - p12)<super>1/12</super>. Expected revenue in each month includes clients who are still active at the start of that month. The calculation leaves out new clients, expansion, price changes and currency changes."),
        P("Figure 2 compares the no-churn baseline with the risk-adjusted forecast. The baseline is {}. The risk-adjusted forecast is {}, leaving {} at risk ({}) of the baseline.".format(
            fmt_m(data["baseline"]), fmt_m(data["current_revenue"]), fmt_m(data["gap"]), fmt_pct(data["gap"] / data["baseline"], 1),
        )),
        chart_forecast(data["monthly"], data["baseline"]),
    ])
    add_caption(story, "Figure 2", "Monthly no-churn baseline and risk-adjusted revenue forecast.")
    quarter_rows = []
    quarter_count = int(config["quarters_per_year"])
    quarter_months = int(config["forecast_months"]) // quarter_count
    for quarter in range(quarter_count):
        start = quarter * quarter_months
        end = (quarter + 1) * quarter_months
        baseline_quarter = data["baseline"] / quarter_count
        risk_quarter = sum(data["monthly"][start:end])
        quarter_rows.append([f"Q{quarter + 1}", fmt_m(baseline_quarter), fmt_m(risk_quarter), fmt_m(baseline_quarter - risk_quarter)])
    quarter_rows.append(["Full year", fmt_m(data["baseline"]), fmt_m(data["current_revenue"]), fmt_m(data["gap"])])
    story.extend([
        report_table(["Period", "Baseline", "Risk-adjusted", "At risk"], quarter_rows, [29 * mm, 35 * mm, 39 * mm, content_width - 103 * mm]),
    ])
    add_caption(story, "Table 4", "Quarterly forecast totals. Annual totals use unrounded calculations.")
    story.extend([
        P("The probability-weighted annual contract value of expected churners is {}. This is not the same as forecast revenue at risk: the forecast counts revenue month by month.".format(fmt_m(data["weighted_acv"]))),
        P("7. Retention simulator", "SubHead"),
    ])
    scenario_rows = []
    for rate in (0.13, 0.15, 0.18):
        result = data["scenarios"][rate]
        scenario_rows.append(
            f"At {fmt_pct(rate, 0)}: {fmt_n(result['saved'], 1)} expected clients saved, "
            f"{scenario_money(result['protected'])} revenue protected and "
            f"{scenario_money(result['revenue'])} target revenue."
        )
    story.append(P("<br/>".join(scenario_rows), "SmallBody"))
    story.append(P("These are planning estimates, not measured program results.", "NoteCustom"))
    story.append(PageBreak())

    # Page 6: action targets, interpretation and limitations.
    story.extend([
        P("8. Retention actions and next steps", "SectionHead"),
        P("At an 18% annual rate, 200 clients imply {} expected annual exits. The 13% target implies about 26, or {} expected clients saved. At an average flagged-client annual contract value of about {}, that is about {} in annual contract value. The 13% simulator separately estimates {} of risk-adjusted revenue protected over the 12-month forecast.".format(
            fmt_n(data["expected_annual"], 1), fmt_n(data["expected_annual"] - data["scenarios"][0.13]["saved"], 1),
            fmt_m(data["flagged_acv"] / max(1, len(data["flagged"])), 2),
            fmt_m(data["scenarios"][0.13]["saved"] * data["flagged_acv"] / max(1, len(data["flagged"]))),
            scenario_money(data["scenarios"][0.13]["protected"]),
        )),
        P("I would begin with the 60 flagged clients. Table 5 links each leading signal to an action and a target."),
    ])
    action_rows = [
        ["SLA breaches", "I would review each breach, name an escalation contact and discuss service credits after a breach.", "Breach rate near 3%"],
        ["Support response", "I would use a priority queue and 24/7 escalation, then review open tickets weekly.", "Response time near 6 hours"],
        ["Falling spend", "I would flag a 90-day spend drop over 10% and arrange an account meeting within two weeks.", "Reverse the decline within a quarter"],
        ["Services used", "I would ask which services the client needs and help set up services already in the contract.", "Move from about 2.2 to 3 services per client"],
        ["Payment delay", "I would check invoice accuracy, settle disputes early and discuss flexible terms when appropriate.", "Average delay under 10 days"],
    ]
    story.append(report_table(["Signal", "Action", "Target"], action_rows, [29 * mm, 100 * mm, content_width - 129 * mm], small=True))
    add_caption(story, "Table 5", "Retention actions and operating targets for the flagged group.")
    story.extend([
        P("Next steps", "SubHead"),
        P("1. Re-run the analysis on real billing, support and contract data; confirm the renewal definition and data quality.<br/>2. Pilot the actions on part of the review group and compare renewal and revenue outcomes.<br/>3. Track churn, saves and revenue monthly, then review the assumptions with finance and service teams."),
        P("Limitations. This report uses simulated records, so the scores do not describe real clients. I assume yearly risk is spread evenly across months. The forecast leaves out new clients, expansion, price changes, currency changes and revenue losses unrelated to churn.", "NoteCustom"),
    ])

    doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)


if __name__ == "__main__":
    build_report()
