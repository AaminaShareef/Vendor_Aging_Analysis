import os
import pandas as pd
import numpy as np
from datetime import datetime
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from scipy.spatial.distance import cdist
import warnings
warnings.filterwarnings("ignore")


# ═══════════════════════════════════════════════════════════════════════════════
# PUBLIC ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def run_vendor_risk_analysis(bsik_path: str, lfa1_path: str, lfb1_path: str) -> dict:
    """Full pipeline: load → engineer features → cluster → score → output."""

    # 1. Load
    bsik = _load_bsik(bsik_path)
    lfa1 = _load_lfa1(lfa1_path)
    lfb1 = _load_lfb1(lfb1_path)

    # 2. Determine aging reference date:
    #    Priority: AGING_REFERENCE_DATE env var → max date in dataset → today
    bsik, aging_ref = _resolve_aging_reference(bsik)

    # 3. Aging buckets on raw transactions
    bsik = _compute_aging(bsik, aging_ref)

    # 4. Vendor-level feature engineering
    vendor_df = _engineer_features(bsik, aging_ref)

    # 5. Merge vendor master data
    vendor_df = _merge_master(vendor_df, lfa1, lfb1)

    # 6. Pure K-Means: cluster + derive risk score from centroid geometry
    vendor_df, scaler, centroids = _kmeans_cluster_and_score(vendor_df)

    # 7. Build structured result payload
    return _build_result(vendor_df, bsik)


# ═══════════════════════════════════════════════════════════════════════════════
# AGING REFERENCE DATE RESOLUTION
# ═══════════════════════════════════════════════════════════════════════════════

def _resolve_aging_reference(bsik: pd.DataFrame):
    """
    Determine the best reference date for aging calculations.

    Priority order:
      1. AGING_REFERENCE_DATE env var (YYYY-MM-DD) — explicit override
      2. Max date found in ZFBDT / BLDAT columns of the dataset
         (anchors aging to the data's own time horizon, not today)
      3. datetime.today() — fallback if no dates exist in data

    Using the dataset's max date prevents all invoices from being pushed
    into the 120+ bucket when AP data is historically old.
    """
    # Check env var first
    _ref_env = os.environ.get("AGING_REFERENCE_DATE", "").strip()
    if _ref_env:
        try:
            return bsik, datetime.strptime(_ref_env, "%Y-%m-%d")
        except ValueError:
            pass  # fall through to auto-detect

    # Auto-detect from data: use the latest date present in the dataset
    date_col = "ZFBDT" if "ZFBDT" in bsik.columns else "BLDAT" if "BLDAT" in bsik.columns else None
    if date_col:
        max_date = bsik[date_col].dropna().max()
        if pd.notna(max_date):
            # Convert to pandas Timestamp, then find end-of-that-month
            ts = pd.Timestamp(max_date)
            # First day of next month, minus one day = last day of current month
            if ts.month < 12:
                end_of_month = pd.Timestamp(year=ts.year, month=ts.month + 1, day=1) - pd.Timedelta(days=1)
            else:
                end_of_month = pd.Timestamp(year=ts.year + 1, month=1, day=1) - pd.Timedelta(days=1)
            ref = end_of_month.to_pydatetime()
            return bsik, ref

    return bsik, datetime.today()


# ═══════════════════════════════════════════════════════════════════════════════
# DATA LOADERS
# ═══════════════════════════════════════════════════════════════════════════════

def _load_bsik(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, low_memory=False)
    df.columns = [c.strip().upper() for c in df.columns]

    col_map = {
        "LIFNR": ["LIFNR", "VENDOR", "VENDOR_ID"],
        "BLDAT": ["BLDAT", "DOCUMENT_DATE", "POSTING_DATE"],
        "DMBTR": ["DMBTR", "AMOUNT", "WRBTR"],
        "ZFBDT": ["ZFBDT", "DUE_DATE", "BASELINE_DATE"],
    }
    df = _remap_columns(df, col_map)

    for col in ["BLDAT", "ZFBDT"]:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")

    df["DMBTR"] = pd.to_numeric(df["DMBTR"], errors="coerce").fillna(0).abs()
    return df


def _load_lfa1(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, low_memory=False)
    df.columns = [c.strip().upper() for c in df.columns]
    col_map = {
        "LIFNR": ["LIFNR", "VENDOR"],
        "NAME1":  ["NAME1", "VENDOR_NAME"],
        "LAND1":  ["LAND1", "COUNTRY"],
        "ORT01":  ["ORT01", "CITY"],
    }
    return _remap_columns(df, col_map)


