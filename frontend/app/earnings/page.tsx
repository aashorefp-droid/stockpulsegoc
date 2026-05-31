"use client";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { downloadCsv } from "@/lib/csv";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const EarningsBacktestPanel = dynamic(() => import("@/components/EarningsBacktestPanel"), {
  ssr: false,
  loading: () => <div className="card text-sm text-muted">Loading backtest tools...</div>,
});

interface Factor {
  name: string;
  value: string;
  signal: string;
  score: number;
}

interface Direction {
  score: number;
  direction: string;
  confidence: string;
  factors: Factor[];
}

interface ExpectedMove {
  expected_move_pct?: number;
  expected_move_dollar?: number;
  upside_target?: number;
  downside_target?: number;
  atm_strike?: number;
  exp_date?: string;
  dte?: number;
  call_mid?: number;
  put_mid?: number;
  straddle_cost?: number;
  call_iv?: number;
  put_iv?: number;
  iv_skew?: number;
  error?: string;
  skipped?: string;
}

interface HistoryRow {
  date: string;
  eps_estimate?: number;
  eps_actual?: number;
  surprise_pct?: number;
  prev_close?: number;
  earn_open?: number;
  earn_close?: number;
  gap_pct?: number;
  day_pct?: number;
  five_day_pct?: number;
  direction?: string;
}

interface Stats {
  count?: number;
  avg_abs_move?: number;
  max_move?: number;
  avg_move?: number;
  bull_rate?: number;
  beat_rate?: number;
  beat_then_up_rate?: number;
  avg_5d_drift?: number;
  last4_avg_move?: number;
}

interface PostFactor {
  name: string;
  value: string;
  signal: string;
  score: number;
}

interface PostEarnings {
  earnings_date: string;
  gap_pct: number;
  day_pct: number;
  eps_surprise?: number;
  reaction: string;
  why: string;
  next_move_score: number;
  next_move_direction: string;
  next_move_confidence: string;
  factors: PostFactor[];
  iv_note: string;
  suggested_play: string;
  error?: string;
}

interface Revisions {
  est_current?: number;
  est_90d_ago?: number;
  revision_pct?: number;
  up_7d?: number;
  up_30d?: number;
  down_7d?: number;
  down_30d?: number;
  net_30d?: number;
  rev_growth_est?: number;
  analyst_count?: number;
}

interface RevBeat {
  rev_beat_rate?: number;
  avg_rev_growth?: number;
  quarters_checked?: number;
}

interface ShortInterest {
  short_pct_float?: number;
  days_to_cover?: number;
  squeeze?: boolean;
}

interface NewsHeadline {
  title: string;
  publisher: string;
  score: number;
}

interface NewsSentiment {
  factor_score?: number;
  label?: string;
  avg_score?: number;
  bull_count?: number;
  bear_count?: number;
  neutral_count?: number;
  total?: number;
  headlines?: NewsHeadline[];
}

interface Analysis {
  ticker: string;
  current_price: number;
  next_earnings?: string;
  recently_reported?: boolean;
  last_reported?: string;
  expected_move: ExpectedMove;
  estimated_move: number;
  history: HistoryRow[];
  stats: Stats;
  direction: Direction;
  revisions?: Revisions;
  rev_beat?: RevBeat;
  short_interest?: ShortInterest;
  news_sentiment?: NewsSentiment;
  post_earnings?: PostEarnings;
  error?: string;
}

function signalColor(signal: string) {
  if (signal.includes("BULL")) return "text-green-400";
  if (signal.includes("BEAR")) return "text-red-400";
  return "text-yellow-400";
}

function dirColor(dir: string) {
  if (dir.includes("BULL")) return "text-green-400";
  if (dir.includes("BEAR")) return "text-red-400";
  return "text-yellow-400";
}

function pctColor(v?: number | null) {
  if (v == null) return "text-muted";
  return v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted";
}

function fmt(v?: number | null, decimals = 2) {
  if (v == null) return "—";
  return v.toFixed(decimals);
}

