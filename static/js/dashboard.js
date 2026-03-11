/* ═══════════════════════════════════════════════════════════════════════════
   SAP Vendor Risk – Dashboard JS  (final)
   Improvements applied:
     1. Slicer / filter bar  (Risk Level + Overdue Range + Days-Overdue Range)
     2. Top-10 chart sorted by overdue_amount desc, x-axis shows ₹ amount
     3. Preview table sorted by risk_score desc
     4. Aging-by-Risk histogram – 100-day bands from actual data range
     5. New Analysis button injected into page header
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

/* ─── globals ──────────────────────────────────────────────────────────────── */
const DATA        = RAW_DATA;         // injected by Flask template
const VENDORS     = DATA.vendors;     // full vendor list
const RISK_ORDER  = ["Critical", "High", "Medium", "Low"];
const RISK_COLORS = {
  Critical : "#ef4444",
  High     : "#f97316",
  Medium   : "#eab308",
  Low      : "#22c55e",
};

/* Chart instances we may need to destroy/recreate */
let agingChart, riskPieChart, top10Chart, scatterChart, agingByRiskChart;

/* ─── latest filtered vendor snapshot (kept in sync by renderAll) ─────────── */
let _currentVendors = [];

/* ─── active filter state ───────────────────────────────────────────────────── */
let activeFilters = {
  riskLevels   : new Set(["Critical", "High", "Medium", "Low"]),
  overdueMin   : 0,
  overdueMax   : Infinity,
  daysODMin    : 0,
  daysODMax    : Infinity,
};

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  injectNewAnalysisBtn();
  injectSlicerBar();
  renderAll(VENDORS);
});

/* ═══════════════════════════════════════════════════════════════════════════
   NEW ANALYSIS BUTTON  – injected into page-header
   ═══════════════════════════════════════════════════════════════════════════ */
function injectNewAnalysisBtn() {
  const header = document.querySelector(".page-header");
  if (!header || header.querySelector(".btn-new-analysis")) return;
  const btn = document.createElement("a");
  btn.href      = "/";
  btn.className = "btn-new-analysis";
  btn.innerHTML = `<i class="fas fa-plus-circle"></i> New Analysis`;
  header.appendChild(btn);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SLICER BAR  – injected above the KPI cards
   ═══════════════════════════════════════════════════════════════════════════ */
function injectSlicerBar() {
  const maxOverdue = Math.max(...VENDORS.map(v => v.overdue_amount));
  const maxDays    = Math.max(...VENDORS.map(v => v.avg_days_overdue));

  const bar = document.createElement("div");
  bar.className = "slicer-bar";
  bar.innerHTML = `
    <div class="slicer-section">
      <span class="slicer-label"><i class="fas fa-filter"></i> Risk Level</span>
      <div class="slicer-pills" id="slicerRisk">
        ${RISK_ORDER.map(r => `
          <button class="slicer-pill active" data-risk="${r}" style="--pill-color:${RISK_COLORS[r]}">
            <span class="pill-dot" style="background:${RISK_COLORS[r]}"></span>${r}
          </button>`).join("")}
      </div>
    </div>

    <div class="slicer-section">
      <span class="slicer-label"><i class="fas fa-rupee-sign"></i> Overdue Amount</span>
      <div class="range-group">
        <input type="range" id="slicerOverdueMax" min="0" max="${maxOverdue.toFixed(0)}"
               value="${maxOverdue.toFixed(0)}" step="${(maxOverdue / 200).toFixed(0)}" />
        <span class="range-val" id="slicerOverdueMaxVal">Up to ${fmtCurrency(maxOverdue)}</span>
      </div>
    </div>

    <div class="slicer-section">
      <span class="slicer-label"><i class="fas fa-calendar-alt"></i> Avg Days Overdue</span>
      <div class="range-group">
        <input type="range" id="slicerDaysMax" min="0" max="${maxDays.toFixed(0)}"
               value="${maxDays.toFixed(0)}" step="10" />
        <span class="range-val" id="slicerDaysMaxVal">Up to ${maxDays.toFixed(0)} days</span>
      </div>
    </div>

    <button class="slicer-reset" id="slicerReset"><i class="fas fa-undo"></i> Reset</button>
  `;

  /* Insert before kpiGrid */
  const kpiGrid = document.getElementById("kpiGrid");
  kpiGrid.parentNode.insertBefore(bar, kpiGrid);

  /* Inject all CSS */
  injectSlicerCSS();

  /* ── events ── */
  document.querySelectorAll(".slicer-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = btn.dataset.risk;
      btn.classList.toggle("active");
      if (activeFilters.riskLevels.has(r)) activeFilters.riskLevels.delete(r);
      else activeFilters.riskLevels.add(r);
      applyFilters();
    });
  });

  const sliderOverdue = document.getElementById("slicerOverdueMax");
  sliderOverdue.addEventListener("input", () => {
    activeFilters.overdueMax = parseFloat(sliderOverdue.value);
    document.getElementById("slicerOverdueMaxVal").textContent =
      "Up to " + fmtCurrency(activeFilters.overdueMax);
    applyFilters();
  });

  const sliderDays = document.getElementById("slicerDaysMax");
  sliderDays.addEventListener("input", () => {
    activeFilters.daysODMax = parseFloat(sliderDays.value);
    document.getElementById("slicerDaysMaxVal").textContent =
      "Up to " + sliderDays.value + " days";
    applyFilters();
  });

  document.getElementById("slicerReset").addEventListener("click", resetFilters);
}

