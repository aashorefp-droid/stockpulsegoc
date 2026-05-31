"use client";

import { useState } from "react";
import { downloadCsv } from "@/lib/csv";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Trade {
  date: string;
  direction: string;
  pre_drift: number;
  vol_ratio?: number;
  entry: number;
  exit: number;
  gap_pct?: number;
  day_pct: number;
  pnl_pct: number;
  win: boolean;
  eps_surprise?: number;
  beat: boolean;
  rev_aligned: boolean;
  reason?: string;
}

interface BacktestStats {
  total: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  total_return: number;
  max_dd: number;
  avg_move: number;
  avg_pnl: number;
}

interface Backtest {
  trades: Trade[];
  equity: number[];
  stats: BacktestStats;
  filtered_trades?: Trade[];
  filtered_equity?: number[];
  filtered_stats?: BacktestStats;
  error?: string;
}

function pctColor(v?: number | null) {
  if (v == null) return "text-muted";
  return v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted";
}

function fmt(v?: number | null, decimals = 2) {
  if (v == null) return "-";
  return v.toFixed(decimals);
}

function fmtPct(v?: number | null) {
  if (v == null) return "-";
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

function EquityCurve({ equity }: { equity: number[] }) {
  if (!equity || equity.length < 2) return null;
  const W = 600, H = 160, PAD = 30;
  const min = Math.min(...equity);
  const max = Math.max(...equity);
  const range = max - min || 1;
  const xs = equity.map((_, i) => PAD + (i / (equity.length - 1)) * (W - PAD * 2));
  const ys = equity.map((v) => H - PAD - ((v - min) / range) * (H - PAD * 2));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  const fill = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ")
    + ` L${xs[xs.length - 1]},${H - PAD} L${xs[0]},${H - PAD} Z`;
  const last = equity[equity.length - 1];
  const lineColor = last >= 100 ? "#4ade80" : "#f87171";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40">
      <defs>
        <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#334155" strokeWidth="1" />
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#334155" strokeWidth="1" />
      {(() => {
        const baseY = H - PAD - ((100 - min) / range) * (H - PAD * 2);
        return <line x1={PAD} y1={baseY} x2={W - PAD} y2={baseY} stroke="#475569" strokeWidth="1" strokeDasharray="4,3" />;
      })()}
      <path d={fill} fill="url(#eq-grad)" />
      <path d={path} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
      <text x={PAD + 4} y={PAD + 12} fill="#94a3b8" fontSize="10">{max.toFixed(0)}</text>
      <text x={PAD + 4} y={H - PAD - 4} fill="#94a3b8" fontSize="10">{min.toFixed(0)}</text>
      <text x={W - PAD - 4} y={ys[ys.length - 1] - 6} fill={lineColor} fontSize="11" textAnchor="end">
        {last.toFixed(1)}
      </text>
    </svg>
  );
}

function DualEquityCurve({ allEquity, filtEquity }: { allEquity: number[]; filtEquity: number[] }) {
  const W = 600, H = 160, PAD = 30;
  const combined = [...allEquity, ...filtEquity];
  if (combined.length < 2) return null;
  const min = Math.min(...combined);
  const max = Math.max(...combined);
  const range = max - min || 1;

  function makePath(eq: number[]) {
    if (eq.length < 2) return "";
    const xs = eq.map((_, i) => PAD + (i / (eq.length - 1)) * (W - PAD * 2));
    const ys = eq.map((v) => H - PAD - ((v - min) / range) * (H - PAD * 2));
    return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  }

  const baseY = H - PAD - ((100 - min) / range) * (H - PAD * 2);

  return (
    <div>
      <div className="flex gap-4 text-xs mb-1">
        <span className="flex items-center gap-1"><span className="inline-block w-6 h-0.5 bg-slate-400"></span>All Trades</span>
        <span className="flex items-center gap-1"><span className="inline-block w-6 h-0.5 bg-yellow-400"></span>Rev-Aligned Only</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40">
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#334155" strokeWidth="1" />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#334155" strokeWidth="1" />
        <line x1={PAD} y1={baseY} x2={W - PAD} y2={baseY} stroke="#475569" strokeWidth="1" strokeDasharray="4,3" />
        <path d={makePath(allEquity)} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" strokeDasharray="5,3" />
        <path d={makePath(filtEquity)} fill="none" stroke="#facc15" strokeWidth="2" strokeLinejoin="round" />
        <text x={PAD + 4} y={PAD + 12} fill="#94a3b8" fontSize="10">{max.toFixed(0)}</text>
        <text x={PAD + 4} y={H - PAD - 4} fill="#94a3b8" fontSize="10">{min.toFixed(0)}</text>
      </svg>
    </div>
  );
}

function StatCompare({ label, all, filt, good, format }: {
  label: string;
  all: number;
  filt?: number;
  good: "high" | "low";
  format: (v: number) => string;
}) {
  const better = filt != null && (good === "high" ? filt > all : filt < all);
  return (
    <tr className="border-b border-slate-800 text-xs">
      <td className="py-1.5 pr-3 text-muted">{label}</td>
      <td className="text-right pr-3 font-mono">{format(all)}</td>
      <td className={`text-right font-mono font-semibold ${filt == null ? "text-muted" : better ? "text-yellow-400" : "text-slate-400"}`}>
        {filt != null ? format(filt) : "-"}
        {filt != null && better && <span className="ml-1 text-yellow-400 text-[10px]">up</span>}
      </td>
    </tr>
  );
}