function fmtPct(v?: number | null) {
  if (v == null) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

export default function EarningsPage() {
  const [ticker, setTicker] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState("");

  // Pre-fill ticker from URL param (?ticker=AAPL)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("ticker");
    if (t) setTicker(t.toUpperCase());
  }, []);

  async function analyze() {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await fetch(`${API}/api/earnings/${t}`);
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.detail || "Request failed");
      }
      const j = await res.json();
      setData(j);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const dir = data?.direction;
  const em = data?.expected_move;
  const stats = data?.stats;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold text-accent">Earnings Analysis</h1>

      {/* Search */}
      <div className="flex gap-2">
        <input
          className="input flex-1 max-w-xs uppercase"
          placeholder="Ticker (e.g. AAPL)"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && analyze()}
        />
        <button className="btn-primary px-6" onClick={analyze} disabled={loading}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {data && !data.error && (
        <>
          {/* Overview cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="card text-center">
              <div className="text-xs text-muted mb-1">
                {data.recently_reported ? "Last Reported" : "Next Earnings"}
              </div>
              <div className={`font-bold text-lg ${data.recently_reported ? "text-green-400" : ""}`}>
                {data.recently_reported
                  ? data.last_reported ?? "Recent"
                  : data.next_earnings ?? "Unknown"}
              </div>
              {data.recently_reported && data.next_earnings && (
                <div className="text-xs text-muted mt-0.5">Next est: {data.next_earnings}</div>
              )}
              {data.recently_reported && !data.next_earnings && (
                <div className="text-xs text-yellow-400 mt-0.5">Next date TBD</div>
              )}
            </div>
            <div className="card text-center">
              <div className="text-xs text-muted mb-1">Est. Move (blended)</div>
              <div className="font-bold text-lg text-yellow-400">±{data.estimated_move}%</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-muted mb-1">Direction Signal</div>
              <div className={`font-bold text-lg ${dirColor(dir?.direction ?? "")}`}>
                {dir?.direction ?? "—"}
              </div>
              <div className="text-xs text-muted">{dir?.confidence} ({(dir?.score ?? 0) > 0 ? "+" : ""}{dir?.score})</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-muted mb-1">Hist Avg Move</div>
              <div className="font-bold text-lg">{stats?.avg_abs_move != null ? `±${stats.avg_abs_move}%` : "—"}</div>
              <div className="text-xs text-muted">{stats?.count} quarters</div>
            </div>
          </div>

          {/* Options Implied Move */}
          {em && !em.error && !em.skipped && em.expected_move_pct != null && (
            <div className="card space-y-3">
              <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">Options-Implied Move</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-muted text-xs">Expected Move</div>
                  <div className="font-bold text-yellow-400">±{em.expected_move_pct}%</div>
                  <div className="text-muted text-xs">${em.expected_move_dollar} per share</div>
                </div>
                <div>
                  <div className="text-muted text-xs">Upside Target</div>
                  <div className="font-bold text-green-400">${em.upside_target}</div>
                </div>
                <div>
                  <div className="text-muted text-xs">Downside Target</div>
                  <div className="font-bold text-red-400">${em.downside_target}</div>
                </div>
                <div>
                  <div className="text-muted text-xs">IV Skew (C−P)</div>
                  <div className={`font-bold ${em.iv_skew != null && em.iv_skew > 0 ? "text-green-400" : em.iv_skew != null && em.iv_skew < 0 ? "text-red-400" : "text-muted"}`}>
                    {em.iv_skew != null ? (em.iv_skew > 0 ? "+" : "") + em.iv_skew + "%" : "—"}
                  </div>
                  <div className="text-muted text-xs">C:{em.call_iv}% / P:{em.put_iv}%</div>
                </div>
              </div>
              <div className="text-xs text-muted">
                Straddle: ${em.straddle_cost} | ATM {em.atm_strike} | Exp {em.exp_date} ({em.dte}d)
              </div>
            </div>
          )}
          {em?.error && (
            <div className="card text-yellow-400 text-sm">Options data unavailable: {em.error}</div>
          )}

          {/* Direction factors */}
          {dir && dir.factors.length > 0 && (
            <div className="card space-y-2">
              <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">Direction Factors</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted text-xs border-b border-slate-700">
                    <th className="text-left py-1">Factor</th>
                    <th className="text-right py-1">Value</th>
                    <th className="text-right py-1">Signal</th>
                    <th className="text-right py-1">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {dir.factors.map((f, i) => (
                    <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                      <td className="py-1.5">{f.name}</td>
                      <td className={`text-right ${signalColor(f.signal)}`}>{f.value}</td>
                      <td className={`text-right ${signalColor(f.signal)}`}>{f.signal}</td>
                      <td className={`text-right font-bold ${f.score > 0 ? "text-green-400" : f.score < 0 ? "text-red-400" : "text-muted"}`}>
                        {f.score > 0 ? "+" : ""}{f.score}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-600 font-bold">
                    <td className="py-1.5" colSpan={2}>Total Score</td>
                    <td className={`text-right ${dirColor(dir.direction)}`}>{dir.direction} ({dir.confidence})</td>
                    <td className={`text-right ${dir.score > 0 ? "text-green-400" : dir.score < 0 ? "text-red-400" : "text-muted"}`}>
                      {dir.score > 0 ? "+" : ""}{dir.score}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Short Interest */}
          {data.short_interest && data.short_interest.short_pct_float != null && (() => {
            const si = data.short_interest!;
            const pct = si.short_pct_float!;
            const pctColor = pct >= 20 ? "text-red-400" : pct >= 10 ? "text-yellow-400" : "text-green-400";
            const pctLabel = pct >= 20 ? "Very High" : pct >= 15 ? "High" : pct >= 10 ? "Elevated" : "Normal";
            return (
              <div className={`card flex items-center justify-between gap-4 ${si.squeeze ? "border border-orange-500/40" : ""}`}>
                <div>
                  <h2 className="font-semibold text-sm text-muted uppercase tracking-wider mb-1">Short Interest</h2>
                  <div className="flex items-center gap-4 flex-wrap">
                    <div>
                      <span className={`text-2xl font-bold ${pctColor}`}>{Math.round(pct)}%</span>
                      <span className="text-xs text-muted ml-1">of float</span>
                    </div>
                    {si.days_to_cover != null && (
                      <div className="text-sm">
                        <span className="text-muted text-xs">Days to cover: </span>
                        <span className={`font-semibold ${si.days_to_cover >= 5 ? "text-yellow-400" : "text-slate-300"}`}>
                          {si.days_to_cover.toFixed(1)}d
                        </span>
                      </div>
                    )}
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${pctColor} bg-slate-800`}>{pctLabel}</span>
                  </div>
                </div>
                {si.squeeze && (
                  <div className="text-center flex-shrink-0">
                    <div className="text-orange-400 text-2xl">🔥</div>
                    <div className="text-orange-400 text-xs font-bold mt-0.5">SQUEEZE RISK</div>
                    <div className="text-muted text-[10px]">high short + beat history</div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* News Sentiment */}
          {data.news_sentiment && (data.news_sentiment.total ?? 0) > 0 && (() => {
            const ns = data.news_sentiment!;
            const score = ns.factor_score ?? 0;
            const scoreColor = score >= 1 ? "text-green-400" : score <= -1 ? "text-red-400" : "text-yellow-400";
            const barBull = ns.total ? Math.round(((ns.bull_count ?? 0) / ns.total) * 100) : 0;
            const barBear = ns.total ? Math.round(((ns.bear_count ?? 0) / ns.total) * 100) : 0;
            return (
              <div className="card space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">News Sentiment (7d)</h2>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded bg-slate-800 ${scoreColor}`}>
                    {ns.label ?? "—"}
                  </span>
                </div>
                {/* Sentiment bar */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-green-400 w-6 text-right">{ns.bull_count ?? 0}↑</span>
                  <div className="flex-1 h-2 bg-slate-800 rounded overflow-hidden flex">
                    <div className="bg-green-500 h-full" style={{ width: `${barBull}%` }} />
                    <div className="bg-red-500 h-full" style={{ width: `${barBear}%` }} />
                  </div>
                  <span className="text-red-400 w-6">{ns.bear_count ?? 0}↓</span>
                  <span className="text-muted">of {ns.total} articles</span>
                </div>
                {/* Top headlines */}
                <div className="space-y-1">
                  {(ns.headlines ?? []).map((h, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className={`flex-shrink-0 font-bold w-4 text-center ${h.score > 0 ? "text-green-400" : h.score < 0 ? "text-red-400" : "text-muted"}`}>
                        {h.score > 0 ? "↑" : h.score < 0 ? "↓" : "–"}
                      </span>
                      <span className="text-slate-300 leading-snug">{h.title}</span>
                      {h.publisher && <span className="text-muted flex-shrink-0 ml-auto pl-2">{h.publisher}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Estimate Revisions + Revenue Beat */}
          {(data.revisions || data.rev_beat) && (() => {
            const rv = data.revisions ?? {};
            const rb = data.rev_beat   ?? {};
            const revPct = rv.revision_pct;
            const revColor = revPct == null ? "text-muted"
              : revPct > 2 ? "text-green-400" : revPct < -2 ? "text-red-400" : "text-yellow-400";
            return (
              <div className="card space-y-3">
                <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">Estimate Revisions & Revenue</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  {/* EPS estimate trend */}
                  <div>
                    <div className="text-xs text-muted mb-1">EPS Est (current)</div>
                    <div className="font-bold">{rv.est_current != null ? `$${rv.est_current}` : "—"}</div>
                    <div className="text-xs text-muted">90d ago: {rv.est_90d_ago != null ? `$${rv.est_90d_ago}` : "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-1">90-Day Revision</div>
                    <div className={`font-bold text-lg ${revColor}`}>
                      {revPct != null ? (revPct > 0 ? "+" : "") + revPct + "%" : "—"}
                    </div>
                    <div className="text-xs text-muted">
                      {rv.analyst_count != null ? `${rv.analyst_count} analysts` : ""}
                    </div>
                  </div>
                  {/* Analyst upgrades/downgrades */}
                  <div>
                    <div className="text-xs text-muted mb-1">Revisions (30d)</div>
                    <div className="flex gap-3 items-center mt-0.5">
                      <span className="text-green-400 font-bold">↑{rv.up_30d ?? 0}</span>
                      <span className="text-red-400 font-bold">↓{rv.down_30d ?? 0}</span>
                      <span className={`font-bold text-xs ${(rv.net_30d ?? 0) > 0 ? "text-green-400" : (rv.net_30d ?? 0) < 0 ? "text-red-400" : "text-muted"}`}>
                        net {(rv.net_30d ?? 0) > 0 ? "+" : ""}{rv.net_30d ?? 0}
                      </span>
                    </div>
                    <div className="text-xs text-muted mt-1">7d: ↑{rv.up_7d ?? 0} ↓{rv.down_7d ?? 0}</div>
                  </div>
                  {/* Revenue */}
                  <div>
                    <div className="text-xs text-muted mb-1">Revenue</div>
                    {rb.rev_beat_rate != null && (
                      <div className={`font-bold ${rb.rev_beat_rate >= 70 ? "text-green-400" : rb.rev_beat_rate >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                        {rb.rev_beat_rate}% beat rate
                      </div>
                    )}
                    {rb.avg_rev_growth != null && (
                      <div className={`text-xs mt-0.5 ${rb.avg_rev_growth > 0 ? "text-green-400" : "text-red-400"}`}>
                        avg {rb.avg_rev_growth > 0 ? "+" : ""}{rb.avg_rev_growth}% YoY ({rb.quarters_checked}q)
                      </div>
                    )}
                    {rv.rev_growth_est != null && (
                      <div className="text-xs text-muted mt-0.5">
                        fwd est: {rv.rev_growth_est > 0 ? "+" : ""}{rv.rev_growth_est}%
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Post-earnings analysis — shown when earnings just happened */}
          {data.post_earnings && !data.post_earnings.error && (() => {
            const pe = data.post_earnings!;
            return (
              <div className="card space-y-4 border border-yellow-500/30 bg-yellow-950/10">
                <div className="flex items-center gap-2">
                  <span className="text-yellow-400 font-bold text-sm uppercase tracking-wider">Post-Earnings Analysis</span>
                  <span className="text-xs text-muted">reported {pe.earnings_date}</span>
                </div>

                {/* What happened row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-muted">Gap</div>
                    <div className={`font-bold text-lg ${pctColor(pe.gap_pct)}`}>{fmtPct(pe.gap_pct)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Day Move</div>
                    <div className={`font-bold text-lg ${pctColor(pe.day_pct)}`}>{fmtPct(pe.day_pct)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">EPS Surprise</div>
                    <div className={`font-bold text-lg ${pctColor(pe.eps_surprise)}`}>
                      {pe.eps_surprise != null ? fmtPct(pe.eps_surprise) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Reaction</div>
                    <div className={`font-semibold ${pctColor(pe.day_pct)}`}>{pe.reaction}</div>
                  </div>
                </div>

                {/* Why */}
                <div className="text-sm">
                  <span className="text-muted text-xs uppercase tracking-wider mr-2">Why:</span>
                  <span className="text-white">{pe.why}</span>
                </div>

                {/* Next move signal */}
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted uppercase tracking-wider">Next 5-Day Signal</span>
                    <span className={`font-bold ${dirColor(pe.next_move_direction)}`}>{pe.next_move_direction}</span>
                    <span className="text-xs text-muted">{pe.next_move_confidence} (score {pe.next_move_score > 0 ? "+" : ""}{pe.next_move_score})</span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {pe.factors.map((f, i) => (
                        <tr key={i} className="border-b border-slate-800">
                          <td className="py-1 pr-3 text-muted">{f.name}</td>
                          <td className={`pr-3 ${f.score > 0 ? "text-green-400" : f.score < 0 ? "text-red-400" : "text-muted"}`}>{f.value}</td>
                          <td className="text-muted italic">{f.signal}</td>
                          <td className={`text-right font-bold ${f.score > 0 ? "text-green-400" : f.score < 0 ? "text-red-400" : "text-muted"}`}>
                            {f.score > 0 ? "+" : ""}{f.score}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* IV note + suggested play */}
                <div className="space-y-1 text-sm">
                  <div className="text-xs text-blue-400">{pe.iv_note}</div>
                  <div className="bg-slate-800/60 rounded p-3">
                    <span className="text-xs text-muted uppercase tracking-wider mr-2">Suggested Play:</span>
                    <span className="text-white">{pe.suggested_play}</span>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Historical stats */}
          {stats && Object.keys(stats).length > 0 && (
            <div className="card space-y-3">
              <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">Historical Stats</h2>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 text-sm">
                {[
                  { label: "Bull Rate", val: stats.bull_rate != null ? stats.bull_rate + "%" : "—", color: dirColor("BULL") },
                  { label: "Beat Rate", val: stats.beat_rate != null ? stats.beat_rate + "%" : "—" },
                  { label: "Beat→Up", val: stats.beat_then_up_rate != null ? stats.beat_then_up_rate + "%" : "—", color: "text-green-400" },
                  { label: "Avg Move", val: stats.avg_abs_move != null ? "±" + stats.avg_abs_move + "%" : "—" },
                  { label: "Last 4 Avg", val: stats.last4_avg_move != null ? "±" + stats.last4_avg_move + "%" : "—", color: "text-yellow-400" },
                  { label: "Avg 5d Drift", val: stats.avg_5d_drift != null ? fmtPct(stats.avg_5d_drift) : "—", color: pctColor(stats.avg_5d_drift) },
                  { label: "Max Move", val: stats.max_move != null ? "±" + stats.max_move + "%" : "—" },
                ].map((s, i) => (
                  <div key={i} className="text-center">
                    <div className="text-muted text-xs">{s.label}</div>
                    <div className={`font-bold ${s.color ?? ""}`}>{s.val}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Earnings history table */}
          {data.history && data.history.length > 0 && (
            <div className="card space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm text-muted uppercase tracking-wider">Earnings History (last 8)</h2>
                <button
                  onClick={() => downloadCsv(
                    `${data.ticker}_earnings_history.csv`,
                    ["Date","EPS Est","EPS Actual","Surprise%","Prev Close","Earn Open","Earn Close","Gap%","Day%","5d Drift","Direction"],
                    [...data.history].reverse().map(h => [h.date, h.eps_estimate, h.eps_actual, h.surprise_pct, h.prev_close, h.earn_open, h.earn_close, h.gap_pct, h.day_pct, h.five_day_pct, h.direction])
                  )}
                  className="px-3 py-1 text-xs rounded-lg border border-border text-muted hover:text-white hover:border-white/20 transition-colors"
                >
                  ⬇ CSV
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs whitespace-nowrap">
                  <thead>
                    <tr className="text-muted border-b border-slate-700">
                      <th className="text-left py-1 pr-3">Date</th>
                      <th className="text-right pr-3">EPS Est</th>
                      <th className="text-right pr-3">Actual</th>
                      <th className="text-right pr-3">Surprise</th>
                      <th className="text-right pr-3">Gap%</th>
                      <th className="text-right pr-3">Day%</th>
                      <th className="text-right pr-3">5d Drift</th>
                      <th className="text-right">Dir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.history].reverse().map((h, i) => (
                      <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                        <td className="py-1 pr-3">{h.date}</td>
                        <td className="text-right pr-3 text-muted">{fmt(h.eps_estimate)}</td>
                        <td className="text-right pr-3">{fmt(h.eps_actual)}</td>
                        <td className={`text-right pr-3 ${pctColor(h.surprise_pct)}`}>{fmtPct(h.surprise_pct)}</td>
                        <td className={`text-right pr-3 ${pctColor(h.gap_pct)}`}>{fmtPct(h.gap_pct)}</td>
                        <td className={`text-right pr-3 font-semibold ${pctColor(h.day_pct)}`}>{fmtPct(h.day_pct)}</td>
                        <td className={`text-right pr-3 ${pctColor(h.five_day_pct)}`}>{fmtPct(h.five_day_pct)}</td>
                        <td className={`text-right font-bold ${h.direction === "UP" ? "text-green-400" : h.direction === "DOWN" ? "text-red-400" : "text-muted"}`}>
                          {h.direction ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <EarningsBacktestPanel ticker={data.ticker} />

          {/* Link to full analysis */}
          <div className="text-center">
            <a href={`/stock/${data.ticker}`} className="text-accent hover:underline text-sm">
              View full analysis for {data.ticker} →
            </a>
          </div>
        </>
      )}

      {data?.error && <p className="text-red-400">{data.error}</p>}
    </div>
  );
}