def _load_lfb1(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, low_memory=False)
    df.columns = [c.strip().upper() for c in df.columns]
    col_map = {
        "LIFNR": ["LIFNR", "VENDOR"],
        "BUKRS": ["BUKRS", "COMPANY_CODE"],
        "ZTERM": ["ZTERM", "PAYMENT_TERMS"],
    }
    return _remap_columns(df, col_map)


def _remap_columns(df: pd.DataFrame, col_map: dict) -> pd.DataFrame:
    rename = {}
    for canonical, aliases in col_map.items():
        if canonical in df.columns:
            continue
        for alias in aliases:
            if alias in df.columns:
                rename[alias] = canonical
                break
    return df.rename(columns=rename)


# ═══════════════════════════════════════════════════════════════════════════════
# AGING ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

def _compute_aging(df: pd.DataFrame, aging_ref: datetime) -> pd.DataFrame:
    date_col = "ZFBDT" if "ZFBDT" in df.columns else "BLDAT"
    df["DAYS_OVERDUE"] = (aging_ref - df[date_col]).dt.days.clip(lower=0)
    bins   = [-1, 30, 60, 90, 120, float("inf")]
    labels = ["0-30", "31-60", "61-90", "91-120", "120+"]
    df["AGING_BUCKET"] = pd.cut(df["DAYS_OVERDUE"], bins=bins, labels=labels)
    return df


# ═══════════════════════════════════════════════════════════════════════════════
# FEATURE ENGINEERING
# ═══════════════════════════════════════════════════════════════════════════════

def _engineer_features(df: pd.DataFrame, aging_ref: datetime) -> pd.DataFrame:
    """
    Build a rich, multi-dimensional feature set per vendor from raw AP lines.

    Features are chosen to be complementary so K-Means can discover meaningful
    risk clusters without any hard-coded scoring weights:

      TOTAL_OVERDUE_AMOUNT   – absolute financial exposure
      TOTAL_INVOICES         – transaction volume
      MAX_DAYS_OVERDUE       – worst single payment breach
      AVG_DAYS_OVERDUE       – chronic lateness pattern
      PCT_CRITICAL_INVOICES  – share of invoices overdue 90+ days
      AMOUNT_CONCENTRATION   – Herfindahl-style: one huge invoice = riskier
      RECENCY_DAYS           – age of the oldest outstanding item
    """
    agg = df.groupby("LIFNR").apply(_vendor_feature_row, aging_ref=aging_ref).reset_index()
    return agg


def _vendor_feature_row(grp: pd.DataFrame, aging_ref) -> pd.Series:
    amounts   = grp["DMBTR"]
    days      = grp["DAYS_OVERDUE"]
    total_amt = amounts.sum()
    n         = len(grp)

    pct_critical = (days >= 90).sum() / max(n, 1)

    shares        = (amounts / total_amt) if total_amt > 0 else (amounts * 0)
    concentration = float((shares ** 2).sum())

    date_col    = "ZFBDT" if "ZFBDT" in grp.columns else "BLDAT"
    valid_dates = grp[date_col].dropna()
    recency     = float((aging_ref - valid_dates.min()).days) if len(valid_dates) else 0.0

    return pd.Series({
        "TOTAL_OVERDUE_AMOUNT":  round(float(total_amt), 2),
        "TOTAL_INVOICES":        int(n),
        "MAX_DAYS_OVERDUE":      float(days.max()),
        "AVG_DAYS_OVERDUE":      round(float(days.mean()), 2),
        "PCT_CRITICAL_INVOICES": round(float(pct_critical), 4),
        "AMOUNT_CONCENTRATION":  round(float(concentration), 4),
        "RECENCY_DAYS":          float(recency),
    })


# ═══════════════════════════════════════════════════════════════════════════════
# MERGE VENDOR MASTER
# ═══════════════════════════════════════════════════════════════════════════════

def _merge_master(agg: pd.DataFrame, lfa1: pd.DataFrame, lfb1: pd.DataFrame) -> pd.DataFrame:
    lfa1_cols = ["LIFNR"] + [c for c in ["NAME1", "LAND1", "ORT01"] if c in lfa1.columns]
    lfb1_cols = ["LIFNR"] + [c for c in ["BUKRS", "ZTERM"]          if c in lfb1.columns]

    df = agg.merge(lfa1[lfa1_cols].drop_duplicates("LIFNR"), on="LIFNR", how="left")
    df = df.merge(lfb1[lfb1_cols].drop_duplicates("LIFNR"), on="LIFNR", how="left")
    df["NAME1"] = df["NAME1"].fillna("Unknown Vendor")
    return df


# ═══════════════════════════════════════════════════════════════════════════════
# PURE K-MEANS: CLUSTER + SCORE
# ═══════════════════════════════════════════════════════════════════════════════

