"use strict";

/* ─── data & state ─────────────────────────────────────────────────────────── */
const ALL_VENDORS  = RAW_DATA.vendors;
const RISK_COLORS  = { Critical:"#ef4444", High:"#f97316", Medium:"#eab308", Low:"#22c55e" };

let filtered    = [...ALL_VENDORS];
let sortCol     = "risk_score";
let sortDir     = -1;          // -1 = desc, 1 = asc
let currentPage = 1;
const PAGE_SIZE  = 25;
let activeFilter = "all";

/* ─── init ─────────────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  showSessionBanner();
  applyFilterAndRender();
  wireSearch();
  wireFilterPills();
  wireSortHeaders();
  wirePagination();
});

/* ═══════════════════════════════════════════════════════════════════════════
   SESSION BANNER  – reads ?msg= query param set by Flask redirect
   ═══════════════════════════════════════════════════════════════════════════ */
function showSessionBanner() {
  const params = new URLSearchParams(window.location.search);
  const msg    = params.get("msg");
  const banner = document.getElementById("sessionBanner");
  const text   = document.getElementById("sessionBannerMsg");
  if (!banner || !msg) return;

  const messages = {
    expired    : "Your previous analysis session has expired (results are kept for 24 hours). Please upload your files again.",
    no_session : "No active analysis session found. Please upload your SAP files to begin.",
  };
  if (messages[msg]) {
    text.textContent = messages[msg];
    banner.style.display = "flex";
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILTER + SORT + RENDER
   ═══════════════════════════════════════════════════════════════════════════ */
function applyFilterAndRender() {
  const query = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();

  filtered = ALL_VENDORS.filter(v => {
    const matchRisk = activeFilter === "all" || v.predicted_risk === activeFilter;
    const matchSearch = !query ||
      v.vendor_id.toLowerCase().includes(query)   ||
      v.vendor_name.toLowerCase().includes(query) ||
      v.predicted_risk.toLowerCase().includes(query);
    return matchRisk && matchSearch;
  });

  filtered.sort((a, b) => {
    const av = a[sortCol] ?? "";
    const bv = b[sortCol] ?? "";
    if (typeof av === "number") return sortDir * (av - bv);
    return sortDir * String(av).localeCompare(String(bv));
  });

  currentPage = 1;
  renderTable();
  renderPagination();
  updateRecordCount();
}

function renderTable() {
  const tbody  = document.getElementById("vendorBody");
  const start  = (currentPage - 1) * PAGE_SIZE;
  const page   = filtered.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = page.map(v => {
    const pct  = v.pct_critical_invoices != null
      ? (v.pct_critical_invoices * 100).toFixed(1) + "%"
      : "—";
    const conc = v.amount_concentration != null
      ? v.amount_concentration.toFixed(3)
      : "—";

    return `
    <tr>
      <td class="mono">${v.vendor_id}</td>
      <td>${v.vendor_name}</td>
      <td class="num">${fmtInt(v.total_invoices)}</td>
      <td class="num">${fmtCurrency(v.overdue_amount)}</td>
      <td class="num">${fmtInt(v.max_days_overdue)}</td>
      <td class="num">${fmtInt(v.avg_days_overdue)}</td>
      <td class="num">
        <div class="score-cell">
          <div class="score-bar" style="width:${v.risk_score}%;background:${RISK_COLORS[v.predicted_risk]}"></div>
          <span>${v.risk_score.toFixed(1)}</span>
        </div>
      </td>
      <td><span class="badge badge-${v.predicted_risk.toLowerCase()}">${v.predicted_risk}</span></td>
    </tr>`;
  }).join("");
}

function updateRecordCount() {
  const el = document.getElementById("recordCount");
  if (el) el.textContent = `Showing ${filtered.length.toLocaleString()} of ${ALL_VENDORS.length.toLocaleString()} vendors`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAGINATION
   ═══════════════════════════════════════════════════════════════════════════ */
function renderPagination() {
  const total  = Math.ceil(filtered.length / PAGE_SIZE);
  const nums   = document.getElementById("pageNumbers");
  const info   = document.getElementById("pgInfo");
  const prev   = document.getElementById("prevBtn");
  const next   = document.getElementById("nextBtn");

  prev.disabled = currentPage === 1;
  next.disabled = currentPage === total;

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end   = Math.min(currentPage * PAGE_SIZE, filtered.length);
  if (info) info.textContent = `${start}–${end} of ${filtered.length}`;

  /* show at most 7 page buttons */
  nums.innerHTML = "";
  const pages = pageRange(currentPage, total);
  pages.forEach(p => {
    if (p === "…") {
      const span = document.createElement("span");
      span.className = "pg-ellipsis";
      span.textContent = "…";
      nums.appendChild(span);
    } else {
      const btn = document.createElement("button");
      btn.className = "pg-btn" + (p === currentPage ? " active" : "");
      btn.textContent = p;
      btn.onclick = () => { currentPage = p; renderTable(); renderPagination(); };
      nums.appendChild(btn);
    }
  });
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "…", total];
  if (current >= total - 3) return [1, "…", total-4, total-3, total-2, total-1, total];
  return [1, "…", current-1, current, current+1, "…", total];
}

function wirePagination() {
  document.getElementById("prevBtn").onclick = () => {
    if (currentPage > 1) { currentPage--; renderTable(); renderPagination(); }
  };
  document.getElementById("nextBtn").onclick = () => {
    const total = Math.ceil(filtered.length / PAGE_SIZE);
    if (currentPage < total) { currentPage++; renderTable(); renderPagination(); }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════════════════ */
function wireSearch() {
  const input = document.getElementById("searchInput");
  if (!input) return;
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(applyFilterAndRender, 180);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILTER PILLS
   ═══════════════════════════════════════════════════════════════════════════ */
function wireFilterPills() {
  document.querySelectorAll("#filterPills .pill").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#filterPills .pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      applyFilterAndRender();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SORT HEADERS
   ═══════════════════════════════════════════════════════════════════════════ */
function wireSortHeaders() {
  document.querySelectorAll("th.sortable").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir *= -1;
      } else {
        sortCol = col;
        sortDir = -1;
      }
      /* update icons */
      document.querySelectorAll("th.sortable i").forEach(i => {
        i.className = "fas fa-sort";
      });
      th.querySelector("i").className = sortDir === -1 ? "fas fa-sort-down" : "fas fa-sort-up";
      applyFilterAndRender();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSV EXPORT  –  exportCSV('all' | 'Critical' | 'High' | 'Medium' | 'Low')
   Exports the currently-filtered & sorted view, optionally further filtered
   to a single risk category.
   ═══════════════════════════════════════════════════════════════════════════ */
window.exportCSV = function(category) {
  const rows = category === "all"
    ? filtered
    : filtered.filter(v => v.predicted_risk === category);

  if (!rows.length) {
    alert(`No ${category === "all" ? "" : category + " "}vendors to export.`);
    return;
  }

  const HEADERS = [
    "Vendor ID", "Vendor Name", "Total Invoices", "Overdue Amount",
    "Max Days Overdue", "Avg Days Overdue",
    "Risk Score", "Risk Level",
  ];

  const csvLines = [
    HEADERS.join(","),
    ...rows.map(v => [
      csvEscape(v.vendor_id),
      csvEscape(v.vendor_name),
      v.total_invoices,
      v.overdue_amount.toFixed(2),
      v.max_days_overdue.toFixed(0),
      v.avg_days_overdue.toFixed(1),
      v.risk_score.toFixed(2),
      csvEscape(v.predicted_risk),
    ].join(","))
  ];

  const blob     = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url      = URL.createObjectURL(blob);
  const link     = document.createElement("a");
  const label    = category === "all" ? "All_Vendors" : `${category}_Vendors`;
  const dateStr  = new Date().toISOString().slice(0,10).replace(/-/g,"");
  link.href      = url;
  link.download  = `SAP_VRM_${label}_${dateStr}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

function csvEscape(val) {
  const s = String(val ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function fmtCurrency(n) {
  if (n >= 1e9) return "₹" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e7) return "₹" + (n / 1e7).toFixed(2) + "Cr";
  if (n >= 1e5) return "₹" + (n / 1e5).toFixed(2) + "L";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtInt(n) {
  return n != null ? Math.round(n).toLocaleString() : "—";
}

function pctColor(p) {
  if (p >= 0.75) return "#ef4444";
  if (p >= 0.5)  return "#f97316";
  if (p >= 0.25) return "#eab308";
  return "#22c55e";
}

/* inject extra CSS for new columns */
(function injectVendorCSS() {
  const style = document.createElement("style");
  style.textContent = `
    /* ── table column widths ─────────────────────────────────────────────── */
    #vendorTable th:nth-child(1),
    #vendorTable td:nth-child(1) { width: 100px; min-width: 90px; }   /* Vendor ID   */
    #vendorTable th:nth-child(2),
    #vendorTable td:nth-child(2) { width: 200px; min-width: 140px; }  /* Vendor Name */
    #vendorTable th:nth-child(3),
    #vendorTable td:nth-child(3) { width: 80px; }                      /* Invoices    */
    #vendorTable th:nth-child(4),
    #vendorTable td:nth-child(4) { width: 140px; }                     /* Overdue Amt */
    #vendorTable th:nth-child(5),
    #vendorTable td:nth-child(5) { width: 110px; }                     /* Max Days OD */
    #vendorTable th:nth-child(6),
    #vendorTable td:nth-child(6) { width: 110px; }                     /* Avg Days OD */
    #vendorTable th:nth-child(7),
    #vendorTable td:nth-child(7) { width: 160px; }                     /* Risk Score  */
    #vendorTable th:nth-child(8),
    #vendorTable td:nth-child(8) { width: 110px; }                     /* Risk Level  */

    /* ── risk score cell: thin bar + number side by side ────────────────── */
    .score-cell {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .score-cell .score-bar {
      height: 5px;
      border-radius: 3px;
      flex: 0 0 60px;
      max-width: 60px;
    }
    .score-cell span {
      font-size: 12px;
      color: #cbd5e1;
      white-space: nowrap;
    }

    /* ── pagination ellipsis ─────────────────────────────────────────────── */
    .pg-ellipsis {
      padding: 0 4px; color: #64748b; font-size: 13px; line-height: 30px;
    }
  `;
  document.head.appendChild(style);
})();