"""Summarizes results/results.jsonl into histograms (results/*.png) and a table (results/summary.md).

    python3 analyze.py [results/results.jsonl]
"""

import json
import statistics
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

here = Path(__file__).parent
source = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "results" / "results.jsonl"
out = source.parent

LANGS = {"cpp": "C/C++", "rust": "Rust", "python": "Python"}
GROUPS = {"cold": "Cold start", "recompile": "Re-run, no change", "change": "Re-run, small change"}
ENGINES = {"old": ("Old engine (main)", "#2a78d6"), "new": ("Rewrite", "#eb6834")}
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"

rows = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
failed = [r for r in rows if not r["ok"]]
rows = [r for r in rows if r["ok"]]


def samples(engine, lang, group):
    return [r["ms"] / 1000 for r in rows if (r["engine"], r["lang"], r["group"]) == (engine, lang, group)]


def histogram(ax, lang, group):
    data = {e: samples(e, lang, group) for e in ENGINES}
    every = [x for xs in data.values() for x in xs]
    if not every:
        return
    # Log-spaced bins: the engines can differ by an order of magnitude
    lo, hi = min(every) * 0.9, max(every) * 1.1
    bins = np.geomspace(lo, hi, 30)
    for engine, (label, color) in ENGINES.items():
        if data[engine]:
            ax.hist(data[engine], bins=bins, color=color, alpha=0.3, histtype="stepfilled")
            ax.hist(data[engine], bins=bins, color=color, histtype="step", linewidth=2, label=label)
            ax.axvline(statistics.mean(data[engine]), color=color, linewidth=2, linestyle="--")
    ax.set_xscale("log")
    ax.xaxis.set_major_locator(matplotlib.ticker.LogLocator(subs=(1, 2, 3, 5, 7)))
    ax.xaxis.set_minor_locator(matplotlib.ticker.NullLocator())
    ax.xaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda x, _: f"{x:g}s"))
    ax.set_title(f"{LANGS[lang]} · {GROUPS[group]}", color=INK, fontsize=11, loc="left")
    ax.set_xlabel("Wall-clock time (log scale, dashed = mean)", color=MUTED, fontsize=9)
    ax.set_ylabel("Runs", color=MUTED, fontsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8, which="both")


plt.rcParams["font.family"] = "DejaVu Sans"

# One histogram per language and group, plus an overview grid of all nine
for lang in LANGS:
    for group in GROUPS:
        fig, ax = plt.subplots(figsize=(6, 3.6))
        histogram(ax, lang, group)
        ax.legend(frameon=False, fontsize=9)
        fig.tight_layout()
        fig.savefig(out / f"hist-{lang}-{group}.png", dpi=150)
        plt.close(fig)

fig, axes = plt.subplots(3, 3, figsize=(16, 11))
for i, lang in enumerate(LANGS):
    for j, group in enumerate(GROUPS):
        histogram(axes[i][j], lang, group)
handles, labels = axes[0][0].get_legend_handles_labels()
fig.legend(handles, labels, loc="upper center", ncol=2, frameon=False, fontsize=11)
fig.tight_layout(rect=(0, 0, 1, 0.96))
fig.savefig(out / "histograms.png", dpi=150)
plt.close(fig)


def fmt(xs):
    return f"{statistics.mean(xs):.2f}s ± {statistics.stdev(xs):.2f}" if len(xs) > 1 else "–"


lines = [
    "| Language | Scenario | Old engine mean | Rewrite mean | Old median | Rewrite median | Speedup (mean) | n (old/new) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
]
for lang in LANGS:
    for group in GROUPS:
        old, new = samples("old", lang, group), samples("new", lang, group)
        if not old or not new:
            continue
        speedup = statistics.mean(old) / statistics.mean(new)
        lines.append(
            f"| {LANGS[lang]} | {GROUPS[group]} | {fmt(old)} | {fmt(new)} | "
            f"{statistics.median(old):.2f}s | {statistics.median(new):.2f}s | "
            f"**{speedup:.2f}×** | {len(old)}/{len(new)} |"
        )

per_program = [
    "| Language | Program | Scenario | Old mean | Rewrite mean | Speedup |",
    "| --- | --- | --- | --- | --- | --- |",
]
for lang in LANGS:
    for program in sorted({r["program"] for r in rows if r["lang"] == lang}):
        for group in GROUPS:
            pick = lambda e: [r["ms"] / 1000 for r in rows
                              if (r["engine"], r["lang"], r["program"], r["group"]) == (e, lang, program, group)]
            old, new = pick("old"), pick("new")
            if old and new:
                per_program.append(
                    f"| {LANGS[lang]} | {program} | {GROUPS[group]} | {statistics.mean(old):.2f}s | "
                    f"{statistics.mean(new):.2f}s | {statistics.mean(old) / statistics.mean(new):.2f}× |"
                )

summary = "\n".join(lines) + "\n\n" + "\n".join(per_program) + "\n"
if failed:
    summary += f"\n{len(failed)} failed run(s) excluded:\n\n" + "\n".join(
        f"- {r['engine']} {r['lang']}/{r['program']} {r['group']}: {r['error'][:200]}" for r in failed
    ) + "\n"
(out / "summary.md").write_text(summary)
print(summary)
