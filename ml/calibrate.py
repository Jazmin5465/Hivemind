"""Step 3: fit the simulator's open parameters from the real week, then check the fit.

Uses full_week + its answer key (allowed here: calibration/validation only, never
loaded by the app). Writes src/sim_params.json.

    python src/calibrate.py data/history/full_week
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from loader import load
from sim import DEFAULT_PARAMS, PARAMS_FILE, simulate


def fit(ds, key):
    W = ds.wide
    fac = {f["id"]: f for _, f in ds.facilities()}
    busy = np.zeros(len(W), bool)           # any labelled event active (per facility handled below)
    P = json.loads(json.dumps(DEFAULT_PARAMS))

    # --- noise from healthy stretches of every facility ---------------------
    wf, pf, rf, ps, lres = [], [], [], [], []
    for fid, f in fac.items():
        ev = [e for e in key if e["facility"] == fid]
        ok = np.ones(len(W), bool)
        for e in ev:
            end = e["end_unix"] or W.index[-1]
            ok &= ~((W.index >= e["onset_unix"] - 600) & (W.index <= end + 600))
        p, pl, t = f["pump"]["id"], f["pipeline"]["id"], f["tank"]["id"]
        run = ok & (W[f"{p}|status"].values == 1)
        off = ok & (W[f"{p}|status"].values == 0)
        for w in f["wells"]:
            x = W[f"{w['id']}|water_bpd"].values
            m = ok & (x > 0)
            wf.append(np.std(x[m] / w["baseline_water_bpd"]))
        pf.append(np.std(W[f"{p}|flow_bpd"].values[run] / f["pump"]["max_flow_bpd"]))
        rf.append(np.std(W[f"{pl}|receive_flow_bpd"].values[run] / f["pump"]["max_flow_bpd"]))
        ps.append(np.std(W[f"{p}|discharge_psi"].values[run]))
        ps.append(np.std(W[f"{pl}|pressure_psi"].values[off]))
        # level noise: if it is reading noise, one-step residuals have std sqrt(2)*sigma
        lv = W[f"{t}|level_pct"]
        infl = W[f"{fid}|inflow_bpd"]
        flow = W[f"{p}|flow_bpd"]
        cap = f["tank"]["capacity_bbl"]
        pred = lv.shift(1) + (infl.shift(1) - flow.shift(1)) / 24 / cap * 100 / 12
        r = (lv - pred).values
        st = W[f"{p}|status"].values
        good = ok & np.r_[False, (st[1:] == st[:-1])] & np.r_[False, False, (st[2:] == st[:-2])]
        lres.append(r[good & (lv.values < 90)])
    lres = np.concatenate([x[~np.isnan(x)] for x in lres])
    ac1 = np.corrcoef(lres[:-1], lres[1:])[0, 1]
    P["noise"].update(well_frac=float(np.mean(wf)), pump_flow_frac=float(np.mean(pf)),
                      recv_flow_frac=float(np.mean(rf)), psi=float(np.mean(ps)),
                      level=float(np.std(lres) / np.sqrt(2)))
    print(f"level residual lag-1 autocorr {ac1:+.2f} (-0.5 = reading noise, 0 = process noise)")

    # --- worn pumps ----------------------------------------------------------
    rates, ppf = [], []
    for e in key:
        if e["category"] != "pump_degradation":
            continue
        f = fac[e["facility"]]; p = f["pump"]["id"]
        end = e["end_unix"] or W.index[-1]
        m = (W.index >= e["onset_unix"]) & (W.index < end) & (W[f"{p}|status"].values == 1)
        h = (W.index[m] - e["onset_unix"]) / 3600
        y = W.loc[m, f"{p}|flow_bpd"].values / f["pump"]["max_flow_bpd"]
        rates.append(-np.polyfit(h, y, 1)[0])
        ppf.append(np.polyfit(y, W.loc[m, f"{p}|discharge_psi"].values, 1)[0])
    P["deg"].update(rate_per_h=float(np.mean(rates)), rate_sd=float(np.std(rates)),
                    psi_per_flow=float(np.mean(ppf)))

    # --- leaks ---------------------------------------------------------------
    steps, rates, hs, ls, ds_ = [], [], [], [], []
    for e in key:
        if e["category"] != "pipeline_leak":
            continue
        f = fac[e["facility"]]; p, pl = f["pump"]["id"], f["pipeline"]["id"]
        end = e["end_unix"] or W.index[-1]
        m = (W.index >= e["onset_unix"]) & (W.index < end) & (W[f"{p}|status"].values == 1)
        h = (W.index[m] - e["onset_unix"]) / 3600
        loss = 1 - W.loc[m, f"{pl}|receive_flow_bpd"].values / W.loc[m, f"{p}|flow_bpd"].values
        a, b = np.polyfit(h, loss, 1)
        rates.append(a); steps.append(b)
        # pressure drop vs the healthy level for that line
        sysd = next(s for s in ds.network["systems"] if s["id"] == e["system"])
        healthy = sysd["disposal_site"]["pressure_psi"] + P["pipeline_offset_psi"]
        drop = healthy - W.loc[m, f"{pl}|pressure_psi"].values
        ls.append(a * h + b); ds_.append(drop)
    L, D = np.concatenate(ls), np.concatenate(ds_)
    P["leak"].update(step=float(np.mean(steps)), rate_per_h=float(np.mean(rates)),
                     rate_sd=float(np.std(rates)), psi_per_loss=float((L @ D) / (L @ L)))
    return P


def validate(ds, key, P):
    """Re-simulate the real week from its labels and real starting state, compare."""
    W = ds.wide
    inc = [dict(category=e["category"], facility=e["facility"], onset_unix=e["onset_unix"],
                end_unix=e["end_unix"]) for e in key]
    init = {}
    for _, f in ds.facilities():
        t, p = f["tank"]["id"], f["pump"]["id"]
        init[t] = (float(W[f"{t}|level_pct"].iloc[0]), bool(W[f"{p}|status"].iloc[0] == 1))
    tele, labels = simulate(ds.network, ds.ops, inc, ds.t0, len(W), seed=7, params=P, init=init)
    S = tele.pivot_table(index="ts_unix", columns=["asset_id", "metric"], values="value", aggfunc="last")
    S.columns = [f"{a}|{m}" for a, m in S.columns]
    S = S.reindex(W.index)

    print("\nPer-metric: real vs simulated mean / std over the whole week")
    kinds = {}
    for c in W.columns:
        kinds.setdefault(c.split("|")[1], []).append(c)
    for m, cols in kinds.items():
        r, s = W[cols].values.ravel(), S[cols].values.ravel()
        print(f"  {m:18s} mean {np.nanmean(r):9.2f} vs {np.nanmean(s):9.2f}   std {np.nanstd(r):8.2f} vs {np.nanstd(s):8.2f}")

    print("\nTank level: RMSE sim vs real (pct points), and pump-state agreement")
    rm, ag = [], []
    for _, f in ds.facilities():
        t, p = f["tank"]["id"], f["pump"]["id"]
        rm.append(np.sqrt(np.nanmean((W[f"{t}|level_pct"] - S[f"{t}|level_pct"]) ** 2)))
        ag.append(np.mean(W[f"{p}|status"].values == S[f"{p}|status"].values))
    print(f"  level RMSE mean {np.mean(rm):.2f} (max {np.max(rm):.2f});  pump status match {100*np.mean(ag):.1f}%")

    print("\nShutdown (trip) times for the labelled pump failures, sim vs key (minutes):")
    kk = {e["id"]: e for e in key}
    for e, l in zip(key, labels):
        if e["category"] == "pump_failure" and e.get("trips_at_unix"):
            sim_t = l.get("trips_at_unix")
            d = None if sim_t is None else (sim_t - e["trips_at_unix"]) / 60
            print(f"  {e['id']:9s} key {e['trips_at'][5:16]}  sim {'never' if sim_t is None else l['trips_at'][5:16]}  diff {d if d is None else round(d)}")
    return tele


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "data/history/full_week"
    ds = load(folder)
    key = json.loads((Path(folder) / "answer_key.json").read_text())
    P = fit(ds, key)
    PARAMS_FILE.write_text(json.dumps(P, indent=2))
    print("Fitted parameters:\n" + json.dumps(P, indent=2))
    validate(ds, key, P)
