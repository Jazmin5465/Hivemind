"""Load any dataset folder (network.json, ops.json, telemetry.csv).

"Now" is the last ts_unix in the telemetry (or `as_of`), never the system clock.
answer_key.json is never read here.

as_of: ignore every telemetry row with ts_unix > as_of BEFORE anything else happens,
so nothing computed afterwards can see the future.
"""
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

STEP = 300  # seconds, 5-minute grid


@dataclass
class Dataset:
    network: dict
    ops: dict
    wide: pd.DataFrame      # index ts_unix, columns "asset|metric"
    t0: int
    now: int

    @property
    def limits(self):
        return self.network["defaults"]["tank_limits_pct"]

    def facilities(self):
        """Yield (system dict, facility dict)."""
        for s in self.network["systems"]:
            for f in s["facilities"]:
                yield s, f

    def series(self, asset, metric):
        return self.wide[f"{asset}|{metric}"]


def load(folder, as_of=None) -> Dataset:
    folder = Path(folder)
    network = json.loads((folder / "network.json").read_text())
    ops = json.loads((folder / "ops.json").read_text())
    tele = pd.read_csv(folder / "telemetry.csv", usecols=["ts_unix", "asset_id", "metric", "value"])
    if as_of is not None:
        tele = tele[tele["ts_unix"] <= int(as_of)]
    if tele.empty:
        raise ValueError("no telemetry rows at or before asOfUnix")
    wide = (tele.drop_duplicates(["ts_unix", "asset_id", "metric"], keep="last")
                .set_index(["ts_unix", "asset_id", "metric"])["value"].unstack(["asset_id", "metric"]))
    wide.columns = [f"{a}|{m}" for a, m in wide.columns]
    wide = wide.sort_index()
    grid = np.arange(wide.index.min(), wide.index.max() + 1, STEP)
    wide = wide.reindex(grid)
    wide.index.name = "ts_unix"
    return Dataset(network, ops, wide, int(grid[0]), int(grid[-1]))


if __name__ == "__main__":
    import sys
    ds = load(sys.argv[1])
    nf = sum(1 for _ in ds.facilities())
    print(f"systems={len(ds.network['systems'])} facilities={nf} "
          f"steps={len(ds.wide)} cols={ds.wide.shape[1]} now={ds.now}")