function applyFilters() {
  const filtered = VENDORS.filter(v =>
    activeFilters.riskLevels.has(v.predicted_risk) &&
    v.overdue_amount   <= activeFilters.overdueMax &&
    v.avg_days_overdue <= activeFilters.daysODMax
  );
  renderAll(filtered);
}

function resetFilters() {
  activeFilters.riskLevels = new Set(["Critical", "High", "Medium", "Low"]);
  activeFilters.overdueMax = Infinity;
  activeFilters.daysODMax  = Infinity;

  document.querySelectorAll(".slicer-pill").forEach(b => b.classList.add("active"));

  const maxOverdue = Math.max(...VENDORS.map(v => v.overdue_amount));
  const maxDays    = Math.max(...VENDORS.map(v => v.avg_days_overdue));

  const so = document.getElementById("slicerOverdueMax");
  so.value = so.max;
  document.getElementById("slicerOverdueMaxVal").textContent = "Up to " + fmtCurrency(maxOverdue);

  const sd = document.getElementById("slicerDaysMax");
  sd.value = sd.max;
  document.getElementById("slicerDaysMaxVal").textContent = "Up to " + maxDays.toFixed(0) + " days";

  renderAll(VENDORS);
}

/* ═══════════════════════════════════════════════════════════════════════════
   RENDER ALL  –  called on init & every filter change
   ═══════════════════════════════════════════════════════════════════════════ */
function renderAll(vendors) {
  _currentVendors = vendors;   // keep in sync for tab re-renders
  renderKPIs(vendors);
  renderAgingChart(vendors);
  renderRiskPie(vendors);
  renderTop10(vendors);               /* sorted by overdue_amount desc */
  renderScatter(vendors);
  renderAgingByRisk(vendors);         /* 100-day histogram by risk category */
  renderPreviewTable(vendors);        /* sorted by risk_score desc */
}

/* ═══════════════════════════════════════════════════════════════════════════
   KPIs
   ═══════════════════════════════════════════════════════════════════════════ */
function renderKPIs(vendors) {
  const totalOverdue = vendors.reduce((s, v) => s + v.overdue_amount, 0);
  const highRisk     = vendors.filter(v => v.predicted_risk === "High").length;
  const critical     = vendors.filter(v => v.predicted_risk === "Critical").length;

  setText("kpiTotalVendors", vendors.length.toLocaleString());
  setText("kpiOverdue",      fmtCurrency(totalOverdue));
  setText("kpiHighRisk",     highRisk.toLocaleString());
  setText("kpiCritical",     critical.toLocaleString());
}

/* ═══════════════════════════════════════════════════════════════════════════
   AGING BUCKET CHART
   Standard 0-30/31-60/61-90/91-120/120+ bands.
   With AGING_REFERENCE_DATE set in ml_model.py these populate correctly.
   ═══════════════════════════════════════════════════════════════════════════ */