_CLUSTER_FEATURES = [
    "TOTAL_OVERDUE_AMOUNT",
    "TOTAL_INVOICES",
    "MAX_DAYS_OVERDUE",
    "AVG_DAYS_OVERDUE",
    "PCT_CRITICAL_INVOICES",
    "AMOUNT_CONCENTRATION",
    "RECENCY_DAYS",
]

_RISK_LABELS = ["Low", "Medium", "High", "Critical"]


def _kmeans_cluster_and_score(df: pd.DataFrame):
    X_raw    = df[_CLUSTER_FEATURES].fillna(0)
    scaler   = StandardScaler()
    X_scaled = scaler.fit_transform(X_raw)

    kmeans = KMeans(n_clusters=4, random_state=42, n_init=15, max_iter=500)
    labels = kmeans.fit_predict(X_scaled)
    df["CLUSTER"] = labels

    centroids = kmeans.cluster_centers_

    direction_weights = np.array([
        0.30,   # TOTAL_OVERDUE_AMOUNT
        0.10,   # TOTAL_INVOICES
        0.25,   # MAX_DAYS_OVERDUE
        0.20,   # AVG_DAYS_OVERDUE
        0.10,   # PCT_CRITICAL_INVOICES
        0.03,   # AMOUNT_CONCENTRATION
        0.02,   # RECENCY_DAYS
    ])

    centroid_danger = centroids @ direction_weights
    cluster_rank    = np.argsort(np.argsort(centroid_danger))

    risk_label_map       = {c: _RISK_LABELS[cluster_rank[c]] for c in range(4)}
    df["PREDICTED_RISK"] = df["CLUSTER"].map(risk_label_map)

    distances  = cdist(X_scaled, centroids, metric="euclidean")
    vendor_idx = np.arange(len(df))

    band_size  = 25.0
    band_floor = cluster_rank[df["CLUSTER"].values] * band_size

    own_dist   = distances[vendor_idx, df["CLUSTER"].values]
    max_dist   = distances.max(axis=1).clip(min=1e-9)
    within_pos = (own_dist / max_dist) * band_size

    df["RISK_SCORE"] = np.clip(band_floor + within_pos, 0, 100).round(2)

    return df, scaler, centroids


# ═══════════════════════════════════════════════════════════════════════════════
# RESULT OUTPUT
# ═══════════════════════════════════════════════════════════════════════════════

