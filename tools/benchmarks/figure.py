# Plots output/summary.json (the mean of each series) as output/figure.png.
# Usage: python3 figure.py [program]   (default: hello-world)
import json
import re
import sys
from pathlib import Path

import matplotlib.pyplot as plt

OUTPUT = Path(__file__).parent / "output"
program = sys.argv[1] if len(sys.argv) > 1 else "hello-world"
data = json.loads((OUTPUT / "summary.json").read_text())

TOOLCHAINS = {"cpp": "clang", "python": "python", "rust": "rustc"}
# Each series' key, legend label, color, hatch, and the padding (in points) of its bar labels.
SERIES = [
    ("local", "Local", "#de9575", None, 0.5),
    ("first", "Engine (first run)", "#c95c60", "////", 4.5),
    ("subsequent", "Engine (subsequent)", "#c95c60", None, 4.5),
]
toolchains = [t for t in TOOLCHAINS if program in data["summary"].get(t, {})]
SIZES = {"tick": 15, "label": 15, "legend": 9.6, "bar": 9}
version = lambda t: re.search(r"\d+\.\d+\.\d+", data["meta"]["versions"][t])[0]

plt.style.use("seaborn-v0_8-whitegrid")
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["DejaVu Serif"],
    "axes.edgecolor": "#dedede",
    "grid.color": "#dedede",
    "hatch.linewidth": 0.6,
})
fig = plt.figure(figsize=(7.6, 4.7))
ax = fig.add_axes((0.217, 0.115, 0.728, 0.819))
width, top = 1 / 6, 0
for i, (key, label, color, hatch, padding) in enumerate(SERIES):
    xs = [x + (i - 1) * width for x in range(len(toolchains))]
    means = [data["summary"][t][program][key]["mean"] for t in toolchains]
    top = max(top, *means)
    bars = ax.bar(xs, means, width, label=label, color=color, hatch=hatch, edgecolor="white", linewidth=0.3 if hatch else 0)
    ax.bar_label(bars, labels=[f"{m:.0f}" for m in means], padding=padding, fontsize=SIZES["bar"])

ax.set_xticks(range(len(toolchains)), [f"{TOOLCHAINS[t]} v{version(t)}" for t in toolchains])
ax.tick_params(labelsize=SIZES["tick"], pad=4.5)
ax.set_ylabel("Total Runtime (ms)", fontsize=SIZES["label"], labelpad=2.5)
ax.set_ylim(0, top * 1.15)
ax.legend(loc="upper left", fontsize=SIZES["legend"], frameon=True)
fig.savefig(OUTPUT / "figure.png", dpi=300, bbox_inches="tight")
