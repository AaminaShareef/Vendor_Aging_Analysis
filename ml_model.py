

import os
import pandas as pd
import numpy as np
from datetime import datetime
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from scipy.spatial.distance import cdist
import warnings
warnings.filterwarnings("ignore")

# ── Aging reference date ───────────────────────────────────────────────────────
# Set AGING_REFERENCE_DATE env var (YYYY-MM-DD) to anchor aging calculations to
# a specific date instead of today.  Useful when AP data is historically old and
# all invoices would otherwise fall into the 120+ bucket.
# Example (Heroku): heroku config:set AGING_REFERENCE_DATE=2023-02-25
_ref_env = os.environ.get("AGING_REFERENCE_DATE", "").strip()
try:
    AGING_REFERENCE_DATE = datetime.strptime(_ref_env, "%Y-%m-%d") if _ref_env else datetime.today()
except ValueError:
    AGING_REFERENCE_DATE = datetime.today()


# ═══════════════════════════════════════════════════════════════════════════════
# PUBLIC ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def run_vendor_risk_analysis(bsik_path: str, lfa1_path: str, lfb1_path: str) -> dict:
    """Full pipeline: load → engineer features → cluster → score → output."""

    # 1. Load
    bsik = _load_bsik(bsik_path)
    lfa1 = _load_lfa1(lfa1_path)
    lfb1 = _load_lfb1(lfb1_path)

    # 2. Aging buckets on raw transactions
    bsik = _compute_aging(bsik)

    # 3. Vendor-level feature engineering
    vendor_df = _engineer_features(bsik)

    # 4. Merge vendor master data
    vendor_df = _merge_master(vendor_df, lfa1, lfb1)

    # 5. Pure K-Means: cluster + derive risk score from centroid geometry
    vendor_df, scaler, centroids = _kmeans_cluster_and_score(vendor_df)

    # 6. Build structured result payload
    return _build_result(vendor_df, bsik)


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

def _compute_aging(df: pd.DataFrame) -> pd.DataFrame:
    today = AGING_REFERENCE_DATE
    date_col = "ZFBDT" if "ZFBDT" in df.columns else "BLDAT"
    df["DAYS_OVERDUE"] = (today - df[date_col]).dt.days.clip(lower=0)
    bins   = [-1, 30, 60, 90, 120, float("inf")]
    labels = ["0-30", "31-60", "61-90", "91-120", "120+"]
    df["AGING_BUCKET"] = pd.cut(df["DAYS_OVERDUE"], bins=bins, labels=labels)
    return df


# ═══════════════════════════════════════════════════════════════════════════════
# FEATURE ENGINEERING
# ═══════════════════════════════════════════════════════════════════════════════

def _engineer_features(df: pd.DataFrame) -> pd.DataFrame:
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
    today = AGING_REFERENCE_DATE
    agg = df.groupby("LIFNR").apply(_vendor_feature_row, today=today).reset_index()
    return agg