def _build_result(vendor_df: pd.DataFrame, bsik: pd.DataFrame) -> dict:

    total_vendors = len(vendor_df)
    total_overdue = float(vendor_df["TOTAL_OVERDUE_AMOUNT"].sum())
    high_risk     = int((vendor_df["PREDICTED_RISK"] == "High").sum())
    critical      = int((vendor_df["PREDICTED_RISK"] == "Critical").sum())

    aging = bsik.groupby("AGING_BUCKET", observed=True)["DMBTR"].sum().to_dict()
    for b in ["0-30", "31-60", "61-90", "91-120", "120+"]:
        aging.setdefault(b, 0)

    risk_dist = vendor_df["PREDICTED_RISK"].value_counts().to_dict()
    for r in _RISK_LABELS:
        risk_dist.setdefault(r, 0)

    _rename = {
        "LIFNR":                "vendor_id",
        "NAME1":                "vendor_name",
        "TOTAL_OVERDUE_AMOUNT": "overdue_amount",
        "TOTAL_INVOICES":       "total_invoices",
        "MAX_DAYS_OVERDUE":     "max_days_overdue",
        "AVG_DAYS_OVERDUE":     "avg_days_overdue",
        "PCT_CRITICAL_INVOICES":"pct_critical_invoices",
        "AMOUNT_CONCENTRATION": "amount_concentration",
        "RISK_SCORE":           "risk_score",
        "PREDICTED_RISK":       "predicted_risk",
    }

    top10_cols = ["LIFNR", "NAME1", "TOTAL_OVERDUE_AMOUNT", "RISK_SCORE", "PREDICTED_RISK"]
    top10 = (
        vendor_df.nlargest(10, "RISK_SCORE")[top10_cols]
        .rename(columns=_rename)
        .to_dict(orient="records")
    )

    scatter_cols = ["LIFNR", "NAME1", "TOTAL_OVERDUE_AMOUNT", "RISK_SCORE", "PREDICTED_RISK"]
    scatter = (
        vendor_df[scatter_cols]
        .rename(columns=_rename)
        .to_dict(orient="records")
    )

    table_cols = [
        "LIFNR", "NAME1",
        "TOTAL_OVERDUE_AMOUNT", "TOTAL_INVOICES",
        "MAX_DAYS_OVERDUE", "AVG_DAYS_OVERDUE",
        "PCT_CRITICAL_INVOICES", "AMOUNT_CONCENTRATION",
        "RISK_SCORE", "PREDICTED_RISK",
    ]
    vendors = (
        vendor_df[table_cols]
        .rename(columns=_rename)
        .sort_values("risk_score", ascending=False)
        .to_dict(orient="records")
    )

    # ── AI context: richer data for the intelligence features ──────────────
    # Country breakdown (from LFA1 LAND1 column if present)
    country_dist = {}
    if "LAND1" in vendor_df.columns:
        country_dist = (
            vendor_df.groupby("LAND1")["TOTAL_OVERDUE_AMOUNT"]
            .sum()
            .sort_values(ascending=False)
            .head(10)
            .round(2)
            .to_dict()
        )

    # Payment terms breakdown (from LFB1 ZTERM column if present)
    zterm_dist = {}
    if "ZTERM" in vendor_df.columns:
        zterm_dist = (
            vendor_df["ZTERM"]
            .fillna("Unknown")
            .value_counts()
            .head(10)
            .to_dict()
        )

    # Company code breakdown
    bukrs_dist = {}
    if "BUKRS" in vendor_df.columns:
        bukrs_dist = (
            vendor_df.groupby("BUKRS")["TOTAL_OVERDUE_AMOUNT"]
            .sum()
            .sort_values(ascending=False)
            .round(2)
            .to_dict()
        )

    # Invoice-level aging sample: top 50 most overdue invoices (raw transactions)
    invoice_sample_cols = ["LIFNR", "DMBTR", "DAYS_OVERDUE", "AGING_BUCKET"]
    if "BLDAT" in bsik.columns:
        invoice_sample_cols.append("BLDAT")
    if "ZFBDT" in bsik.columns:
        invoice_sample_cols.append("ZFBDT")
    invoice_sample = (
        bsik[invoice_sample_cols]
        .nlargest(50, "DAYS_OVERDUE")
        .rename(columns={
            "LIFNR": "vendor_id",
            "DMBTR": "amount",
            "DAYS_OVERDUE": "days_overdue",
            "AGING_BUCKET": "aging_bucket",
            "BLDAT": "doc_date",
            "ZFBDT": "due_date",
        })
        .to_dict(orient="records")
    )
    # Stringify dates so they are JSON-serialisable
    for row in invoice_sample:
        for k in ("doc_date", "due_date"):
            if k in row and hasattr(row[k], "strftime"):
                row[k] = row[k].strftime("%Y-%m-%d")

    # Full vendor list for AI (all vendors, slim columns)
    all_vendors_ai_cols = [
        "LIFNR", "NAME1",
        "TOTAL_OVERDUE_AMOUNT", "TOTAL_INVOICES",
        "MAX_DAYS_OVERDUE", "AVG_DAYS_OVERDUE",
        "PCT_CRITICAL_INVOICES",
        "RISK_SCORE", "PREDICTED_RISK",
    ]
    # Optionally include country/payment-terms if available
    for extra in ("LAND1", "ZTERM", "BUKRS", "ORT01"):
        if extra in vendor_df.columns:
            all_vendors_ai_cols.append(extra)

    all_vendors_ai = (
        vendor_df[all_vendors_ai_cols]
        .rename(columns=_rename)
        .sort_values("risk_score", ascending=False)
        .to_dict(orient="records")
    )

    # Aggregate per-bucket totals (already in `aging`, just formatted)
    aging_amounts = {k: round(float(v), 2) for k, v in aging.items()}

    # Per-risk-level overdue totals
    risk_overdue = (
        vendor_df.groupby("PREDICTED_RISK")["TOTAL_OVERDUE_AMOUNT"]
        .sum()
        .round(2)
        .to_dict()
    )

    ai_context = {
        "total_invoices_processed": int(len(bsik)),
        "aging_amounts":            aging_amounts,
        "risk_overdue_totals":      risk_overdue,
        "country_distribution":     country_dist,
        "payment_terms_distribution": zterm_dist,
        "company_code_distribution":  bukrs_dist,
        "top50_most_overdue_invoices": invoice_sample,
        "all_vendors":              all_vendors_ai,
    }

    return {
        "kpi": {
            "total_vendors": total_vendors,
            "total_overdue": round(total_overdue, 2),
            "high_risk":     high_risk,
            "critical":      critical,
        },
        "aging_buckets":     aging,
        "risk_distribution": risk_dist,
        "top10":             top10,
        "scatter":           scatter,
        "vendors":           vendors,
        "ai_context":        ai_context,
    }