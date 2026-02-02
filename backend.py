#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
COLT-style Search Backend (FastAPI), no Gradio.
- Upload Excel -> loads all sheets, builds TF-IDF (offline) for semantic.
- POST /load  (multipart file) -> returns sheet names
- POST /search {query, run_semantic} -> returns per-sheet keyword + semantic results
"""

import io
import os
import re
from typing import Dict, List, Optional, Tuple

import pandas as pd
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ---------- Keyword search helpers (from your code) ----------

def _looks_like_id(s: str) -> bool:
    return bool(re.match(r"^[A-Za-z]+0*\d+$", str(s)))

def _coerce_to_str(df: pd.DataFrame) -> pd.DataFrame:
    return df.astype(str).fillna("")

def keyword_match_mask(df: pd.DataFrame, query: str) -> pd.Series:
    sdf = _coerce_to_str(df)
    q = str(query)
    if _looks_like_id(q):
        ql = q.lower()
        col_hits = [sdf[c].str.lower() == ql for c in sdf.columns]
    else:
        col_hits = [sdf[c].str.contains(q, case=False, na=False) for c in sdf.columns]
    mask = col_hits[0]
    for m in col_hits[1:]:
        mask = mask | m
    return mask

def keyword_search(
    sheets: Dict[str, pd.DataFrame],
    query: str,
    per_sheet_cap: int = 100,
    total_cap: int = 1000,
) -> Tuple[Dict[str, pd.DataFrame], Dict[str, int], int]:
    results: Dict[str, pd.DataFrame] = {}
    counts: Dict[str, int] = {}
    total = 0
    for name, df in sheets.items():
        if df.empty:
            counts[name] = 0
            continue
        mask = keyword_match_mask(df, query)
        count = int(mask.sum())
        counts[name] = count
        total += count
        if count > 0:
            results[name] = df.loc[mask].head(per_sheet_cap).copy()
    if total_cap is not None and total > total_cap:
        trimmed: Dict[str, pd.DataFrame] = {}
        remaining = int(total_cap)
        for name in sorted(results.keys()):
            if remaining <= 0:
                break
            dfm = results[name]
            if len(dfm) <= remaining:
                trimmed[name] = dfm
                remaining -= len(dfm)
            else:
                trimmed[name] = dfm.head(remaining)
                remaining = 0
        results = trimmed
    return results, counts, total

# ---------- Offline TF-IDF semantic (from your code) ----------

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

class TfIdfSemantic:
    def __init__(self):
        self.vectorizers: Dict[str, TfidfVectorizer] = {}
        self.matrices = {}
        self.rows: Dict[str, pd.DataFrame] = {}

    @staticmethod
    def row_texts(df: pd.DataFrame) -> List[str]:
        s = df.astype(str)
        return (s.apply(lambda r: " | ".join(r.values.tolist()), axis=1)).tolist()

    def build(self, sheets: Dict[str, pd.DataFrame], per_sheet_limit: Optional[int] = 5000):
        self.vectorizers.clear()
        self.matrices.clear()
        self.rows.clear()
        for name, df in sheets.items():
            use_df = df if per_sheet_limit is None else df.head(int(per_sheet_limit))
            texts = self.row_texts(use_df)
            if not texts:
                continue
            vec = TfidfVectorizer(max_features=200000)
            X = vec.fit_transform(texts)
            self.vectorizers[name] = vec
            self.matrices[name] = X
            self.rows[name] = use_df

    def search(self, query: str, top_k_per_sheet: int = 30) -> Dict[str, pd.DataFrame]:
        out: Dict[str, pd.DataFrame] = {}
        for name, vec in self.vectorizers.items():
            X = self.matrices[name]
            if X.shape[0] == 0:
                continue
            qv = vec.transform([query])
            sims = cosine_similarity(X, qv).ravel()
            idx = sims.argsort()[::-1][: int(top_k_per_sheet)]
            rows = self.rows[name].iloc[idx].copy()
            rows.insert(0, "_semantic_score", sims[idx])
            out[name] = rows
        return out

# ---------- App state ----------

SHEETS: Dict[str, pd.DataFrame] = {}
SEM = TfIdfSemantic()

# ---------- FastAPI setup ----------

app = FastAPI(title="COLT Search Backend", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],         # tighten for prod
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# ---------- DTOs ----------

class SearchRequest(BaseModel):
    query: str
    run_semantic: bool = True

# ---------- Helpers ----------

def read_workbook_bytes(raw: bytes) -> Dict[str, pd.DataFrame]:
    return pd.read_excel(io.BytesIO(raw), sheet_name=None, engine="openpyxl")

# ---------- Routes ----------

@app.post("/load")
async def load_workbook(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        global SHEETS
        SHEETS = read_workbook_bytes(raw)
        # Build/refresh semantic index eagerly so first search is fast
        SEM.build(SHEETS, per_sheet_limit=5000)
        return {"sheets": list(SHEETS.keys())}
    except Exception as e:
        return JSONResponse({"error": f"Failed to parse workbook: {e}"}, status_code=400)

@app.post("/search")
async def search(payload: SearchRequest):
    if not SHEETS:
        return JSONResponse({"error": "No workbook loaded. POST /load first."}, status_code=400)
    q = payload.query.strip()
    if not q:
        return JSONResponse({"error": "Empty query."}, status_code=400)

    # Keyword
    kw_results, kw_counts, kw_total = keyword_search(SHEETS, q, per_sheet_cap=100, total_cap=1000)
    kw_summary = "\n".join(
        [f"Total keyword matches (pre-cap): {kw_total}"]
        + [f"- {k}: {kw_counts[k]}" for k in sorted(kw_counts.keys())]
    )
    kw_json = {name: df.to_dict(orient="records") for name, df in kw_results.items()}

    resp = {
        "keyword": {
            "summary": kw_summary,
            "csv_url": None,     # Next.js can assemble CSV client-side if needed
            "results": kw_json
        },
        "semantic": None
    }

    # Semantic (offline TF-IDF)
    if payload.run_semantic:
        sem_results = SEM.search(q, top_k_per_sheet=30)
        sem_total = sum(len(df) for df in sem_results.values())
        sem_summary = f"Semantic hits (top 30 per sheet): {sem_total}"
        sem_json = {name: df.to_dict(orient="records") for name, df in sem_results.items()}
        resp["semantic"] = {
            "summary": sem_summary,
            "csv_url": None,
            "results": sem_json
        }

    return JSONResponse(resp)

@app.get("/healthz")
async def health():
    return {"ok": True}
