"""Truncation (causality) test for /detect.

For a cut time T: run the detector on the FULL dataset, and again with asOfUnix = T, and
check every output at times <= T is identical. Also run it on a real snapshot folder
(telemetry cut at T by the organizers) and compare to full_week.

Nothing is cached: each run reloads the CSV and recomputes features and probabilities.

    python ml/tests/test_truncation.py [--full Resources/full_week] [--snapshots DIR [DIR ...]]
    pytest ml/tests/test_truncation.py
"""
import argparse
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml"))

import detector                         # noqa: E402
from features import build_features     # noqa: E402
from loader import load                 # noqa: E402

FULL = ROOT / "Resources" / "full_week"
CUTS = {"snapshot 10-08 12:00": "2026-10-08T12:00:00Z", "snapshot 10-09 03:30": "2026-10-09T03:30:00Z",
        "snapshot 10-10 09:00": "2026-10-10T09:00:00Z", "mock test 10-10 15:30": "2026-10-10T15:30:00Z",
        "arbitrary 10-06 17:25": "2026-10-06T17:25:00Z", "arbitrary 10-11 02:10": "2026-10-11T02:10:00Z"}


def unix(s):
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def max_diff(a, b, T):
    """Largest |difference| over all probabilities at ts <= T. Also checks the time axes match."""
    A = {x["assetId"]: x for x in a["assets"]}
    B = {x["assetId"]: x for x in b["assets"]}
    assert A.keys() == B.keys(), "asset sets differ"
    worst, n = 0.0, 0
    for k, x in A.items():
        y = B[k]
        tx, ty = np.array(x["tsUnix"]), np.array(y["tsUnix"])
        m = tx <= T
        assert (tx[m] == ty[ty <= T]).all() and m.sum() == (ty <= T).sum(), f"{k}: time axes differ"
        assert x["probs"].keys() == y["probs"].keys()
        for c in x["probs"]:
            d = np.abs(np.array(x["probs"][c])[m] - np.array(y["probs"][c])[ty <= T])
            worst, n = max(worst, float(d.max())), n + int(m.sum())
    return worst, n


def feature_diff(full_dir, T):
    """Same check one layer down: the feature table itself."""
    a = load(full_dir)
    b = load(full_dir, as_of=T)
    Fa, Fb = build_features(a.wide, a.network), build_features(b.wide, b.network)
    Fa = Fa[Fa["ts_unix"] <= T].reset_index(drop=True)
    cols = [c for c in Fb.columns if c not in ("facility", "system")]
    A, B = Fa[cols].values, Fb[cols].values
    assert A.shape == B.shape, "feature tables have different shapes"
    assert (np.isnan(A) == np.isnan(B)).all(), "a feature is NaN in one run but not the other"
    return float(np.nanmax(np.abs(A - B))), 0


def cut_copy(full_dir, T, dest):
    """Copy a dataset folder with telemetry cut at T (what an organizer snapshot is)."""
    dest = Path(dest)
    for f in ("network.json", "ops.json"):
        shutil.copy(Path(full_dir) / f, dest / f)
    t = pd.read_csv(Path(full_dir) / "telemetry.csv")
    t[t["ts_unix"] <= T].to_csv(dest / "telemetry.csv", index=False)


def run(full_dir=FULL, snapshot_dirs=()):
    results = []
    full = detector.detect(full_dir, None, use_cache=False)
    snap_by_T = {}
    for d in snapshot_dirs:
        ds = load(d)
        snap_by_T[ds.now] = d
    with tempfile.TemporaryDirectory() as tmp:
        for name, ts in CUTS.items():
            T = unix(ts)
            # 1. asOfUnix on the full folder
            cut = detector.detect(full_dir, T, use_cache=False)
            d1, n = max_diff(full, cut, T)
            fd, _ = feature_diff(full_dir, T)
            # 2. a folder whose telemetry file was physically cut at T
            sub = Path(tmp) / f"cut_{T}"
            sub.mkdir()
            cut_copy(full_dir, T, sub)
            d2, _ = max_diff(full, detector.detect(sub, None, use_cache=False), T)
            # 3. the organizers' real snapshot folder, if we were given one for this cut
            d3 = None
            if T in snap_by_T:
                d3, _ = max_diff(full, detector.detect(snap_by_T[T], None, use_cache=False), T)
            results.append((name, T, n, fd, d1, d2, d3))
    return results


def report(results):
    print(f"{'cut':24s} {'values':>9s} {'features':>9s} {'asOfUnix':>9s} {'cut file':>9s} {'real snapshot':>14s}")
    for name, T, n, fd, d1, d2, d3 in results:
        print(f"{name:24s} {n:9d} {fd:9.1f} {d1:9.1f} {d2:9.1f} {('n/a' if d3 is None else f'{d3:.1f}'):>14s}")
    worst = max(max(r[3], r[4], r[5], r[6] or 0.0) for r in results)
    print(f"\nlargest difference anywhere: {worst}")
    return worst


def test_truncation():
    snaps = [p for p in (ROOT.parent / "data" / "history").glob("snapshot_*")] if (ROOT.parent / "data" / "history").exists() else []
    assert report(run(FULL, snaps)) == 0.0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", default=str(FULL))
    ap.add_argument("--snapshots", nargs="*", default=[])
    a = ap.parse_args()
    sys.exit(0 if report(run(a.full, a.snapshots)) == 0.0 else 1)
