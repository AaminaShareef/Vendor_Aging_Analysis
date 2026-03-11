/* ═══════════════════════════════════════════════════════════════════════════
   SAP VRM — AI Intelligence  (intelligence.js)
   Three features:
     1. Natural Language Query Engine
     2. AI Insight Generator
     3. Vendor Risk Chatbot
   All LLM calls go through Flask /api/claude proxy → OpenRouter.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── data aliases ────────────────────────────────────────────────────────── */
const VENDORS       = RAW_DATA.vendors   || [];
const KPI           = RAW_DATA.kpi       || {};
const AGING_BUCKETS = RAW_DATA.aging_buckets || {};
const RISK_DIST     = RAW_DATA.risk_distribution || {};
const TOP10         = RAW_DATA.top10     || [];

/* ── chat history ────────────────────────────────────────────────────────── */
let chatHistory = [];

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  bootChat();
  wireKeys();
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. NATURAL LANGUAGE QUERY ENGINE
   ═══════════════════════════════════════════════════════════════════════════ */
window.quickQuery = function(el) {
  document.getElementById("nlInput").value = el.textContent.trim();
  runNLQuery();
};

window.runNLQuery = async function() {
  const query = document.getElementById("nlInput").value.trim();
  const btn   = document.getElementById("nlBtn");
  const panel = document.getElementById("nlResult");

  if (!query) return;

  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Querying...`;
  panel.className = "nl-result";
  panel.innerHTML = "";

  try {
    const html = await nlQuery(query);
    panel.innerHTML = html;
    panel.className = "nl-result show";
  } catch (e) {
    panel.innerHTML = `<div class="err-msg"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
    panel.className = "nl-result show";
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-bolt"></i> Query`;
  }
};

async function nlQuery(query) {
  const system = `You are a data analyst for an SAP Vendor Risk Monitoring system.
Answer the user's question using ONLY the vendor data below.

${buildSnapshot(50)}

Rules:
- Respond in clean HTML only — no markdown, no code fences.
- Start with: <div class="nl-result-label">RESULT</div>
- For lists of vendors use: <table class="nl-result-table"><thead>...</thead><tbody>...</tbody></table>
- Currency in Indian format: use Cr for crores, L for lakhs, prefix with rupee symbol.
- Be concise. State how many records match when listing vendors.`;

  return await callAI([{ role: "user", content: query }], system, 600);
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. AI INSIGHT GENERATOR
   ═══════════════════════════════════════════════════════════════════════════ */
window.generateInsights = async function() {
  const btn   = document.getElementById("insightBtn");
  const body  = document.getElementById("insightsBody");
  const empty = document.getElementById("insightsEmpty");

  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Analysing...`;
  if (empty) empty.style.display = "none";

  body.innerHTML = Array(6).fill(`<div class="shimmer"></div>`).join("");

  try {
    body.innerHTML = await buildInsights();
  } catch (e) {
    body.innerHTML = `<div class="err-msg"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-sync-alt"></i> Regenerate`;
  }
};