export default function EarningsBacktestPanel({ ticker }: { ticker: string }) {
  const [backtest, setBacktest] = useState<Backtest | null>(null);
  const [loading, setLoading] = useState(false);

  async function runBacktest() {
    if (!ticker) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/earnings/${ticker}/backtest`);
      const j = await res.json();
      setBacktest(j);
    } catch {
      setBacktest({ error: "Failed to load backtest" } as Backtest);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">Walk-Forward Backtest</h2>
        <button className="btn-primary text-xs px-4 py-1.5" onClick={runBacktest} disabled={loading}>
          {loading ? "Running..." : "Run Backtest"}
        </button>
      </div>
      <p className="text-xs text-muted">Signal: 5-day pre-earnings drift {"->"} Long/Short on earnings day. Entry: prev close, Exit: earnings close.</p>

      {backtest?.error && <p className="text-red-400 text-sm">{backtest.error}</p>}

      {backtest && !backtest.error && backtest.stats && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left py-1.5 pr-3 text-muted font-normal">Metric</th>
                  <th className="text-right pr-3 text-slate-300 font-semibold">All Trades</th>
                  <th className="text-right text-yellow-400 font-semibold">Rev-Aligned</th>
                </tr>
              </thead>
              <tbody>
                <StatCompare label="Total Trades" all={backtest.stats.total} filt={backtest.filtered_stats?.total} good="high" format={(v) => String(v)} />
                <StatCompare label="Win Rate" all={backtest.stats.win_rate} filt={backtest.filtered_stats?.win_rate} good="high" format={(v) => v + "%"} />
                <StatCompare label="Profit Factor" all={backtest.stats.profit_factor} filt={backtest.filtered_stats?.profit_factor} good="high" format={(v) => v.toFixed(2)} />
                <StatCompare label="Total Return" all={backtest.stats.total_return} filt={backtest.filtered_stats?.total_return} good="high" format={(v) => (v > 0 ? "+" : "") + v + "%"} />
                <StatCompare label="Max Drawdown" all={backtest.stats.max_dd} filt={backtest.filtered_stats?.max_dd} good="low" format={(v) => "-" + v + "%"} />
                <StatCompare label="Avg Win" all={backtest.stats.avg_win} filt={backtest.filtered_stats?.avg_win} good="high" format={(v) => "+" + v + "%"} />
                <StatCompare label="Avg Loss" all={backtest.stats.avg_loss} filt={backtest.filtered_stats?.avg_loss} good="low" format={(v) => v + "%"} />
                <StatCompare label="Avg PnL" all={backtest.stats.avg_pnl} filt={backtest.filtered_stats?.avg_pnl} good="high" format={(v) => (v > 0 ? "+" : "") + v + "%"} />
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Rev-Aligned: trades where EPS beat + strong pre-drift align.</p>

          {backtest.filtered_equity && backtest.filtered_equity.length >= 2
            ? <DualEquityCurve allEquity={backtest.equity} filtEquity={backtest.filtered_equity} />
            : <EquityCurve equity={backtest.equity} />
          }

          <div className="flex justify-end">
            <button
              onClick={() => downloadCsv(
                `${ticker}_backtest_trades.csv`,
                ["Rev-Aligned", "Date", "Direction", "Pre Drift%", "Entry", "Exit", "Day%", "PnL%", "EPS Surprise", "Vol", "Reason"],
                [...backtest.trades].reverse().map(t => [t.rev_aligned ? "Y" : "", t.date, t.direction, t.pre_drift, t.entry, t.exit, t.day_pct, t.pnl_pct, t.eps_surprise, t.vol_ratio, t.reason])
              )}
              className="px-3 py-1 text-xs rounded-lg border border-border text-muted hover:text-white hover:border-white/20 transition-colors"
            >
              CSV
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="text-muted border-b border-slate-700">
                  <th className="text-left py-1 pr-2 w-4"></th>
                  <th className="text-left py-1 pr-3">Date</th>
                  <th className="text-right pr-3">Dir</th>
                  <th className="text-right pr-3">Pre Drift</th>
                  <th className="text-right pr-3">Entry</th>
                  <th className="text-right pr-3">Exit</th>
                  <th className="text-right pr-3">Day%</th>
                  <th className="text-right pr-3">PnL%</th>
                  <th className="text-right pr-3">EPS Surp</th>
                  <th className="text-right pr-3">Vol</th>
                  <th className="text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {[...backtest.trades].reverse().map((t, i) => (
                  <tr key={i} className={`border-b border-slate-800 hover:bg-slate-800/30 ${t.win ? "bg-green-950/30" : "bg-red-950/20 opacity-80"}`}>
                    <td className="py-1 pr-2 text-yellow-400 text-center">{t.rev_aligned ? "*" : ""}</td>
                    <td className="py-1 pr-3">{t.date}</td>
                    <td className={`text-right pr-3 font-semibold ${t.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>{t.direction}</td>
                    <td className={`text-right pr-3 ${pctColor(t.pre_drift)}`}>{fmtPct(t.pre_drift)}</td>
                    <td className="text-right pr-3 text-muted">${fmt(t.entry)}</td>
                    <td className="text-right pr-3 text-muted">${fmt(t.exit)}</td>
                    <td className={`text-right pr-3 ${pctColor(t.day_pct)}`}>{fmtPct(t.day_pct)}</td>
                    <td className={`text-right pr-3 font-bold ${t.win ? "text-green-400" : "text-red-400"}`}>{fmtPct(t.pnl_pct)}</td>
                    <td className={`text-right pr-3 ${pctColor(t.eps_surprise)}`}>
                      {t.eps_surprise != null ? fmtPct(t.eps_surprise) : "-"}
                    </td>
                    <td className="text-right pr-3 text-muted">{t.vol_ratio != null ? t.vol_ratio.toFixed(2) : "-"}</td>
                    <td className={`text-left pl-1 italic ${t.win ? "text-green-400/70" : "text-orange-400"}`}>
                      {t.reason || ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