def _vendor_feature_row(grp: pd.DataFrame, today) -> pd.Series:
    amounts   = grp["DMBTR"]
    days      = grp["DAYS_OVERDUE"]
    total_amt = amounts.sum()
    n         = len(grp)

    # Proportion of invoices critically overdue (90+ days)
    pct_critical = (days >= 90).sum() / max(n, 1)

    # Invoice amount concentration (HHI-style)
    shares        = (amounts / total_amt) if total_amt > 0 else (amounts * 0)
    concentration = float((shares ** 2).sum())

    # Days since the oldest outstanding document
    date_col    = "ZFBDT" if "ZFBDT" in grp.columns else "BLDAT"
    valid_dates = grp[date_col].dropna()
    recency     = float((today - valid_dates.min()).days) if len(valid_dates) else 0.0

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
    """
    Cluster vendors and derive a continuous RISK_SCORE purely from K-Means geometry.

    Steps:
      1. Fit K-Means (k=4) on scaled features.
      2. Rank clusters by their centroid's composite danger score
         (direction-only weights — K-Means owns the actual grouping).
      3. Assign PREDICTED_RISK label from cluster rank.
      4. Derive RISK_SCORE (0–100) via centroid-distance interpolation:
           • Each cluster occupies a 25-point band (Low=0-25, Medium=25-50, …)
           • Within the band, score is proportional to how far the vendor sits
             from its own centroid toward the riskier end of the space.
         Result: continuous score, not a step function — two vendors in the same
         cluster will still have meaningfully different scores.
    """
    X_raw    = df[_CLUSTER_FEATURES].fillna(0)
    scaler   = StandardScaler()
    X_scaled = scaler.fit_transform(X_raw)

    kmeans = KMeans(n_clusters=4, random_state=42, n_init=15, max_iter=500)
    labels = kmeans.fit_predict(X_scaled)
    df["CLUSTER"] = labels

    centroids = kmeans.cluster_centers_   # shape (4, n_features)

    # ── Rank clusters from safest to riskiest via centroid danger score ────────
    # Weights encode only *direction* (higher = riskier) for each feature.
    # K-Means still decides actual cluster membership with equal feature weight.
    direction_weights = np.array([
        0.30,   # TOTAL_OVERDUE_AMOUNT   – primary financial exposure
        0.10,   # TOTAL_INVOICES         – volume
        0.25,   # MAX_DAYS_OVERDUE       – worst breach
        0.20,   # AVG_DAYS_OVERDUE       – chronic behaviour
        0.10,   # PCT_CRITICAL_INVOICES  – severity breadth
        0.03,   # AMOUNT_CONCENTRATION   – structural signal (minor)
        0.02,   # RECENCY_DAYS           – age of exposure (minor)Age of oldest unpaid invoice
    ])

    centroid_danger = centroids @ direction_weights          # scalar per cluster
    cluster_rank    = np.argsort(np.argsort(centroid_danger))  # 0=safest … 3=riskiest

    risk_label_map       = {c: _RISK_LABELS[cluster_rank[c]] for c in range(4)}
    df["PREDICTED_RISK"] = df["CLUSTER"].map(risk_label_map)

    # ── Continuous RISK_SCORE from centroid-distance interpolation ─────────────
    distances  = cdist(X_scaled, centroids, metric="euclidean")   # (n, 4)
    vendor_idx = np.arange(len(df))

    band_size  = 25.0
    band_floor = cluster_rank[df["CLUSTER"].values] * band_size   # per-vendor base

    own_dist   = distances[vendor_idx, df["CLUSTER"].values]
    max_dist   = distances.max(axis=1).clip(min=1e-9)
    within_pos = (own_dist / max_dist) * band_size                # 0 … band_size

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

    # ── Aging bucket distribution ──────────────────────────────────────────────
    aging = bsik.groupby("AGING_BUCKET", observed=True)["DMBTR"].sum().to_dict()
    for b in ["0-30", "31-60", "61-90", "91-120", "120+"]:
        aging.setdefault(b, 0)

    # ── Risk distribution ──────────────────────────────────────────────────────
    risk_dist = vendor_df["PREDICTED_RISK"].value_counts().to_dict()
    for r in _RISK_LABELS:
        risk_dist.setdefault(r, 0)

    # ── Shared column rename map ───────────────────────────────────────────────
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

    # ── Top-10 riskiest vendors ────────────────────────────────────────────────
    top10_cols = ["LIFNR", "NAME1", "TOTAL_OVERDUE_AMOUNT", "RISK_SCORE", "PREDICTED_RISK"]
    top10 = (
        vendor_df.nlargest(10, "RISK_SCORE")[top10_cols]
        .rename(columns=_rename)
        .to_dict(orient="records")
    )

    # ── Scatter data (all vendors, lightweight) ────────────────────────────────
    scatter_cols = ["LIFNR", "NAME1", "TOTAL_OVERDUE_AMOUNT", "RISK_SCORE", "PREDICTED_RISK"]
    scatter = (
        vendor_df[scatter_cols]
        .rename(columns=_rename)
        .to_dict(orient="records")
    )

    # ── Full vendor table ──────────────────────────────────────────────────────
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
    }