async function buildInsights() {
  const system = `You are a senior finance risk analyst writing a CFO briefing.
Analyse the vendor risk data below and return EXACTLY 6 insight objects as a JSON array.

${buildSnapshot(30)}

Each object must have exactly these keys:
  "icon"  - one of: fire, exclamation-triangle, chart-line, coins, calendar-alt, users, shield-alt, map-marker-alt
  "color" - one of: red, orange, amber, blue, green, purple
  "text"  - 1 to 2 sentences; wrap key numbers or names in HTML strong tags

Example output:
[{"icon":"fire","color":"red","text":"<strong>8%</strong> of vendors account for <strong>52%</strong> of total overdue."}]

Return ONLY the JSON array. No markdown. No explanation. No code fences.`;

  const raw     = await callAI([{ role: "user", content: "Generate the 6 insights now." }], system, 900);
  const cleaned = raw.replace(/```json|```/gi, "").trim();

  let items;
  try {
    items = JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Could not parse AI response. Please try again.");
    items = JSON.parse(match[0]);
  }

  return items.map((item, i) => `
    <div class="insight-item" style="animation-delay:${i * 0.07}s">
      <div class="insight-icon ${item.color || "blue"}">
        <i class="fas fa-${item.icon || "lightbulb"}"></i>
      </div>
      <div class="insight-text">${item.text}</div>
    </div>`).join("");
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. VENDOR RISK CHATBOT
   ═══════════════════════════════════════════════════════════════════════════ */
function bootChat() {
  const critical = VENDORS.filter(v => v.predicted_risk === "Critical").length;
  const topV     = TOP10[0];
  const totalOD  = fmt(KPI.total_overdue || 0);

  addBot(`Hello! I am your <strong>VendorRisk AI Assistant</strong>.<br><br>
Here is your portfolio snapshot:<br>
&bull; <strong>${KPI.total_vendors || 0}</strong> vendors analysed<br>
&bull; <strong>${totalOD}</strong> total overdue exposure<br>
&bull; <strong>${critical}</strong> vendors flagged <strong>Critical</strong><br>
&bull; Highest risk: <strong>${topV ? topV.vendor_name : "N/A"}</strong> (score ${topV ? topV.risk_score.toFixed(1) : "N/A"})<br><br>
Ask me anything about vendor risk, payment priorities, or aging trends.`);

  showSugs(["Who needs immediate attention?", "Explain the risk scoring", "Which vendors to pay first?", "What is driving our overdue?"]);
}

window.sendChat = async function() {
  const inp  = document.getElementById("chatInp");
  const btn  = document.getElementById("sendBtn");
  const text = inp.value.trim();
  if (!text) return;

  inp.value    = "";
  btn.disabled = true;
  addUser(text);
  clearSugs();
  showTyping();

  chatHistory.push({ role: "user", content: text });
  if (chatHistory.length > 18) chatHistory = chatHistory.slice(-14);

  try {
    const reply = await callAI(chatHistory, chatSystem(), 500);
    removeTyping();
    addBot(reply);
    chatHistory.push({ role: "assistant", content: reply });
    const sugs = followups(text, reply);
    if (sugs.length) showSugs(sugs);
  } catch (e) {
    removeTyping();
    addBot(`Sorry, I hit an error: <strong>${e.message}</strong> — please try again.`);
  } finally {
    btn.disabled = false;
  }
};

function chatSystem() {
  return `You are VendorRisk Assistant, an expert SAP Accounts Payable risk analyst chatbot.

${buildSnapshot(25)}

Rules:
- Reply in HTML only. Use strong tags, br tags, and bullet characters. No markdown, no backticks.
- Keep replies under 160 words unless a detailed list is needed.
- Currency in Indian rupee format.
- Bold vendor names.
- Always give an actionable recommendation when relevant.`;
}

function followups(q, r) {
  const s = (q + r).toLowerCase();
  if (s.includes("critical"))                      return ["Show critical vendor details", "How to reduce critical risk?"];
  if (s.includes("pay") || s.includes("priorit"))  return ["Top vendor overdue totals", "Show aging breakdown"];
  if (s.includes("score") || s.includes("risk"))   return ["What makes a vendor high risk?", "How is risk calculated?"];
  if (s.includes("aging") || s.includes("overdue")) return ["Vendors 120+ days overdue", "Overdue by risk level"];
  return [];
}

/* ── chat DOM helpers ──────────────────────────────────────────────────────── */
function addBot(html)  { addMsg("bot",  `<i class="fas fa-robot"></i>`, html); }
function addUser(text) { addMsg("user", `<i class="fas fa-user"></i>`,  esc(text)); }

function addMsg(role, av, body) {
  const c = document.getElementById("chatMsgs");
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  d.innerHTML = `<div class="msg-av">${av}</div><div class="msg-bub">${body}</div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

function showTyping() {
  const c = document.getElementById("chatMsgs");
  const d = document.createElement("div");
  d.className = "msg bot";
  d.id        = "typingDot";
  d.innerHTML = `<div class="msg-av"><i class="fas fa-robot"></i></div>
    <div class="msg-bub"><div class="typing-ind">
      <div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div>
    </div></div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}
function removeTyping() { document.getElementById("typingDot")?.remove(); }

function showSugs(list) {
  document.getElementById("chatSuggest").innerHTML =
    list.map(s => `<button class="sug-btn" onclick="useSug(this)">${esc(s)}</button>`).join("");
}
function clearSugs() { document.getElementById("chatSuggest").innerHTML = ""; }
window.useSug = function(el) {
  document.getElementById("chatInp").value = el.textContent;
  sendChat();
};

function wireKeys() {
  document.getElementById("chatInp").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.getElementById("nlInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); runNLQuery(); }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FLASK PROXY CALL  →  /api/claude  →  OpenRouter
   ═══════════════════════════════════════════════════════════════════════════ */
async function callAI(messages, systemPrompt, maxTokens) {
  maxTokens = maxTokens || 700;

  const res = await fetch("/api/claude", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:      "arcee-ai/trinity-large-preview:free",
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   messages,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || ("Server error " + res.status);
    throw new Error(msg);
  }

  const text = (data.content || [])
    .filter(function(b) { return b.type === "text"; })
    .map(function(b) { return b.text; })
    .join("");

  if (!text) throw new Error("Empty response from AI. Please try again.");
  return text;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATA SNAPSHOT  (capped to avoid token overflow)
   ═══════════════════════════════════════════════════════════════════════════ */
function buildSnapshot(maxVendors) {
  maxVendors = maxVendors || 40;

  const aging = Object.entries(AGING_BUCKETS)
    .map(function(e) { return "  " + e[0] + " days: " + fmt(e[1]); }).join("\n");

  const dist = Object.entries(RISK_DIST)
    .map(function(e) { return "  " + e[0] + ": " + e[1] + " vendors"; }).join("\n");

  const top = TOP10.slice(0, 10).map(function(v, i) {
    return "  " + (i+1) + ". " + v.vendor_name + " (" + v.vendor_id + ")"
      + " | Score:" + v.risk_score.toFixed(1)
      + " | Overdue:" + fmt(v.overdue_amount)
      + " | " + v.predicted_risk;
  }).join("\n");

  const rows = VENDORS.slice(0, maxVendors).map(function(v) {
    return v.vendor_id + "|" + v.vendor_name + "|" + v.predicted_risk
      + "|" + v.risk_score.toFixed(1)
      + "|" + v.overdue_amount.toFixed(0)
      + "|" + v.avg_days_overdue.toFixed(0)
      + "|" + v.max_days_overdue
      + "|" + v.total_invoices;
  }).join("\n");

  const note = VENDORS.length > maxVendors
    ? "\n(Showing " + maxVendors + " of " + VENDORS.length + " vendors sorted by risk score)"
    : "";

  return "=== KPIs ===\n"
    + "Total vendors : " + (KPI.total_vendors || 0) + "\n"
    + "Overdue total : " + fmt(KPI.total_overdue || 0) + "\n"
    + "High risk     : " + (KPI.high_risk || 0) + "\n"
    + "Critical      : " + (KPI.critical  || 0) + "\n\n"
    + "=== Aging Buckets ===\n" + aging + "\n\n"
    + "=== Risk Distribution ===\n" + dist + "\n\n"
    + "=== Top 10 Riskiest Vendors ===\n" + top + "\n\n"
    + "=== Vendor Table (id|name|risk_level|score|overdue_amt|avg_days_OD|max_days_OD|invoices) ===" + note + "\n"
    + rows;
}

/* ── formatters ─────────────────────────────────────────────────────────── */
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return "\u20B9" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e7) return "\u20B9" + (n / 1e7).toFixed(2) + "Cr";
  if (n >= 1e5) return "\u20B9" + (n / 1e5).toFixed(2) + "L";
  return "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}