function renderAgingChart(vendors) {
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "91-120": 0, "120+": 0 };
  vendors.forEach(v => {
    const d = v.avg_days_overdue;
    const bucket = d <= 30  ? "0-30"   :
                   d <= 60  ? "31-60"  :
                   d <= 90  ? "61-90"  :
                   d <= 120 ? "91-120" : "120+";
    buckets[bucket] += v.overdue_amount;
  });

  const labels = Object.keys(buckets);
  const values = Object.values(buckets);

  destroyChart(agingChart);
  agingChart = new Chart(document.getElementById("agingChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Overdue Amount",
        data: values,
        backgroundColor: ["#22c55e","#84cc16","#eab308","#f97316","#ef4444"],
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: chartOpts("Overdue Amount (₹)", true),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   RISK PIE
   ═══════════════════════════════════════════════════════════════════════════ */
function renderRiskPie(vendors) {
  const counts = {};
  RISK_ORDER.forEach(r => counts[r] = 0);
  vendors.forEach(v => { if (counts[v.predicted_risk] !== undefined) counts[v.predicted_risk]++; });

  destroyChart(riskPieChart);
  riskPieChart = new Chart(document.getElementById("riskPieChart"), {
    type: "doughnut",
    data: {
      labels: RISK_ORDER,
      datasets: [{
        data: RISK_ORDER.map(r => counts[r]),
        backgroundColor: RISK_ORDER.map(r => RISK_COLORS[r]),
        borderWidth: 3,
        borderColor: "#0f172a",
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#cbd5e1", font: { size: 12 }, padding: 16 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} vendors` } }
      },
      cutout: "60%",
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOP-10 CHART  – sorted by overdue_amount desc
   Bar colour reflects risk level. Tooltip shows amount + risk score.
   ═══════════════════════════════════════════════════════════════════════════ */
function renderTop10(vendors) {
  const top10 = [...vendors]
    .sort((a, b) => b.overdue_amount - a.overdue_amount)
    .slice(0, 10);

  const labels = top10.map(v => truncate(v.vendor_name, 20));
  const values = top10.map(v => v.overdue_amount);
  const bgs    = top10.map(v => RISK_COLORS[v.predicted_risk] || "#94a3b8");

  destroyChart(top10Chart);
  top10Chart = new Chart(document.getElementById("top10Chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Overdue Amount",
        data: values,
        backgroundColor: bgs,
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      responsive         : true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label     : ctx => ` ${fmtCurrency(ctx.raw)}`,
            afterLabel: ctx => ` Risk Score: ${top10[ctx.dataIndex].risk_score.toFixed(1)}`,
          }
        }
      },
      scales: {
        x: {
          grid : { color: "rgba(255,255,255,0.06)" },
          ticks: { color: "#94a3b8", callback: v => fmtCurrencyShort(v) },
          title: { display: true, text: "Overdue Amount (₹)", color: "#94a3b8" },
        },
        y: { ticks: { color: "#cbd5e1", font: { size: 11 } }, grid: { display: false } },
      },
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCATTER
   ═══════════════════════════════════════════════════════════════════════════ */
function renderScatter(vendors) {
  const byRisk = {};
  RISK_ORDER.forEach(r => byRisk[r] = []);
  vendors.forEach(v => {
    if (byRisk[v.predicted_risk]) {
      byRisk[v.predicted_risk].push({ x: v.overdue_amount, y: v.risk_score, label: v.vendor_name });
    }
  });

  destroyChart(scatterChart);
  scatterChart = new Chart(document.getElementById("scatterChart"), {
    type: "scatter",
    data: {
      datasets: RISK_ORDER.map(r => ({
        label: r,
        data: byRisk[r],
        backgroundColor: RISK_COLORS[r] + "bb",
        pointRadius: 4,
        pointHoverRadius: 7,
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1", font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => [
              ctx.dataset.label,
              `Vendor: ${ctx.raw.label}`,
              `Overdue: ${fmtCurrency(ctx.raw.x)}`,
              `Risk Score: ${ctx.raw.y}`,
            ]
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", callback: v => fmtCurrencyShort(v) },
          grid : { color: "rgba(255,255,255,0.06)" },
          title: { display: true, text: "Overdue Amount", color: "#94a3b8" },
        },
        y: {
          min: 0, max: 100,
          ticks: { color: "#94a3b8" },
          grid : { color: "rgba(255,255,255,0.06)" },
          title: { display: true, text: "Risk Score", color: "#94a3b8" },
        },
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   RISK INSIGHTS CHART  –  replaces old aging-by-risk histogram
   Three tabs, all grouped by Risk Level (Critical / High / Medium / Low):
     Tab 1 – Total Overdue Amount (₹)
     Tab 2 – Average Risk Score (0–100)
     Tab 3 – % Critical Invoices (invoices overdue 90+ days)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderAgingByRisk(vendors) {

  /* ── build / find container ──────────────────────────────────────────── */
  let wrapper = document.getElementById("riskInsightsWrapper");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id        = "riskInsightsWrapper";
    wrapper.className = "chart-grid-1";
    wrapper.innerHTML = `
      <div class="chart-card">
        <div class="chart-card-header" style="flex-wrap:wrap;gap:10px;">
          <div>
            <h3><i class="fas fa-chart-bar"></i> Risk Level Insights</h3>
            <span class="chart-subtitle">Key metrics broken down by risk category</span>
          </div>
          <div class="insight-tabs" id="insightTabs">
            <button class="itab active" data-tab="overdue">
              <i class="fas fa-rupee-sign"></i> Overdue Amount
            </button>
            <button class="itab" data-tab="score">
              <i class="fas fa-tachometer-alt"></i> Avg Risk Score
            </button>
            <button class="itab" data-tab="pct">
              <i class="fas fa-clock"></i> Avg Days Overdue
            </button>
          </div>
        </div>
        <div class="chart-wrap chart-wrap-wide">
          <canvas id="agingByRiskChart"></canvas>
        </div>
      </div>`;
    const cards = document.querySelectorAll(".chart-grid-2");
    cards[cards.length - 1].parentNode.insertBefore(wrapper, cards[cards.length - 1].nextSibling);

    /* wire tab clicks — always use _currentVendors so filter changes are reflected */
    wrapper.querySelectorAll(".itab").forEach(btn => {
      btn.addEventListener("click", () => {
        wrapper.querySelectorAll(".itab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _renderInsightChart(_currentVendors, btn.dataset.tab);
      });
    });

    /* inject tab CSS once */
    _injectInsightCSS();
  }

  /* always re-render active tab with latest filtered vendors */
  const activeTab = (wrapper.querySelector(".itab.active") || wrapper.querySelector(".itab"))
    ?.dataset.tab || "overdue";
  _renderInsightChart(vendors, activeTab);
}

function _renderInsightChart(vendors, tab) {
  if (!vendors.length) return;

  /* ── detect whether new fields from updated ml_model.py are present ─── */
  const hasPctField = vendors.some(v => v.pct_critical_invoices != null);

  /* ── aggregate per risk level ────────────────────────────────────────── */
  const stats = {};
  RISK_ORDER.forEach(r => stats[r] = {
    totalOverdue : 0,
    scoreSum     : 0,
    pctSum       : 0,   // pct_critical_invoices OR proxy (avg_days_overdue > 90)
    daysSum      : 0,   // avg_days_overdue
    count        : 0,
  });

  vendors.forEach(v => {
    const s = stats[v.predicted_risk];
    if (!s) return;
    s.totalOverdue += v.overdue_amount;
    s.scoreSum     += v.risk_score;
    s.daysSum      += (v.avg_days_overdue || 0);
    /* use real field if available, otherwise proxy: vendor is "critical" if avg OD > 90 */
    s.pctSum       += hasPctField
      ? (v.pct_critical_invoices || 0)
      : (v.avg_days_overdue > 90 ? 1 : 0);
    s.count        += 1;
  });

  /* ── build chart config per tab ──────────────────────────────────────── */
  let values, yLabel, tooltipFmt, yTickFmt;

  if (tab === "overdue") {
    values     = RISK_ORDER.map(r => stats[r].totalOverdue);
    yLabel     = "Total Overdue Amount (₹)";
    tooltipFmt = v => fmtCurrency(v);
    yTickFmt   = v => fmtCurrencyShort(v);

  } else if (tab === "score") {
    values     = RISK_ORDER.map(r => stats[r].count
      ? +(stats[r].scoreSum / stats[r].count).toFixed(2) : 0);
    yLabel     = "Average Risk Score (0–100)";
    tooltipFmt = v => v.toFixed(1);
    yTickFmt   = v => v;

  } else {
    /* pct tab — show avg_days_overdue per risk level (always available),
       with a secondary note when real pct field is present              */
    values     = RISK_ORDER.map(r => stats[r].count
      ? +(stats[r].daysSum / stats[r].count).toFixed(1) : 0);
    yLabel     = "Avg Days Overdue per Vendor";
    tooltipFmt = v => v.toFixed(0) + " days";
    yTickFmt   = v => v + "d";
  }

  /* ── extra context for tooltip ───────────────────────────────────────── */
  const vendorCounts = RISK_ORDER.map(r => stats[r].count);

  destroyChart(agingByRiskChart);
  agingByRiskChart = new Chart(document.getElementById("agingByRiskChart"), {
    type: "bar",
    data: {
      labels: RISK_ORDER,
      datasets: [{
        label             : yLabel,
        data              : values,
        backgroundColor   : RISK_ORDER.map(r => RISK_COLORS[r]),
        borderRadius      : 8,
        borderSkipped     : false,
        barPercentage     : 0.55,
        categoryPercentage: 0.7,
      }]
    },
    options: {
      responsive         : true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title : items => `${items[0].label} Risk`,
            label : ctx  => ` ${yLabel.split("(")[0].trim()}: ${tooltipFmt(ctx.raw)}`,
            footer: items => {
              const r   = RISK_ORDER[items[0].dataIndex];
              const cnt = stats[r].count || 1;
              const fil = vendors.filter(v => v.predicted_risk === r);
              if (tab === "overdue") {
                return [
                  `Vendors in category: ${cnt.toLocaleString()}`,
                  `Avg per vendor: ${fmtCurrency(stats[r].totalOverdue / cnt)}`,
                ];
              } else if (tab === "score") {
                const minS = Math.min(...fil.map(v => v.risk_score)).toFixed(1);
                const maxS = Math.max(...fil.map(v => v.risk_score)).toFixed(1);
                return [
                  `Vendors in category: ${cnt.toLocaleString()}`,
                  `Score range: ${minS} – ${maxS}`,
                ];
              } else {
                const minD = Math.min(...fil.map(v => v.avg_days_overdue)).toFixed(0);
                const maxD = Math.max(...fil.map(v => v.avg_days_overdue)).toFixed(0);
                return [
                  `Vendors in category: ${cnt.toLocaleString()}`,
                  `Days range: ${minD} – ${maxD} days`,
                ];
              }
            }
          },
          footerColor: "#94a3b8",
          footerFont : { style: "normal", size: 11 },
        }
      },
      scales: {
        x: {
          ticks : { color: "#cbd5e1", font: { size: 13, weight: "600" } },
          grid  : { display: false },
        },
        y: {
          ticks: { color: "#94a3b8", callback: yTickFmt },
          grid : { color: "rgba(255,255,255,0.06)" },
          title: { display: true, text: yLabel, color: "#94a3b8", font: { size: 11 } },
          ...(tab === "score" ? { min: 0, max: 100 } : {}),
        },
      }
    }
  });
}

function _injectInsightCSS() {
  const s = document.createElement("style");
  s.textContent = `
    .insight-tabs {
      display: flex; gap: 6px; flex-wrap: wrap;
    }
    .itab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 14px; border-radius: 20px;
      border: 1.5px solid rgba(148,163,184,0.2);
      background: transparent; color: #64748b;
      font-size: 12px; font-weight: 500; cursor: pointer;
      transition: all .18s;
    }
    .itab:hover { color: #cbd5e1; border-color: rgba(148,163,184,0.4); }
    .itab.active {
      background: rgba(99,102,241,0.15);
      border-color: #6366f1;
      color: #a5b4fc;
    }
  `;
  document.head.appendChild(s);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PREVIEW TABLE  – top 10 by risk_score desc
   ═══════════════════════════════════════════════════════════════════════════ */
function renderPreviewTable(vendors) {
  const top10 = [...vendors]
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 10);

  const tbody = document.getElementById("previewBody");
  if (!tbody) return;
  tbody.innerHTML = top10.map(v => `
    <tr>
      <td class="mono">${v.vendor_id}</td>
      <td>${v.vendor_name}</td>
      <td class="num">${fmtCurrency(v.overdue_amount)}</td>
      <td class="num">
        <div class="score-bar-wrap">
          <div class="score-bar" style="width:${v.risk_score}%;background:${RISK_COLORS[v.predicted_risk]}"></div>
          <span>${v.risk_score.toFixed(1)}</span>
        </div>
      </td>
      <td><span class="badge badge-${v.predicted_risk.toLowerCase()}">${v.predicted_risk}</span></td>
    </tr>`).join("");
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function destroyChart(c) { if (c) c.destroy(); }

function fmtCurrency(n) {
  if (n >= 1e9)  return "₹" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e7)  return "₹" + (n / 1e7).toFixed(2) + "Cr";
  if (n >= 1e5)  return "₹" + (n / 1e5).toFixed(2) + "L";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtCurrencyShort(n) {
  if (n >= 1e9)  return "₹" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e7)  return "₹" + (n / 1e7).toFixed(1) + "Cr";
  if (n >= 1e5)  return "₹" + (n / 1e5).toFixed(1) + "L";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function truncate(str, n) { return str.length > n ? str.slice(0, n) + "…" : str; }

function chartOpts(yLabel, vertical = true) {
  return {
    responsive        : true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: ctx => ` ${ctx.dataset.label}: ${
            yLabel.includes("Score") ? ctx.raw.toFixed(1) : fmtCurrency(ctx.raw)
          }`
        }
      }
    },
    scales: vertical ? {
      x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
      y: {
        ticks: { color: "#94a3b8", callback: v => fmtCurrencyShort(v) },
        grid : { color: "rgba(255,255,255,0.06)" },
        title: { display: true, text: yLabel, color: "#94a3b8" },
      }
    } : {}
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SLICER + EXTRA CSS  (injected once into <head>)
   ═══════════════════════════════════════════════════════════════════════════ */
function injectSlicerCSS() {
  const style = document.createElement("style");
  style.textContent = `
    /* ── New Analysis button ──────────────────────────────────────────────── */
    .btn-new-analysis {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 16px;
      border-radius: 9px;
      border: 1px solid rgba(148,163,184,0.2);
      background: transparent;
      color: #94a3b8;
      font-size: 13px;
      text-decoration: none;
      transition: all .18s;
    }
    .btn-new-analysis:hover {
      background: rgba(99,102,241,0.1);
      color: #a5b4fc;
      border-color: #6366f1;
    }
    /* ── Slicer Bar ───────────────────────────────────────────────────────── */
    .slicer-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 20px;
      background: rgba(30,41,59,0.85);
      border: 1px solid rgba(148,163,184,0.12);
      border-radius: 14px;
      padding: 14px 20px;
      margin-bottom: 20px;
      backdrop-filter: blur(8px);
    }
    .slicer-section {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .slicer-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: #64748b;
      white-space: nowrap;
    }
    .slicer-pills {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .slicer-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 12px;
      border-radius: 20px;
      border: 1.5px solid var(--pill-color, #64748b);
      background: transparent;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all .18s;
      opacity: .45;
    }
    .slicer-pill.active {
      background: color-mix(in srgb, var(--pill-color) 18%, transparent);
      color: #f1f5f9;
      opacity: 1;
    }
    .slicer-pill:hover { opacity: 1; }
    .pill-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    /* ── Range sliders ───────────────────────────────────────────────────── */
    .range-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .range-group input[type=range] {
      -webkit-appearance: none;
      appearance: none;
      width: 140px;
      height: 4px;
      border-radius: 4px;
      background: linear-gradient(to right, #6366f1, #334155);
      outline: none;
      cursor: pointer;
    }
    .range-group input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #6366f1;
      box-shadow: 0 0 6px #6366f180;
      cursor: pointer;
    }
    .range-val {
      font-size: 11px;
      color: #94a3b8;
      white-space: nowrap;
      min-width: 130px;
    }
    /* ── Reset button ─────────────────────────────────────────────────────── */
    .slicer-reset {
      margin-left: auto;
      padding: 5px 14px;
      border-radius: 8px;
      border: 1px solid rgba(148,163,184,0.2);
      background: transparent;
      color: #64748b;
      font-size: 12px;
      cursor: pointer;
      transition: all .18s;
    }
    .slicer-reset:hover {
      background: rgba(99,102,241,0.12);
      color: #a5b4fc;
      border-color: #6366f1;
    }
    /* ── Wide chart wrapper ───────────────────────────────────────────────── */
    .chart-grid-1 { margin-bottom: 20px; }
    .chart-grid-1 .chart-card { width: 100%; }
    .chart-wrap-wide { position: relative; height: 320px; }
    /* ── Score bar in preview table ───────────────────────────────────────── */
    .score-bar-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .score-bar-wrap span { font-size: 12px; color: #cbd5e1; min-width: 36px; }
    .score-bar {
      height: 6px;
      border-radius: 3px;
      max-width: 80px;
      transition: width .4s ease;
    }
  `;
  document.head.appendChild(style);
}