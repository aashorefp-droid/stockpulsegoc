"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { downloadCsv } from "@/lib/csv";
import { interpretOtmFlow } from "@/lib/optionsFlow";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const WATCHLISTS = [
  { key: "default",       label: "Default 50",       count: 50  },
  { key: "tech",          label: "Tech 30",           count: 30  },
  { key: "mega_cap",      label: "Mega Cap 20",       count: 20  },
  { key: "momentum",      label: "Momentum 20",       count: 20  },
  { key: "etfs",          label: "ETFs 56",           count: 56  },
  { key: "earnings",      label: "Earnings",           count: 15  },
  { key: "short_squeeze", label: "🔥 Short Squeeze",  count: 40  },
  { key: "telegram",      label: "📧 TOS Scan (Sat)", count: 25 },
  { key: "holdings",      label: "Holdings",           count: 0   },
  { key: "nyse_swing",    label: "🏛 NYSE Swing >$10", count: 200 },
  { key: "nasdaq_swing",  label: "💻 NASDAQ Swing >$10", count: 200 },
  { key: "custom",        label: "Custom",            count: 0   },
];

type Filter = "all" | "actionable" | "rank1" | "exceptional" | "high_short" | "day_spring" | "lt_spring" | "w30ma_curl" | "sweep_reclaim_long" | "sweep_reclaim_short" | "breakout" | "prebreakout" | "quality_long" | "btd" | "btd_trigger" | "speculative" | "news_good" | "news_bad";

const isBtdLive = (s?: string) => s === "TRIGGER" || s === "ARMED" || s === "ARMED-DEEP";
type SortBy = "score" | "grade" | "rr" | "swingReward" | "fibReward" | "dayReward" | "ltEntryPct" | "valuation" | "longRunway" | "cyclicalPeak" | "multiBagger" | "newsGood" | "newsBad";
type ScannerMode = "overview" | "swing" | "longterm" | "fib" | "daytrading" | "options" | "snapshots";

const SCANNER_MODES: { key: ScannerMode; label: string; title: string; sort: SortBy }[] = [
  { key: "overview",   label: "Overview",  title: "Full scanner with every column group", sort: "score" },
  { key: "swing",      label: "Swing",     title: "Swing entries, PreBO, BTD Trigger, EMAs", sort: "swingReward" },
  { key: "longterm",   label: "Long Term", title: "Long-term setup, valuation, fundamentals", sort: "valuation" },
  { key: "fib",        label: "Fib",       title: "Fib target, ladders, earnings swing zones", sort: "fibReward" },
  { key: "daytrading", label: "Day V4",    title: "CPR, next-day, and Day Trading V4 plans", sort: "dayReward" },
  { key: "options",    label: "Options",   title: "Options strategy and OTM liquidity", sort: "score" },
  { key: "snapshots",  label: "Snapshots", title: "Save, load, and delete persistent scanner snapshots", sort: "score" },
];

type Seasonality = {
  available?: boolean;
  month_name?: string | null;
  avg_pct?: number | null;
  median_pct?: number | null;
  win_rate?: number | null;
  years?: number;
  best_pct?: number | null;
  worst_pct?: number | null;
  month?: number | null;
  reason?: string;
  months?: { m: number; name: string; avg_pct: number | null; win_rate: number | null; years: number }[];
};

const SORT_OPTIONS: { key: SortBy; label: string; title?: string }[] = [
  { key: "score",       label: "Score" },
  { key: "grade",       label: "Grade" },
  { key: "rr",          label: "R/R" },
  { key: "swingReward", label: "Swing Reward%", title: "Sort by Swing target reward percent" },
  { key: "fibReward",   label: "Fib Reward%",   title: "Sort by Fibonacci target reward percent" },
  { key: "dayReward",   label: "Day Reward%",   title: "Sort by Day Trading target reward percent" },
  { key: "ltEntryPct",  label: "LT Entry%",     title: "Sort by Long Term distance from entry" },
  { key: "valuation",   label: "Valuation",     title: "Sort by Long Term valuation estimate" },
  { key: "longRunway",  label: "Long Runway",   title: "Long Runway candidates first" },
  { key: "cyclicalPeak",label: "Cyclical Peak", title: "Cyclical Peak risk first" },
  { key: "multiBagger", label: "Multi-Bagger",  title: "Speculative multi-bagger candidates first" },
  { key: "newsGood",    label: "Good News ↓",   title: "Net news score (good − bad), most positive first" },
  { key: "newsBad",     label: "Bad News ↓",    title: "Net news score (good − bad), most negative first" },
];

const newsNet = (r: { news_good?: number | null; news_bad?: number | null }) =>
  (r.news_good ?? 0) - (r.news_bad ?? 0);

interface OptLeg {
  action:     string;
  type:       string;
  strike:     number;
  exp:        string;
  bid:        number;
  ask:        number;
  mid:        number;
  spread_pct?: number | null;
}

interface MacroItem {
  ticker:   string;
  label:    string;
  category: string;
  chg_1d:   number;
}

interface ScanResult {
  ticker:        string;
  sector?:       string;
  price?:        number;
  verdict?:      string;
  verdict_flip_date?: string | null;
  verdict_flip_from?: string | null;
  verdict_flip_days?: number | null;
  verdict_flip_text?: string | null;
  confidence?:   string;
  score?:        number;
  direction?:    string;
  entry_grade?:  string;
  entry_label?:  string;
  grade_color?:  string;
  expected_wr?:  number;
  mtf_rank?:     number;
  mtf_signal?:   string;
  mtf_action?:   string;
  mtf_key?:      string;
  weekly_bias?:  string;
  daily_bias?:   string;
  long_term_spring?: boolean;
  long_term_spring_text?: string;
  swing_spring?: boolean;
  swing_spring_text?: string;
  day_spring?: boolean;
  day_spring_text?: string;
  vol_trend?:    string;
  earn_zone?:    string;
  weekly_zone?:  string;
  near_fib_name?: string;
  near_fib_price?: number;
  fib_compression?: boolean;
  fib_target?: number | null;
  fib_target_name?: string | null;
  fib_target_reward_pct?: number | null;
  fib_target_ladder?: { kind: string; label: string; price: number; reward_pct?: number | null }[] | null;
  fib_reclaim_ladder?: { kind: string; label: string; price: number; reward_pct?: number | null }[] | null;
  fib_target_source?: string | null;
  fib_pos_pct?: number | null;
  fib_swing_low?: number | null;
  fib_swing_high?: number | null;
  fib_swing_range?: number | null;
  fib_earn_window?: string | null;
  fib_prev_earnings?: string | null;
  fib_last_earnings?: string | null;
  fib_next_earnings?: string | null;
  fib_commentary?: string | null;
  weekly_pos_pct?: number | null;
  weekly_fib_low?: number | null;
  weekly_fib_high?: number | null;
  signals?:      string;
  valuation_label?: string;
  valuation_score?: number;
  valuation_reason?: string;
  valuation_fair_value?: number | null;
  valuation_upside_pct?: number | null;
  valuation_source?: string;
  valuation_pe_fair_value?: number | null;
  valuation_pe_upside_pct?: number | null;
  valuation_pe_source?: string;
  valuation_analyst_fair_value?: number | null;
  valuation_analyst_upside_pct?: number | null;
  cyclical_peak_risk?: boolean;
  cyclical_peak_reason?: string;
  long_runway?: boolean;
  long_runway_reason?: string;
  multi_bagger?: boolean;
  multi_bagger_reason?: string;
  cpr_type?:     string;
  cpr_tc?:       number;
  cpr_bc?:       number;
  cpr_p?:        number;
  cpr_position?: string;
  cpr_interpretation?: string;
  cpr_day_result?: string;
  cpr_day_entry?: number | null;
  cpr_day_stop?:  number | null;
  cpr_day_t1?:    number | null;
  cpr_day_trigger_text?: string;
  cpr_day_invalidation_text?: string;
  cpr_day_target_text?: string;
  cpr_day_volume_text?: string;
  cpr_day_15m_volume_text?: string;
  cpr_day_15m_volume_ratio?: number | null;
  cpr_day_15m_volume_surge?: boolean;
  cpr_day_ref?: string;
  // ── Multi-timeframe S/R for the SWING column ────────────────────────────
  prev_week_high?:  number | null;
  prev_week_low?:   number | null;
  prev_month_high?: number | null;
  prev_month_low?:  number | null;
  wk52_high?:       number | null;
  wk52_low?:        number | null;
  // V4 day-trading: PDH/PWH/PDL/PWL plan engine
  dt4_enabled?: boolean | null;
  dt4_setup?: string | null;
  dt4_context?: string | null;
  dt4_side?: string | null;
  dt4_bias?: string | null;
  dt4_grade?: string | null;
  dt4_level?: string | null;
  dt4_level_val?: number | null;
  dt4_entry?: number | null;
  dt4_stop?: number | null;
  dt4_t1?: number | null;
  dt4_t2?: number | null;
  dt4_rr?: number | null;
  dt4_trigger?: string | null;
  dt4_invalidation?: string | null;
  dt4_target_plan?: string | null;
  dt4_exit_plan?: string | null;
  dt4_note?: string | null;
  dt4_pdh?: number | null;
  dt4_pdl?: number | null;
  dt4_pwh?: number | null;
  dt4_pwl?: number | null;
  dt4_atr?: number | null;
  // ── V3 day-trading: PDH/PWH/PDL/PWL setup engine ────────────────────────
  dt3_setup?:     string | null;   // "sweep_reclaim" | "break_retest" | "no_setup"
  dt3_side?:      string | null;   // "long" | "short"
  dt3_grade?:     string | null;   // "A+" | "A" | "B" | ...
  dt3_level?:     string | null;   // "PWH" | "PDH" | "PWL" | "PDL"
  dt3_level_val?: number | null;
  dt3_entry?:     number | null;
  dt3_stop?:      number | null;
  dt3_t1?:        number | null;
  dt3_t2?:        number | null;
  dt3_rr?:        number | null;
  dt3_rationale?: string | null;
  dt3_pdh?:       number | null;
  dt3_pdl?:       number | null;
  dt3_pwh?:       number | null;
  dt3_pwl?:       number | null;
  next_day_date?: string;
  next_day_outcome?: string;
  next_day_bias?: string;
  next_day_summary?: string;
  next_day_prediction?: string;
  next_day_open?: number | null;
  next_day_ref?: string;
  next_day_target?: number | null;
  next_day_atr?: number | null;
  next_day_atr_pct?: number | null;
  next_day_trigger_up?: number | null;
  next_day_trigger_down?: number | null;
  next_day_pivot?: number | null;
  prev_day_high?: number | null;
  prev_day_low?: number | null;
  exp_move_up?:   number;
  exp_move_down?: number;
  exp_move_pct?:  number;
  exp_move_open_up?:  number;
  exp_move_open_dn?:  number;
  exp_move_open_pct?: number;
  day_open?: number;
  lre_score?:     number;
  lre_label?:     string;
  lre_direction?: string;
  lre_reason?:    string;
  lre_entry?:     number;
  lre_stop?:      number;
  lre_risk_pct?:  number;
  lre_status?:    string;
  lre_takeaway?:  string;
  vol_surge?:    boolean;
  breakout_score?: number;
  swing_prebreakout?: boolean;
  swing_prebreakout_score?: number | null;
  swing_prebreakout_level?: number | null;
  swing_prebreakout_dist_pct?: number | null;
  swing_prebreakout_trigger?: string | null;
  swing_prebreakout_invalidation?: string | null;
  swing_prebreakout_reason?: string | null;
  btd_trigger?: boolean;
  btd_trigger_text?: string | null;
  dist_from_high?: number;
  entry?:        number;
  stop_loss?:    number;
  target1?:      number;
  target2?:      number;
  t1_days?:      number | null;
  t1_days_min?:  number | null;
  t1_days_max?:  number | null;
  t1_days_text?: string | null;
  t1_days_basis?: string | null;
  t2_days?:      number | null;
  t2_days_min?:  number | null;
  t2_days_max?:  number | null;
  t2_days_text?: string | null;
  t2_days_basis?: string | null;
  risk_pct?:     number;
  rr_t1?:        number;
  atr?:          number;
  swing_invalidation?:      number | null;
  swing_invalidation_text?: string | null;
  short_pct?:    number | null;
  opt_strategy?:  string | null;
  opt_summary?:   string | null;
  opt_debit?:     number | null;
  opt_profit?:    number | null;
  opt_source?:    string | null;
  opt_quote_ts?:  string | null;
  opt_legs?:      OptLeg[] | null;
  opt_width?:     number | null;
  opt_exp_short?: string | null;
  opt_exp_long?:  string | null;
  opt_alt?:       string | null;
  opt_liquid?:    { strike: number; type: string; expiry: string; volume: number; oi: number; iv: number; otm_pct: number; vol_oi_ratio: number; unusual: boolean }[] | null;
  btd_state?:     string;
  btd_zone?:      string | null;
  btd_reason?:    string | null;
  btd_size?:      string | null;
  ema11?:         number | null;
  ema20?:         number | null;
  ema50?:         number | null;
  ema200?:        number | null;
  ema50_slope_pct?: number | null;
  w30ma?:         number | null;
  w30ma_curl?:    boolean;
  w30ma_slope_pct?: number | null;
  w30ma_reason?:  string | null;
  wk_atr?:        number | null;
  wk_atr_pct?:    number | null;
  news?:          string | null;
  news_good?:     number | null;
  news_bad?:      number | null;
  news_headlines?: { h: string; s: string; src?: string; t?: string }[] | null;
  next_earnings?: string | null;
  bt_next_date?:     string | null;
  bt_next_close?:    number | null;
  bt_next_chg_pct?:  number | null;
  bt_next_positive?: boolean | null;
  bt_scan_date?:     string | null;
  bt_swing_outcome?: string | null;
  bt_swing_r?:       number | null;
  bt_swing_bars?:    number | null;
  error?:         string | null;
  done?:         boolean;
  total?:        number;
}

type SnapshotMeta = {
  watchlist: string;
  date: string;
  created_at?: string | null;
  count: number;
};

type EarningsPlaceholderRow = {
  date: string;
  ticker: string;
  source?: string;
  created_at?: string | null;
  expires_at?: string | null;
};

const verdictColor: Record<string, string> = {
  "BULLISH":      "text-green",
  "LEAN BULLISH": "text-green/70",
  "BEARISH":      "text-red",
  "LEAN BEARISH": "text-red/70",
  "NEUTRAL":      "text-muted",
};

const biasColor: Record<string, string> = {
  BULLISH: "text-green", BEARISH: "text-red", NEUTRAL: "text-muted",
};

const gradeColor: Record<string, string> = {
  S: "bg-green/20 text-green border-green/30",
  A: "bg-green/10 text-green border-green/20",
  B: "bg-accent/10 text-accent border-accent/20",
  "B-": "bg-accent/5 text-accent border-accent/10",
  C: "bg-yellow/10 text-yellow border-yellow/20",
  D: "bg-red/5 text-muted border-border",
};

function Badge({ text, color }: { text: string; color: string }) {
  return <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border ${color}`}>{text}</span>;
}

function SpringMarker({ title }: { title?: string }) {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-green/40 bg-green/10 text-[10px] leading-none text-green cursor-help"
      title={title || "Spring action"}
      aria-label={title || "Spring action"}
    >
      {"\u{1F331}"}
    </span>
  );
}

function fundamentalStyle(signal: string) {
  const s = signal.toLowerCase();
  if (
    s.includes("declining") ||
    s.includes("unprofitable") ||
    s.includes("high debt") ||
    s.includes("negative cash flow")
  ) {
    return {
      color: "#ff4d4f",
      borderColor: "rgba(255, 77, 79, 0.35)",
      backgroundColor: "rgba(255, 77, 79, 0.10)",
    };
  }
  if (
    s.includes("strong earnings") ||
    s.includes("high margins") ||
    s.includes("good dividend") ||
    s.includes("low debt") ||
    s.includes("positive cash flow") ||
    s.includes("near 52w high")
  ) {
    return {
      color: "#00e5a0",
      borderColor: "rgba(0, 229, 160, 0.35)",
      backgroundColor: "rgba(0, 229, 160, 0.10)",
    };
  }
  return {
    color: "#f5c842",
    borderColor: "rgba(245, 200, 66, 0.35)",
    backgroundColor: "rgba(245, 200, 66, 0.10)",
  };
}

function fundamentalChipStyle(signal: string) {
  const style = fundamentalStyle(signal);
  return {
    color: style.color,
    borderColor: style.borderColor,
    backgroundColor: style.backgroundColor,
  };
}

function valuationClass(label?: string): string {
  if (!label) return "border-border text-muted";
  if (label === "Undervalued" || label === "Attractive") return "border-green/30 bg-green/10 text-green";
  if (label === "Expensive" || label === "Overvalued") return "border-red/30 bg-red/10 text-red";
  return "border-yellow/30 bg-yellow/10 text-yellow";
}

function valuationSortValue(r: ScanResult): number {
  if (typeof r.valuation_score === "number" && Number.isFinite(r.valuation_score)) {
    return r.valuation_score;
  }
  const label = (r.valuation_label ?? "").toLowerCase();
  if (label.includes("undervalued") || label.includes("attractive")) return 4;
  if (label.includes("fair")) return 1;
  if (label.includes("expensive")) return -2;
  if (label.includes("overvalued")) return -4;
  return -999;
}

function valuationFairValue(r: ScanResult): number | null {
  if (typeof r.valuation_fair_value === "number" && Number.isFinite(r.valuation_fair_value)) {
    return r.valuation_fair_value;
  }
  if (typeof r.price === "number" && Number.isFinite(r.price) && typeof r.valuation_score === "number" && Number.isFinite(r.valuation_score)) {
    const impliedPct = Math.max(-0.30, Math.min(0.30, r.valuation_score * 0.06));
    return Number((r.price * (1 + impliedPct)).toFixed(2));
  }
  return null;
}

function valuationUpsidePct(r: ScanResult): number | null {
  if (typeof r.valuation_upside_pct === "number" && Number.isFinite(r.valuation_upside_pct)) {
    return r.valuation_upside_pct;
  }
  const fv = valuationFairValue(r);
  if (fv != null && typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0) {
    return Number((((fv - r.price) / r.price) * 100).toFixed(1));
  }
  return null;
}

function fmtMoney(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value}` : "—";
}

function fmtSignedPct(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "—";
}

function compactDayResult(value?: string): string {
  if (!value) return "—";
  return value
    .replace("Above CPR; pullback risk", "Above CPR")
    .replace("Below CPR; bounce risk", "Below CPR")
    .replace("Bullish above TC", "Bullish")
    .replace("Bearish below BC", "Bearish")
    .replace("Inside CPR; wait", "Wait")
    .replace("Trend up", "Trend Up")
    .replace("Trend down", "Trend Down");
}

function nextDayColor(bias?: string): string {
  if (!bias) return "text-muted";
  if (bias.includes("Above") || bias.includes("Bullish")) return "text-green";
  if (bias.includes("Below") || bias.includes("Bearish")) return "text-red";
  return "text-yellow";
}

function dayVolumeColor(value?: string): string {
  if (!value) return "text-muted";
  if (value.startsWith("Confirmed") || value.startsWith("Supportive") || value.startsWith("15m Surge") || value.startsWith("15m Active")) return "text-green";
  if (value.startsWith("Caution") || value.startsWith("15m Light")) return "text-red";
  return "text-yellow";
}

function hasPending15mVolume(r: ScanResult): boolean {
  const text = (r.cpr_day_15m_volume_text ?? "").toLowerCase();
  return !!r.ticker && !!r.cpr_day_result && (!text || text.startsWith("15m pending"));
}

function inOpeningVolumeRefreshWindow(): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    const weekday = get("weekday");
    if (weekday === "Sat" || weekday === "Sun") return false;
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins <= 10 * 60 + 30;
  } catch {
    return false;
  }
}

// V3 detectors can only fire inside two windows (matching day_trading/v3.py):
//   09:50–11:00 ET (morning) and 13:30–15:30 ET (afternoon).
// Outside these, polling is pointless — the engine returns no_setup by design.
function inV3TradeWindow(): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    const weekday = get("weekday");
    if (weekday === "Sat" || weekday === "Sun") return false;
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const mins = hour * 60 + minute;
    const morning   = mins >= 9 * 60 + 50  && mins <= 11 * 60;
    const afternoon = mins >= 13 * 60 + 30 && mins <= 15 * 60 + 30;
    return morning || afternoon;
  } catch {
    return false;
  }
}

function lreRangeText(r: ScanResult): string {
  if (r.lre_entry == null || r.lre_stop == null) return "—";
  const lo = Math.min(r.lre_entry, r.lre_stop);
  const hi = Math.max(r.lre_entry, r.lre_stop);
  return `${fmtMoney(lo)}-${fmtMoney(hi)}`;
}

function rewardPct(entry?: number | null, target?: number | null): string {
  if (!entry || !target || entry <= 0) return "—";
  return `${(Math.abs(target - entry) / entry * 100).toFixed(2)}%`;
}

function approxDays(days?: number | null, text?: string | null): string {
  if (text) return text;
  if (days == null || !Number.isFinite(days) || days <= 0) return "—";
  return `~${Math.round(days)}d`;
}

function targetLadderText(r: ScanResult, maxItems = 6): string {
  return ladderText(r.fib_target_ladder, maxItems);
}

function ladderText(
  ladder?: { kind: string; label: string; price: number; reward_pct?: number | null }[] | null,
  maxItems = 6,
): string {
  const rows = (ladder ?? [])
    .filter(x => typeof x.price === "number" && Number.isFinite(x.price))
    .slice(0, maxItems);
  if (!rows.length) return "";
  return rows.map(x => {
    const label = x.kind === "Fib" && x.label ? x.label : "round";
    const reward = x.reward_pct != null ? `, ${x.reward_pct.toFixed(2)}%` : "";
    return `${fmtMoney(x.price)} (${label}${reward})`;
  }).join(" / ");
}

function fibDetailText(r: ScanResult): string {
  const reward = r.fib_target_reward_pct != null
    ? `${r.fib_target_reward_pct.toFixed(2)}%`
    : rewardPct(r.price, r.fib_target);
  const targetLevels = targetLadderText(r);
  const reclaimLevels = ladderText(r.fib_reclaim_ladder, 4);
  return [
    `${r.ticker} - Fibonacci Target`,
    "",
    `Price: ${fmtMoney(r.price)}`,
    r.direction ? `Direction: ${r.direction}` : null,
    `Target: ${fmtMoney(r.fib_target)}`,
    `Target level: ${r.fib_target_name ?? "-"}`,
    `Reward: ${reward}`,
    targetLevels ? `Fib target ladder: ${targetLevels}` : null,
    reclaimLevels ? `${r.direction === "SHORT" ? "Reclaim levels" : "Rejection levels"}: ${reclaimLevels}` : null,
    r.near_fib_name && r.near_fib_price != null
      ? `Nearest Fib: ${r.near_fib_name} ${fmtMoney(r.near_fib_price)}`
      : null,
    r.fib_swing_low != null && r.fib_swing_high != null
      ? `Swing range: ${fmtMoney(r.fib_swing_low)} to ${fmtMoney(r.fib_swing_high)}`
      : null,
    r.fib_swing_range != null ? `Swing size: ${fmtMoney(r.fib_swing_range)}` : null,
    r.fib_pos_pct != null ? `Swing position: ${r.fib_pos_pct}%` : null,
    r.weekly_pos_pct != null ? `Weekly position: ${r.weekly_pos_pct}%` : null,
    r.earn_zone ? `Earnings zone: ${r.earn_zone}` : null,
    r.weekly_zone ? `Weekly zone: ${r.weekly_zone}` : null,
    r.fib_target_source ? `Source: ${r.fib_target_source}` : null,
    r.fib_earn_window ? `Earnings window: ${r.fib_earn_window}` : null,
    r.fib_prev_earnings ? `Prev earnings: ${r.fib_prev_earnings}` : null,
    r.fib_last_earnings ? `Last earnings: ${r.fib_last_earnings}` : null,
    r.fib_next_earnings ? `Next earnings: ${r.fib_next_earnings}` : null,
    r.fib_compression ? "Fib compression: Yes" : null,
    r.fib_commentary ? "" : null,
    r.fib_commentary,
  ].filter((v): v is string => typeof v === "string").join("\n");
}

function hasV4Plan(r: ScanResult): boolean {
  return r.dt4_enabled !== false && !!r.dt4_setup && r.dt4_setup !== "disabled";
}

function dt4ScenarioText(r: ScanResult): string | null {
  if (r.dt4_setup !== "range_wait") return null;
  return [
    `Long scenario: sweep below PDL ${fmtMoney(r.dt4_pdl)} or PWL ${fmtMoney(r.dt4_pwl)}; then 5m close back above the swept level + retest hold.`,
    `Short scenario: sweep above PDH ${fmtMoney(r.dt4_pdh)} or PWH ${fmtMoney(r.dt4_pwh)}; then 5m close back below the swept level + failed retest.`,
  ].join("\n");
}

function dt4DetailText(r: ScanResult): string {
  const rangeWait = r.dt4_setup === "range_wait";
  const scenario = dt4ScenarioText(r);
  return [
    `${r.ticker} - Day Trading V4`,
    "",
    `Price: ${fmtMoney(r.price)}`,
    `Context: ${r.dt4_context ?? "-"}`,
    `Setup: ${r.dt4_setup ? r.dt4_setup.replaceAll("_", " ") : "-"}`,
    `Side: ${r.dt4_side ?? "-"}`,
    `Bias: ${r.dt4_bias ?? "-"}`,
    `Grade: ${r.dt4_grade ?? "-"}`,
    "",
    rangeWait
      ? `Support: PDL ${fmtMoney(r.dt4_pdl)} / PWL ${fmtMoney(r.dt4_pwl)}`
      : `Level: ${r.dt4_level ?? "-"} ${fmtMoney(r.dt4_level_val)}`,
    rangeWait
      ? `Resistance: PDH ${fmtMoney(r.dt4_pdh)} / PWH ${fmtMoney(r.dt4_pwh)}`
      : `Watch/Entry: ${fmtMoney(r.dt4_entry)}`,
    rangeWait ? "Entry: wait for reclaim/reject trigger" : `Stop: ${fmtMoney(r.dt4_stop)}`,
    rangeWait ? "Risk: after trigger" : `T1: ${fmtMoney(r.dt4_t1)}`,
    !rangeWait && r.dt4_t2 != null ? `T2: ${fmtMoney(r.dt4_t2)}` : null,
    rangeWait ? "Target plan: VWAP/mid, then opposite edge" : `R/R: ${r.dt4_rr != null ? `${r.dt4_rr}x` : "-"}`,
    "",
    r.dt4_trigger ? `Trigger: ${r.dt4_trigger}` : null,
    r.dt4_invalidation ? `Invalidation: ${r.dt4_invalidation}` : null,
    r.dt4_target_plan ? `Target plan: ${r.dt4_target_plan}` : null,
    r.dt4_exit_plan ? `Exit plan: ${r.dt4_exit_plan}` : null,
    r.dt4_note ? `Note: ${r.dt4_note}` : null,
    scenario ? "" : null,
    scenario,
    "",
    `PDH: ${fmtMoney(r.dt4_pdh)}`,
    `PDL: ${fmtMoney(r.dt4_pdl)}`,
    `PWH: ${fmtMoney(r.dt4_pwh)}`,
    `PWL: ${fmtMoney(r.dt4_pwl)}`,
    `ATR: ${fmtMoney(r.dt4_atr)}`,
  ].filter((v): v is string => typeof v === "string").join("\n");
}

function fmtEarnings(d?: string | null): { text: string; days: number | null; soon: boolean } | null {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  if (isNaN(dt.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((dt.getTime() - today.getTime()) / 86_400_000);
  const md = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const rel = days < 0 ? `${-days}d ago` : days === 0 ? "today" : `${days}d`;
  return { text: `${md} · ${rel}`, days, soon: days >= 0 && days <= 7 };
}

function rewardPctValue(entry?: number | null, target?: number | null): number {
  if (!entry || !target || entry <= 0) return 0;
  return Math.abs(target - entry) / entry * 100;
}

function longTermFromEntryPctValue(r: ScanResult): number {
  if (!r.lre_entry || !r.price || r.lre_entry <= 0) return 0;
  return Math.abs((r.price - r.lre_entry) / r.lre_entry * 100);
}

function sectorTone(chg1d: number) {
  if (chg1d >= 0.25) return { label: "Green", dot: "bg-green", text: "text-green", border: "border-green/40", bg: "bg-green/10" };
  if (chg1d <= -0.25) return { label: "Red", dot: "bg-red", text: "text-red", border: "border-red/40", bg: "bg-red/10" };
  return { label: "Yellow", dot: "bg-yellow", text: "text-yellow", border: "border-yellow/40", bg: "bg-yellow/10" };
}

function sectorMacroKey(sector?: string): string | null {
  const s = (sector ?? "").toLowerCase();
  if (!s || s === "unknown") return null;
  if (s.includes("material") || s.includes("basic")) return "Materials";
  if (s.includes("communication") || s.includes("comm") || s.includes("telecom")) return "Comm";
  if (s.includes("energy") || s.includes("oil")) return "Energy";
  if (s.includes("financial") || s.includes("bank")) return "Financials";
  if (s.includes("industrial")) return "Industrials";
  if (s.includes("technology") || s.includes("tech") || s.includes("semiconductor") || s.includes("software")) return "Tech";
  if (s.includes("defensive") || s.includes("staple")) return "Staples";
  if (s.includes("real estate") || s.includes("reits") || s.includes("reit")) return "Real Estate";
  if (s.includes("utilit")) return "Utilities";
  if (s.includes("health") || s.includes("medical") || s.includes("biotech")) return "Health";
  if (s.includes("cyclical") || s.includes("discretionary") || s.includes("consumer")) return "Discretionary";
  return null;
}

function prevTradingDay(dateStr: string): { date: string; note: string | null } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, 6=Sat
  if (jsDay === 6) {
    const fri = new Date(Date.UTC(y, m - 1, d - 1));
    return { date: fri.toISOString().split("T")[0], note: `Sat ${dateStr} → using Fri close` };
  }
  if (jsDay === 0) {
    const fri = new Date(Date.UTC(y, m - 1, d - 2));
    return { date: fri.toISOString().split("T")[0], note: `Sun ${dateStr} → using Fri close` };
  }
  return { date: dateStr, note: null };
}

function localIsoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function parseDatedEarningsRows(text: string): { date: string; tickers: string[] }[] | null {
  const rows: { date: string; tickers: string[] }[] = [];
  let sawDate = false;
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*(\d{4}-\d{2}-\d{2})\s*[:,-]\s*(.+)$/);
    if (!m) return;
    sawDate = true;
    const tickers = m[2]
      .split(/[\s,;]+/)
      .map(t => t.trim().toUpperCase().replace(/^\$/, ""))
      .filter(t => /^[A-Z][A-Z0-9.-]{0,14}$/.test(t));
    if (tickers.length) rows.push({ date: m[1], tickers });
  });
  return sawDate ? rows : null;
}

function countEarningsInputTickers(text: string): number {
  const dated = parseDatedEarningsRows(text);
  const values = dated
    ? dated.flatMap(row => row.tickers)
    : text.split(/[\s,;]+/).map(t => t.trim().toUpperCase().replace(/^\$/, ""));
  return new Set(values.filter(t => /^[A-Z][A-Z0-9.-]{0,14}$/.test(t))).size;
}

export default function ScannerPage() {
  const [watchlist,    setWatchlist]    = useState("default");
  const [watchlistsOpen, setWatchlistsOpen] = useState(false);
  const [scannerCollapsed, setScannerCollapsed] = useState(false);
  const [houseRulesOpen, setHouseRulesOpen] = useState(true);
  const [customInput,  setCustomInput]  = useState("");
  const [holdingsInput, setHoldingsInput] = useState("");
  const [holdingsTickers, setHoldingsTickers] = useState<string[]>([]);
  const [holdingsSaving, setHoldingsSaving] = useState(false);
  const [holdingsMsg, setHoldingsMsg] = useState("");
  const [earningsInput, setEarningsInput] = useState("");
  const [earningsStartDate, setEarningsStartDate] = useState(() => localIsoDate());
  const [earningsDays, setEarningsDays] = useState(7);
  const [earningsRows, setEarningsRows] = useState<EarningsPlaceholderRow[]>([]);
  const [earningsBusy, setEarningsBusy] = useState(false);
  const [earningsMsg, setEarningsMsg] = useState("");
  const [tickerFilter, setTickerFilter] = useState("");
  const [scanning,     setScanning]     = useState(false);
  const [results,      setResults]      = useState<ScanResult[]>([]);
  const [progress,     setProgress]     = useState({ done: 0, total: 0 });
  // Per-scan opt-in to news fetching. The backend default is off (it adds
  // ~0.5–2s/ticker), so this toggle lets the user pull news only when they
  // need it for that particular scan run.
  const [includeNews, setIncludeNews] = useState(false);
  const [scannerMode, setScannerMode] = useState<ScannerMode>("overview");
  // Multi-select: empty set = "All" (show everything). Clicking a chip
  // toggles its membership; clicking "All" clears the set.
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const toggleFilter = (f: Filter) =>
    setFilters(prev => {
      const next = new Set(prev);
      if (f === "all") { next.clear(); return next; }
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  const clearFilters = () => setFilters(new Set());
  const [sortBy,       setSortBy]       = useState<SortBy>("score");
  const selectScannerMode = (next: ScannerMode) => {
    if (next === scannerMode) return;
    const keepCurrentScan = next === "snapshots" || scannerMode === "snapshots";
    setScannerMode(next);
    setFilters(new Set());
    setSortBy(SCANNER_MODES.find(m => m.key === next)?.sort ?? "score");
    if (!keepCurrentScan) {
      setResults([]);
      setPooled([]);
      setProgress({ done: 0, total: 0 });
      setActiveBacktestDate(null);
    }
    setSnapshotStatus("");
  };
  const [optModal,     setOptModal]     = useState<{ r: ScanResult } | null>(null);
  const [otmModal,     setOtmModal]     = useState<{ r: ScanResult } | null>(null);
  const [btdModal,     setBtdModal]     = useState<{ r: ScanResult } | null>(null);
  const [newsModal,    setNewsModal]    = useState<{ r: ScanResult } | null>(null);
  const [fibModal,     setFibModal]     = useState<{ r: ScanResult } | null>(null);
  const [dt4Modal,     setDt4Modal]     = useState<{ r: ScanResult } | null>(null);
  const [seasonModal,  setSeasonModal]  = useState<
    { ticker: string; loading: boolean; data: Seasonality | null; error?: string } | null
  >(null);
  const [copied,       setCopied]       = useState(false);
  const [mode,         setMode]         = useState<"live" | "backtest">("live");
  const [backtestDate, setBacktestDate] = useState("");
  const [activeBacktestDate, setActiveBacktestDate] = useState<string | null>(null);
  const [sectorMacro,  setSectorMacro]  = useState<Record<string, MacroItem>>({});
  const [auto15mStatus, setAuto15mStatus] = useState("");
  const [v3AutoStatus, setV3AutoStatus]   = useState("");
  const v3BusyRef = useRef(false);
  const [telegramStatus, setTelegramStatus] = useState("");
  const [telegramSending, setTelegramSending] = useState(false);
  const [tgPulling, setTgPulling] = useState(false);
  const [tgPullMsg, setTgPullMsg] = useState("");
  const [pooled,   setPooled]   = useState<ScanResult[]>([]);
  const [pooling,  setPooling]  = useState(false);
  const [poolMsg,  setPoolMsg]  = useState("");
  const esRef = useRef<EventSource | null>(null);
  const poolEsRef = useRef<EventSource | null>(null);
  const poolCancelRef = useRef(false);
  const refresh15mRef = useRef<EventSource | null>(null);
  const refresh15mBusyRef = useRef(false);
  const pending15mKey = results
    .filter(hasPending15mVolume)
    .map(r => r.ticker.toUpperCase())
    .sort()
    .join(",");

  useEffect(() => {
    let alive = true;
    async function loadHoldings() {
      try {
        const res = await fetch(`${API_BASE}/api/scanner/holdings`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
        const tickers = Array.isArray(json?.tickers) ? json.tickers.map((t: string) => String(t).toUpperCase()) : [];
        if (!alive) return;
        setHoldingsTickers(tickers);
        setHoldingsInput(tickers.join(", "));
        setHoldingsMsg(tickers.length ? `Loaded ${tickers.length}` : "");
      } catch (e: any) {
        if (alive) setHoldingsMsg(`Load failed: ${e?.message ?? e}`);
      }
    }
    loadHoldings();
    loadEarningsPlaceholders();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!optModal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOptModal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [optModal]);

  useEffect(() => {
    if (!btdModal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setBtdModal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [btdModal]);

  useEffect(() => {
    if (!newsModal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setNewsModal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newsModal]);

  useEffect(() => {
    if (!fibModal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setFibModal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fibModal]);

  useEffect(() => {
    if (!dt4Modal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setDt4Modal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dt4Modal]);

  useEffect(() => {
    if (!seasonModal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setSeasonModal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seasonModal]);

  useEffect(() => {
    return () => refresh15mRef.current?.close();
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/macro/snapshot`)
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        if (!alive || !json?.items) return;
        const sectors: Record<string, MacroItem> = {};
        (json.items as MacroItem[])
          .filter(item => item.category === "sector")
          .forEach(item => { sectors[item.label] = item; });
        setSectorMacro(sectors);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (mode !== "live" || scanning || progress.total === 0 || progress.done < progress.total || !pending15mKey || !inOpeningVolumeRefreshWindow()) {
      return;
    }

    const refreshPending = () => {
      if (refresh15mBusyRef.current || !inOpeningVolumeRefreshWindow()) return;
      const tickers = Array.from(new Set(
        results
          .filter(hasPending15mVolume)
          .map(r => r.ticker.toUpperCase())
      )).slice(0, 80);
      if (!tickers.length) return;

      refresh15mBusyRef.current = true;
      setAuto15mStatus(`Auto-updating 15m volume (${tickers.length})`);
      refresh15mRef.current?.close();

      const es = new EventSource(`${API_BASE}/api/scanner/stream?mode=${encodeURIComponent(scannerMode)}&tickers=${encodeURIComponent(tickers.join(","))}`);
      refresh15mRef.current = es;

      es.onmessage = (e) => {
        const data: ScanResult = JSON.parse(e.data);
        if (data.done) {
          refresh15mBusyRef.current = false;
          setAuto15mStatus("15m volume refreshed");
          window.setTimeout(() => setAuto15mStatus(""), 2500);
          es.close();
          return;
        }
        if (!data.ticker) return;
        if (data.error) return;
        setResults(prev => {
          const idx = prev.findIndex(r => r.ticker.toUpperCase() === data.ticker!.toUpperCase());
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = { ...prev[idx], ...data };
          return next;
        });
      };

      es.onerror = () => {
        refresh15mBusyRef.current = false;
        setAuto15mStatus("15m auto-update waiting");
        es.close();
      };
    };

    const first = window.setTimeout(refreshPending, 60_000);
    const every = window.setInterval(refreshPending, 90_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [mode, scannerMode, scanning, progress.done, progress.total, pending15mKey, results]);

  // ── V3 auto-refresh ──────────────────────────────────────────────────────
  // Re-evaluate ONLY the V3 day-trading engine for the current rows every 5
  // min during V3 trade windows (09:50–11:00 ET + 13:30–15:30 ET). Skips
  // the heavy scan_single pipeline; hits the cheap /v3-refresh endpoint
  // which only computes day_trading.v3.analyze() per ticker.
  useEffect(() => {
    if (mode !== "live" || scanning ||
        progress.total === 0 || progress.done < progress.total ||
        results.length === 0 || !inV3TradeWindow()) {
      return;
    }

    const refreshV3 = async () => {
      if (v3BusyRef.current || !inV3TradeWindow()) return;

      // Smart subset: rank by distance to the nearest watched level so we
      // only spend yfinance calls on rows where V3 could plausibly fire.
      // Always include: rows already firing (keep them updating live).
      // Then: rows within 0.5% of a PWH/PWL/PDH/PDL. Then: top 10 closest
      // as a "heartbeat floor" so something always refreshes during a cycle.
      const NEAR_PCT = 0.005;
      const MIN_FLOOR = 10;
      type Cand = { tk: string; dist: number; firing: boolean; tier?: string };
      const ranked: Cand[] = results.map(r => {
        const tk = r.ticker.toUpperCase();
        const firing = r.dt3_setup === "sweep_reclaim" || r.dt3_setup === "break_retest";
        const p = r.price ?? 0;
        const levels = [r.dt3_pwh, r.dt3_pwl, r.dt3_pdh, r.dt3_pdl]
          .filter((l): l is number => l != null && l > 0);
        const dist = (p > 0 && levels.length)
          ? Math.min(...levels.map(l => Math.abs(p - l) / p))
          : Infinity;
        // Mirror the page.tsx filter tests for Actionable / Exceptional /
        // Rank 1 (all subsume mtf_rank===1) → drives Telegram notify list.
        let tier: string | undefined;
        if (r.mtf_rank === 1) {
          if (["S", "A"].includes(r.entry_grade ?? "") && r.vol_trend === "ACCUMULATING") tier = "Exceptional";
          else if (r.lre_status === "ACTIVE" || r.lre_status === "DISCOUNT") tier = "Actionable";
          else tier = "Rank 1";
        }
        return { tk, dist, firing, tier };
      });
      ranked.sort((a, b) => {
        if (a.firing !== b.firing) return a.firing ? -1 : 1;
        return a.dist - b.dist;
      });

      const pick = new Map<string, Cand>();
      ranked.forEach((c, i) => {
        if (c.firing || c.dist <= NEAR_PCT || i < MIN_FLOOR) pick.set(c.tk, c);
      });
      const tickers = Array.from(pick.keys()).slice(0, 80);
      if (!tickers.length) return;

      // Notify allowlist: tier-eligible rows among the refresh set.
      const notify: Record<string, string> = {};
      tickers.forEach(tk => {
        const c = pick.get(tk);
        if (c?.tier) notify[tk] = c.tier;
      });

      v3BusyRef.current = true;
      const notifyCount = Object.keys(notify).length;
      setV3AutoStatus(
        `Auto-updating V3 (${tickers.length} of ${results.length} · ${notifyCount} alert-eligible)`
      );
      try {
        const res = await fetch(`${API_BASE}/api/scanner/v3-refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers, notify }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const updates: Record<string, Partial<ScanResult>> = j?.results ?? {};
        const hits = Object.keys(updates).length;
        if (hits) {
          setResults(prev => prev.map(r => {
            const u = updates[r.ticker.toUpperCase()];
            return u ? { ...r, ...u } : r;
          }));
        }
        const fired = Object.values(updates).filter(u =>
          u?.dt3_setup && u.dt3_setup !== "no_setup" && u.dt3_setup !== "error"
        ).length;
        setV3AutoStatus(
          fired > 0
            ? `V3 updated — ${fired} firing of ${hits}`
            : `V3 updated — ${hits} watching`
        );
        window.setTimeout(() => setV3AutoStatus(""), 4000);
      } catch (e) {
        setV3AutoStatus("V3 auto-update paused");
      } finally {
        v3BusyRef.current = false;
      }
    };

    // First fire after 15s (let initial render settle), then every 5 min.
    // 5 min matches the 5m bar cadence v3 keys off of — faster is wasted.
    const first = window.setTimeout(refreshV3, 15_000);
    const every = window.setInterval(refreshV3, 5 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [mode, scanning, progress.done, progress.total, results.length]);

  function copyText(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Watchlists with daily-saved snapshots — load instantly instead of running a live scan.
  const SNAPSHOT_WATCHLISTS = ["default", "momentum"];
  const [snapshotStatus, setSnapshotStatus] = useState<string>("");
  const [snapshotRows, setSnapshotRows] = useState<SnapshotMeta[]>([]);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState("");

  async function fetchSnapshot(key: string) {
    const res = await fetch(`${API_BASE}/api/scanner/snapshot?watchlist=${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function refreshSnapshotRows() {
    setSnapshotBusy(true);
    setSnapshotMsg("Loading snapshots...");
    try {
      const res = await fetch(`${API_BASE}/api/scanner/snapshots`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      const rows = Array.isArray(json?.snapshots) ? json.snapshots : [];
      setSnapshotRows(rows);
      setSnapshotMsg(rows.length ? `${rows.length} saved · auto-delete after ${json?.retention_days ?? 7} days` : "No saved snapshots");
    } catch (e: any) {
      setSnapshotMsg(`Snapshot load failed: ${e?.message ?? e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function saveCurrentSnapshot() {
    const rows = results.filter(r => !r.done);
    if (!rows.length) {
      setSnapshotMsg("Run or load a scan first, then save it.");
      return;
    }
    setSnapshotBusy(true);
    setSnapshotMsg("Saving current scan...");
    try {
      const payload = {
        watchlist,
        day: activeBacktestDate ?? undefined,
        results: rows,
      };
      const res = await fetch(`${API_BASE}/api/scanner/snapshot/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      setSnapshotMsg(`Saved ${json.count ?? rows.length} rows for ${json.watchlist} ${json.date}`);
      await refreshSnapshotRows();
    } catch (e: any) {
      setSnapshotMsg(`Snapshot save failed: ${e?.message ?? e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function loadSavedSnapshot(row: SnapshotMeta) {
    setSnapshotBusy(true);
    setSnapshotMsg(`Loading ${row.watchlist} ${row.date}...`);
    try {
      const res = await fetch(`${API_BASE}/api/scanner/snapshot?watchlist=${encodeURIComponent(row.watchlist)}&day=${encodeURIComponent(row.date)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.available) throw new Error(json?.error || json?.detail || `HTTP ${res.status}`);
      setWatchlist(row.watchlist);
      setResults(Array.isArray(json.results) ? json.results : []);
      setProgress({ done: json.count ?? 0, total: json.count ?? 0 });
      setActiveBacktestDate(json.date ?? row.date);
      setScannerMode("overview");
      setScannerCollapsed(true);
      setSnapshotMsg(`Loaded ${row.watchlist} ${row.date}`);
    } catch (e: any) {
      setSnapshotMsg(`Snapshot load failed: ${e?.message ?? e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function deleteSavedSnapshot(row: SnapshotMeta) {
    setSnapshotBusy(true);
    setSnapshotMsg(`Deleting ${row.watchlist} ${row.date}...`);
    try {
      const res = await fetch(`${API_BASE}/api/scanner/snapshot?watchlist=${encodeURIComponent(row.watchlist)}&day=${encodeURIComponent(row.date)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      setSnapshotMsg(`Deleted ${json.deleted ?? 0} snapshot`);
      await refreshSnapshotRows();
    } catch (e: any) {
      setSnapshotMsg(`Snapshot delete failed: ${e?.message ?? e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function pruneSavedSnapshots() {
    setSnapshotBusy(true);
    setSnapshotMsg("Deleting snapshots older than 7 days...");
    try {
      const res = await fetch(`${API_BASE}/api/scanner/snapshot/prune?days=7`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      setSnapshotMsg(`Pruned ${json.deleted ?? 0} old snapshot${json.deleted === 1 ? "" : "s"}`);
      await refreshSnapshotRows();
    } catch (e: any) {
      setSnapshotMsg(`Snapshot prune failed: ${e?.message ?? e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  useEffect(() => {
    if (scannerMode === "snapshots") refreshSnapshotRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannerMode]);

  async function loadSnapshot(key: string) {
    let fallbackToLive = false;
    setResults([]);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setSnapshotStatus("Loading saved snapshot…");
    try {
      let json = await fetchSnapshot(key);

      // Auto-trigger if no snapshot exists yet (first-time use, before 3 PM cron has fired).
      if (!json.available || !json.results || json.results.length === 0) {
        setSnapshotStatus("No snapshot yet — building it now (~1–3 minutes)…");
        const trig = await fetch(`${API_BASE}/api/scanner/snapshot/run?watchlist=${key}`, { method: "POST" });
        if (!trig.ok && trig.status !== 202) throw new Error(`Trigger failed: HTTP ${trig.status}`);

        // Poll every 10s up to 5 minutes
        const maxAttempts = 30;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise(r => setTimeout(r, 10_000));
          setSnapshotStatus(`Building snapshot… (${i * 10}s)`);
          json = await fetchSnapshot(key);
          if (json.available && json.results && json.results.length > 0) break;
          if (i === maxAttempts - 1) {
            fallbackToLive = true;
            setSnapshotStatus("Snapshot still building; switching to live scan.");
            return;
          }
        }
      }

      setResults(json.results);
      setProgress({ done: json.count, total: json.count });
      setActiveBacktestDate(json.date);
      setSnapshotStatus("");
      setScannerCollapsed(true);
    } catch (e: any) {
      setSnapshotStatus(`Failed: ${e?.message ?? e}`);
    } finally {
      setScanning(false);
      if (fallbackToLive) {
        window.setTimeout(() => startScan(key, true), 0);
      }
    }
  }

  function startScan(scanWatchlist: string = watchlist, forceLive = false) {
    const scanMode = scannerMode === "snapshots" ? "overview" : scannerMode;
    if (esRef.current) esRef.current.close();
    if (refresh15mRef.current) refresh15mRef.current.close();
    refresh15mBusyRef.current = false;
    setAuto15mStatus("");
    const dynamicSwing = scanWatchlist === "nyse_swing" || scanWatchlist === "nasdaq_swing";
    setSnapshotStatus(forceLive
      ? "Live scan running while snapshot finishes."
      : dynamicSwing
        ? "Building swing universe from live market data..."
        : "");
    setScannerCollapsed(false);
    if (scanWatchlist === "custom" && watchlist !== "custom") {
      setWatchlist("custom");
    }

    // For saved daily snapshots in live mode, prefer the Neon-backed snapshot (faster).
    if (!forceLive && mode === "live" && scanMode === "overview" && SNAPSHOT_WATCHLISTS.includes(scanWatchlist)) {
      loadSnapshot(scanWatchlist);
      return;
    }

    setResults([]);

    let url: string;
    let total: number;

    if (scanWatchlist === "custom") {
      const tickers = customInput.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
      if (!tickers.length) return;
      total = tickers.length;
      url = `${API_BASE}/api/scanner/stream?mode=${encodeURIComponent(scanMode)}&tickers=${encodeURIComponent(tickers.join(","))}`;
    } else {
      total = scanWatchlist === "holdings"
        ? holdingsTickers.length
        : scanWatchlist === "earnings"
          ? (earningsSavedTickerCount || WATCHLISTS.find(w => w.key === scanWatchlist)?.count || 0)
          : WATCHLISTS.find(w => w.key === scanWatchlist)?.count ?? 50;
      url = `${API_BASE}/api/scanner/stream?mode=${encodeURIComponent(scanMode)}&watchlist=${scanWatchlist}`;
    }

    if (mode === "backtest" && backtestDate) {
      url += `&as_of=${backtestDate}`;
      setActiveBacktestDate(backtestDate);
    } else {
      setActiveBacktestDate(null);
    }
    if (includeNews) url += `&include_news=1`;

    setProgress({ done: 0, total });
    setScanning(true);

    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      const data: ScanResult = JSON.parse(e.data);
      if (data.done) {
        setScanning(false);
        setProgress(p => {
          const total = data.total ?? p.done;
          return { done: total, total: total || p.total };
        });
        setSnapshotStatus("");
        setScannerCollapsed(true);
        es.close();
        return;
      }
      if (dynamicSwing && progress.done === 0) setSnapshotStatus("");
      setResults(prev => [...prev, data]);
      setProgress(p => ({ ...p, done: p.done + 1 }));
    };

    es.onerror = () => {
      setScanning(false);
      setSnapshotStatus("");
      es.close();
    };
  }

  function stopScan() {
    esRef.current?.close();
    setScanning(false);
  }

  async function loadEarningsPlaceholders() {
    setEarningsBusy(true);
    setEarningsMsg("Loading...");
    try {
      const res = await fetch(
        `${API_BASE}/api/earnings/placeholders?start_date=${encodeURIComponent(earningsStartDate)}&days=${earningsDays}`
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      const rows = Array.isArray(json?.rows) ? json.rows : [];
      setEarningsRows(rows);
      const unique = new Set(rows.map((r: EarningsPlaceholderRow) => r.ticker)).size;
      setEarningsMsg(unique ? `Loaded ${unique} tickers / ${rows.length} rows` : "No saved earnings rows");
    } catch (e: any) {
      setEarningsMsg(`Load failed: ${e?.message ?? e}`);
    } finally {
      setEarningsBusy(false);
    }
  }

  async function saveEarningsPlaceholders() {
    const input = earningsInput.trim();
    if (!input) {
      setEarningsMsg("Paste tickers first.");
      return;
    }
    const datedRows = parseDatedEarningsRows(input);
    if (datedRows && datedRows.length === 0) {
      setEarningsMsg("No valid dated ticker rows found.");
      return;
    }
    setEarningsBusy(true);
    setEarningsMsg("Saving...");
    try {
      const payload = datedRows
        ? {
            rows: datedRows,
            source: "scanner-weekly",
            replace: true,
            keep_after_days: 2,
          }
        : {
            start_date: earningsStartDate,
            days: earningsDays,
            tickers: input,
            source: "scanner-weekly",
            replace: true,
            keep_after_days: 2,
          };
      const res = await fetch(`${API_BASE}/api/earnings/placeholders/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      const tickerCount = Array.isArray(json?.tickers) ? json.tickers.length : countEarningsInputTickers(input);
      setEarningsMsg(`Saved ${tickerCount} tickers / ${json?.count ?? 0} rows`);
      setWatchlist("earnings");
      await loadEarningsPlaceholders();
    } catch (e: any) {
      setEarningsMsg(`Save failed: ${e?.message ?? e}`);
    } finally {
      setEarningsBusy(false);
    }
  }

  async function purgeEarningsPlaceholders() {
    setEarningsBusy(true);
    setEarningsMsg("Purging...");
    try {
      const res = await fetch(`${API_BASE}/api/earnings/placeholders/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep_after_days: 2 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      setEarningsMsg(`Purged ${json?.deleted ?? 0} rows older than ${json?.cutoff_exclusive ?? "cutoff"}`);
      await loadEarningsPlaceholders();
    } catch (e: any) {
      setEarningsMsg(`Purge failed: ${e?.message ?? e}`);
    } finally {
      setEarningsBusy(false);
    }
  }

  async function dropEarningsPlaceholders() {
    setEarningsBusy(true);
    setEarningsMsg("Dropping...");
    try {
      const res = await fetch(
        `${API_BASE}/api/earnings/placeholders?start_date=${encodeURIComponent(earningsStartDate)}&days=${earningsDays}`,
        { method: "DELETE" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      setEarningsMsg(`Dropped ${json?.deleted ?? 0} rows`);
      await loadEarningsPlaceholders();
    } catch (e: any) {
      setEarningsMsg(`Drop failed: ${e?.message ?? e}`);
    } finally {
      setEarningsBusy(false);
    }
  }

  async function saveHoldings() {
    setHoldingsSaving(true);
    setHoldingsMsg("Saving...");
    try {
      const res = await fetch(`${API_BASE}/api/scanner/holdings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: holdingsInput }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
      const tickers = Array.isArray(json?.tickers) ? json.tickers.map((t: string) => String(t).toUpperCase()) : [];
      setHoldingsTickers(tickers);
      setHoldingsInput(tickers.join(", "));
      setHoldingsMsg(`Saved ${tickers.length}`);
      setWatchlist("holdings");
    } catch (e: any) {
      setHoldingsMsg(`Save failed: ${e?.message ?? e}`);
    } finally {
      setHoldingsSaving(false);
    }
  }

  async function hardPullTelegram() {
    setTgPulling(true);
    setTgPullMsg("Reading TOS scan email…");
    try {
      const res = await fetch(`${API_BASE}/api/scanner/telegram/refresh`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`);
      setTgPullMsg(`📧 ${j.new ?? 0} new email(s) · ${j.count ?? 0} tickers`);
      setWatchlist("telegram");
    } catch (e: any) {
      setTgPullMsg(`Pull failed: ${e?.message ?? e}`);
    } finally {
      setTgPulling(false);
    }
  }

  async function openSeason(ticker: string) {
    setSeasonModal({ ticker, loading: true, data: null });
    try {
      const res = await fetch(
        `${API_BASE}/api/scanner/seasonality?ticker=${encodeURIComponent(ticker)}`,
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`);
      setSeasonModal({ ticker, loading: false, data: j as Seasonality });
    } catch (e: any) {
      setSeasonModal({ ticker, loading: false, data: null, error: e?.message ?? String(e) });
    }
  }

  // ── Multi-day pooled backtest (last 8 weekly Fridays) ──
  function lastNFridays(n: number): string[] {
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const d = new Date();
    d.setDate(d.getDate() - 1);            // strictly before today
    while (d.getDay() !== 5) d.setDate(d.getDate() - 1);  // back to Friday
    const out: string[] = [];
    for (let i = 0; i < n; i++) { out.push(fmt(d)); d.setDate(d.getDate() - 7); }
    return out;
  }

  function streamScanOnce(asOf: string, onProg?: (n: number) => void): Promise<ScanResult[]> {
    return new Promise(resolve => {
      let url: string;
      if (watchlist === "custom") {
        const tickers = customInput.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
        if (!tickers.length) { resolve([]); return; }
        url = `${API_BASE}/api/scanner/stream?mode=${encodeURIComponent(scannerMode)}&tickers=${encodeURIComponent(tickers.join(","))}&as_of=${asOf}`;
      } else {
        url = `${API_BASE}/api/scanner/stream?mode=${encodeURIComponent(scannerMode)}&watchlist=${watchlist}&as_of=${asOf}`;
      }
      if (includeNews) url += `&include_news=1`;
      const acc: ScanResult[] = [];
      const es = new EventSource(url);
      poolEsRef.current = es;
      es.onmessage = e => {
        const data: ScanResult = JSON.parse(e.data);
        if (data.done) { es.close(); resolve(acc); return; }
        acc.push(data); onProg?.(acc.length);
      };
      es.onerror = () => { es.close(); resolve(acc); };
    });
  }

  async function runPooledBacktest() {
    const dates = lastNFridays(8);
    poolCancelRef.current = false;
    setPooled([]); setPooling(true);
    const all: ScanResult[] = [];
    for (let i = 0; i < dates.length; i++) {
      if (poolCancelRef.current) break;
      setPoolMsg(`Friday ${i + 1}/${dates.length}: scanning ${dates[i]}…`);
      // eslint-disable-next-line no-await-in-loop
      const rows = await streamScanOnce(dates[i], n =>
        setPoolMsg(`Friday ${i + 1}/${dates.length}: ${dates[i]} — ${n} rows`));
      if (poolCancelRef.current) break;
      rows.forEach(r => { if (!r.bt_scan_date) r.bt_scan_date = dates[i]; });
      all.push(...rows);
      setPooled([...all]);
    }
    setPooling(false);
    setPoolMsg(poolCancelRef.current
      ? `Stopped · pooled ${all.length} rows`
      : `Pooled ${dates.length} Fridays · ${all.length} rows`);
  }

  function stopPool() {
    poolCancelRef.current = true;
    poolEsRef.current?.close();
    setPooling(false);
  }

  async function sendTelegramAlert() {
    setTelegramSending(true);
    setTelegramStatus("Scanning Default 50 + Momentum 20 for lightning...");
    try {
      const res = await fetch(`${API_BASE}/api/telegram/lightning-scan`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || json?.detail || `HTTP ${res.status}`);
      setTelegramStatus(json?.message || "Telegram alert sent");
      window.setTimeout(() => setTelegramStatus(""), 6000);
    } catch (e: any) {
      setTelegramStatus(`Telegram failed: ${e?.message ?? e}`);
    } finally {
      setTelegramSending(false);
    }
  }

  const gradeRank: Record<string, number> = { S: 0, A: 1, B: 2, "B-": 3, C: 4, D: 5 };
  const isSweepReclaimLong = (r: ScanResult) =>
    r.dt4_setup === "sweep_reclaim_long"
    || (r.dt3_setup === "sweep_reclaim" && r.dt3_side === "long");
  const isSweepReclaimShort = (r: ScanResult) =>
    r.dt4_setup === "sweep_reject_short"
    || (r.dt3_setup === "sweep_reclaim" && r.dt3_side === "short");
  // "Breakout" = price is clearing (or hugging within 0.5%) a higher-
  // timeframe resistance, OR an engine confirmed a long-side break+retest.
  // Long-side only — a downside break is a "breakdown", separate concept.
  const isBreakout = (r: ScanResult): boolean => {
    const p = r.price ?? 0;
    if (p <= 0) return false;
    // Confirmed structural break+retest from V3
    if (r.dt3_setup === "break_retest" && r.dt3_side === "long") return true;
    // V4 setup tagged as a break (long-side)
    if (r.dt4_setup
        && r.dt4_setup.toLowerCase().includes("break")
        && r.dt4_side !== "short") return true;
    // Price clearing prior month high or 52-week high (within 0.5% below
    // qualifies — captures the moment of breakout as well as the hold).
    const cleared = (lvl?: number | null) =>
      lvl != null && lvl > 0 && p >= lvl * 0.995;
    return cleared(r.wk52_high) || cleared(r.prev_month_high);
  };
  const tickerFilterTokens = tickerFilter
    .split(/[\s,]+/)
    .map(t => t.trim().toUpperCase())
    .filter(Boolean);

  // Single-filter predicate — extracted so both the row filter (union match
  // across selected chips) and the chip count badges share the exact same
  // logic. Returns true for "all" so callers can pass it freely.
  const passesFilter = (r: ScanResult, f: Filter): boolean => {
    switch (f) {
      case "rank1":               return r.mtf_rank === 1;
      case "high_short":          return (r.short_pct ?? 0) >= 10;
      case "btd":                 return isBtdLive(r.btd_state);
      case "btd_trigger":         return r.btd_state === "TRIGGER";
      case "day_spring":          return !!r.day_spring;
      case "lt_spring":           return !!r.long_term_spring;
      case "w30ma_curl":          return !!r.w30ma_curl;
      case "sweep_reclaim_long":  return isSweepReclaimLong(r);
      case "sweep_reclaim_short": return isSweepReclaimShort(r);
      case "breakout":            return isBreakout(r);
      case "prebreakout":         return !!r.swing_prebreakout;
      case "quality_long":
        return r.lre_score === 3
          && (r.verdict === "BULLISH" || r.verdict === "LEAN BULLISH")
          && r.confidence === "STRONG";
      case "exceptional":
        return ["S", "A"].includes(r.entry_grade ?? "")
          && r.mtf_rank === 1
          && r.vol_trend === "ACCUMULATING";
      case "actionable":
        return r.mtf_rank === 1
          && (r.lre_status === "ACTIVE" || r.lre_status === "DISCOUNT");
      case "speculative":         return !!r.multi_bagger || !!r.long_runway;
      case "news_good":           return r.news === "Good";
      case "news_bad":             return r.news === "Bad";
      default:                    return true;   // "all"
    }
  };

  const filtered = results
    .filter(r => !r.error && r.verdict)
    .filter(r => tickerFilterTokens.length === 0 || tickerFilterTokens.includes(r.ticker.toUpperCase()))
    // Multi-filter: empty set = no filter. Otherwise the row passes if it
    // matches ANY selected chip (union/OR). Switch to .every(...) for
    // intersection/AND behaviour if you prefer narrower matches.
    .filter(r => filters.size === 0 || Array.from(filters).some(f => passesFilter(r, f)))
    .sort((a, b) => {
      if (sortBy === "score")  return Math.abs(b.score ?? 0) - Math.abs(a.score ?? 0);
      if (sortBy === "grade")  return (gradeRank[a.entry_grade ?? "D"] ?? 5) - (gradeRank[b.entry_grade ?? "D"] ?? 5);
      if (sortBy === "rr")     return (b.rr_t1 ?? 0) - (a.rr_t1 ?? 0);
      if (sortBy === "swingReward") return rewardPctValue(b.entry, b.target1) - rewardPctValue(a.entry, a.target1);
      if (sortBy === "fibReward")   return (b.fib_target_reward_pct ?? 0) - (a.fib_target_reward_pct ?? 0);
      if (sortBy === "dayReward")   return rewardPctValue(b.cpr_day_entry, b.cpr_day_t1) - rewardPctValue(a.cpr_day_entry, a.cpr_day_t1);
      if (sortBy === "ltEntryPct")  return longTermFromEntryPctValue(b) - longTermFromEntryPctValue(a);
      if (sortBy === "valuation")   return valuationSortValue(b) - valuationSortValue(a);
      if (sortBy === "longRunway")  return (b.long_runway ? 1 : 0) - (a.long_runway ? 1 : 0);
      if (sortBy === "cyclicalPeak")return (b.cyclical_peak_risk ? 1 : 0) - (a.cyclical_peak_risk ? 1 : 0);
      if (sortBy === "multiBagger") return (b.multi_bagger ? 1 : 0) - (a.multi_bagger ? 1 : 0);
      if (sortBy === "newsGood")    return newsNet(b) - newsNet(a);
      if (sortBy === "newsBad")     return newsNet(a) - newsNet(b);
      return 0;
    });

  const errors  = results.filter(r => r.error);
  const pct     = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const selectedWatchlist = WATCHLISTS.find(w => w.key === watchlist);
  const selectedScannerMode = SCANNER_MODES.find(m => m.key === scannerMode) ?? SCANNER_MODES[0];
  const customTickerCount = customInput.split(",").filter(t => t.trim()).length;
  const holdingsTickerCount = holdingsTickers.length;
  const earningsInputTickerCount = countEarningsInputTickers(earningsInput);
  const earningsSavedTickerCount = new Set(earningsRows.map(r => r.ticker)).size;
  const earningsRowsByDate = earningsRows.reduce<Record<string, string[]>>((acc, row) => {
    const day = row.date;
    if (!acc[day]) acc[day] = [];
    acc[day].push(row.ticker);
    return acc;
  }, {});
  const selectedWatchlistCount = watchlist === "custom"
    ? customTickerCount
    : watchlist === "holdings"
      ? holdingsTickerCount
      : watchlist === "earnings"
        ? (earningsSavedTickerCount || selectedWatchlist?.count || 0)
        : selectedWatchlist?.count ?? 0;
  const showLongTermCol = scannerMode === "overview" || scannerMode === "longterm";
  const showSwingCol = scannerMode === "overview" || scannerMode === "swing";
  const showFibCol = scannerMode === "overview" || scannerMode === "fib";
  const showDayTradingCol = scannerMode === "overview" || scannerMode === "daytrading";
  const showNextDayCol = scannerMode === "overview" || scannerMode === "daytrading";
  const showShortCol = scannerMode === "overview" || scannerMode === "longterm";
  const showOptionsCol = scannerMode === "overview" || scannerMode === "options";

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      {/* ── Controls ── */}
      <div className="card space-y-3">
        <div className="flex items-center gap-3 overflow-x-auto rounded-lg border border-border bg-card/40 px-3 py-2">
          <span className="shrink-0 text-lg font-bold text-white">Scanner</span>
          <button
            type="button"
            onClick={() => {
              setScannerCollapsed(false);
              setWatchlistsOpen(v => !v);
            }}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-surface/50 px-2 py-1.5 text-left hover:border-white/20"
          >
            <span className="inline-flex shrink-0 items-center gap-2">
              <span className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted">
                Watch List
              </span>
              <span className="rounded border border-border bg-card px-2 py-1 text-xs font-semibold text-white">
                {selectedWatchlist?.label ?? watchlist}
              </span>
              <span className="text-xs text-muted">
                {`${selectedWatchlistCount} ticker${selectedWatchlistCount !== 1 ? "s" : ""}`}
              </span>
            </span>
            <span className={`whitespace-nowrap rounded border px-2 py-1 text-xs font-bold transition-colors ${
              watchlistsOpen
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-yellow/40 bg-yellow/10 text-yellow"
            }`}>
              {watchlistsOpen ? "Hide" : "Options"}
            </span>
          </button>
          <span className="shrink-0 rounded border border-border bg-surface px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted">
            Scanner
          </span>
          <div className="flex shrink-0 rounded-lg border border-border bg-surface overflow-hidden">
            {SCANNER_MODES.map(m => (
              <button
                key={m.key}
                type="button"
                onClick={() => selectScannerMode(m.key)}
                disabled={scanning}
                title={m.title}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors border-l border-border first:border-l-0 ${
                  scannerMode === m.key
                    ? "bg-accent text-black"
                    : "text-muted hover:text-white bg-transparent"
                } ${scanning ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <span className="shrink-0 rounded border border-border bg-surface px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted">
            Mode
          </span>
          <div className="flex shrink-0 rounded-lg border border-border bg-surface overflow-hidden">
            <button
              onClick={() => setMode("live")}
              className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                mode === "live" ? "bg-accent text-black" : "text-muted hover:text-white bg-transparent"
              }`}
            >
              ▶ Live
            </button>
            <button
              onClick={() => setMode("backtest")}
              className={`px-4 py-1.5 text-xs font-semibold transition-colors border-l border-border ${
                mode === "backtest" ? "bg-accent text-black" : "text-muted hover:text-white bg-transparent"
              }`}
            >
              ⏪ Backtest
            </button>
          </div>
          <button
            onClick={() => setIncludeNews(v => !v)}
            disabled={scanning}
            title={includeNews
              ? "News fetching ON for this scan — adds ~0.5–2s per non-ETF ticker. Click to disable."
              : "News fetching OFF — click to enable for the next scan. Adds latency but populates News column / filters."}
            className={`shrink-0 px-3 py-1.5 rounded-lg font-semibold text-xs uppercase tracking-wide transition-colors border ${
              includeNews
                ? "bg-accent/20 text-accent border-accent/40"
                : "bg-transparent text-muted border-border hover:text-white"
            } ${scanning ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            📰 {includeNews ? "News ON" : "News"}
          </button>
          <button
            onClick={scanning ? stopScan : () => startScan()}
            disabled={!scanning && mode === "backtest" && !backtestDate}
            title={`${selectedScannerMode.label} scanner`}
            className={`shrink-0 px-6 py-1.5 rounded-lg font-bold text-sm uppercase tracking-wide transition-all ${
              scanning
                ? "bg-red/20 text-red border border-red/30 hover:bg-red/30"
                : mode === "backtest" && !backtestDate
                  ? "bg-surface text-muted border border-border cursor-not-allowed"
                  : "bg-accent text-black border border-accent hover:bg-accent/85"
            }`}
          >
            {scanning ? "⏹ STOP" : mode === "backtest" ? "⏪ BACKTEST" : "▶ SCAN"}
          </button>
          <button
            type="button"
            onClick={sendTelegramAlert}
            disabled={telegramSending}
            className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-bold uppercase transition-colors ${
              telegramSending
                ? "border-yellow/30 bg-yellow/10 text-yellow cursor-wait"
                : "border-border bg-surface text-muted hover:border-yellow/40 hover:text-yellow"
            }`}
            title="Force scan Default 50 + Momentum 20 and send lightning-volume options plays to Telegram"
          >
            {telegramSending ? "TG..." : "TG Scan"}
          </button>
          {(scanning || results.length > 0 || snapshotStatus || telegramStatus) && (
            <div className="shrink-0 min-w-[230px] max-w-[280px]">
              <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-muted">
                <span>{progress.done} / {progress.total} scanned</span>
                <span>{pct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                <div className="h-full rounded-full bg-accent/80 transition-all duration-300"
                     style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted">
                {results.length > 0 && !scanning && (
                  <span>{filtered.length} shown · {errors.length} errors</span>
                )}
                {snapshotStatus && <span className="text-accent">{snapshotStatus}</span>}
                {auto15mStatus && <span className="text-yellow">{auto15mStatus}</span>}
                {v3AutoStatus  && <span className="text-accent">{v3AutoStatus}</span>}
                {telegramStatus && (
                  <span className={telegramStatus.startsWith("Telegram failed") ? "text-red" : "text-green"}>
                    {telegramStatus}
                  </span>
                )}
              </div>
            </div>
          )}
          {results.length > 0 && !scanning && (
            <button
              type="button"
              onClick={() => setScannerCollapsed(v => !v)}
              className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-muted hover:border-white/20 hover:text-white"
            >
              {scannerCollapsed ? "Expand" : "Collapse"}
            </button>
          )}
        </div>

        {!scannerCollapsed && watchlistsOpen && (
          <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-surface/30 px-3 py-2">
            {WATCHLISTS.map(w => {
              if (w.key === "custom" && watchlist === "custom") {
                return (
                  <div key={w.key} className="flex items-center gap-2 rounded-lg border border-accent/50 bg-surface px-2 py-1">
                    <span className="text-xs font-semibold text-accent">Custom</span>
                    <input
                      autoFocus
                      type="text"
                      value={customInput}
                      onChange={e => setCustomInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && !scanning && customInput.trim() && startScan("custom")}
                      placeholder="AAPL, MSFT"
                      className="w-44 rounded border border-border bg-transparent px-2 py-1 text-xs font-mono text-white placeholder-muted focus:border-accent focus:outline-none"
                    />
                    <button
                      onClick={scanning ? stopScan : () => startScan("custom")}
                      disabled={!scanning && (!customInput.trim() || (mode === "backtest" && !backtestDate))}
                      className={`rounded px-3 py-1 text-xs font-bold transition-colors ${
                        scanning
                          ? "border border-red/30 bg-red/20 text-red hover:bg-red/30"
                          : !customInput.trim() || (mode === "backtest" && !backtestDate)
                            ? "border border-border bg-card text-muted cursor-not-allowed"
                            : "border border-accent bg-accent text-black hover:bg-accent/85"
                      }`}
                    >
                      {scanning ? "STOP" : "SCAN"}
                    </button>
                  </div>
                );
              }
              if (w.key === "holdings") {
                return (
                  <div key={w.key} className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${
                    watchlist === w.key ? "border-accent/50 bg-surface" : "border-border bg-transparent"
                  }`}>
                    <button onClick={() => setWatchlist(w.key)}
                      className={`px-2 py-1 text-xs rounded font-semibold transition-colors ${
                        watchlist === w.key ? "text-accent" : "text-muted hover:text-white"
                      }`}>
                      {w.label}
                    </button>
                    {watchlist === w.key && (
                      <>
                        <input
                          autoFocus
                          type="text"
                          value={holdingsInput}
                          onChange={e => setHoldingsInput(e.target.value)}
                          onKeyDown={e => e.key === "Enter" && !holdingsSaving && saveHoldings()}
                          placeholder="AAPL, MSFT"
                          className="w-52 rounded border border-border bg-transparent px-2 py-1 text-xs font-mono text-white placeholder-muted focus:border-accent focus:outline-none"
                        />
                        <button
                          onClick={saveHoldings}
                          disabled={holdingsSaving}
                          className="rounded border border-accent/40 px-2 py-1 text-xs font-bold text-accent hover:bg-accent/10 disabled:opacity-40"
                        >
                          {holdingsSaving ? "Saving" : "Save"}
                        </button>
                        <button
                          onClick={scanning ? stopScan : () => startScan("holdings")}
                          disabled={!scanning && (!holdingsTickerCount || (mode === "backtest" && !backtestDate))}
                          className={`rounded px-2 py-1 text-xs font-bold transition-colors ${
                            scanning
                              ? "border border-red/30 bg-red/20 text-red hover:bg-red/30"
                              : !holdingsTickerCount || (mode === "backtest" && !backtestDate)
                                ? "border border-border bg-card text-muted cursor-not-allowed"
                                : "border border-accent bg-accent text-black hover:bg-accent/85"
                          }`}
                        >
                          {scanning ? "STOP" : "SCAN"}
                        </button>
                      </>
                    )}
                  </div>
                );
              }
              if (w.key === "earnings") {
                return (
                  <div key={w.key} className={`basis-full rounded-lg border px-3 py-2 ${
                    watchlist === w.key ? "border-accent/50 bg-surface" : "border-border bg-transparent"
                  }`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setWatchlist(w.key);
                          if (!earningsRows.length) loadEarningsPlaceholders();
                        }}
                        className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${
                          watchlist === w.key ? "text-accent" : "text-muted hover:text-white"
                        }`}
                      >
                        {w.label}
                      </button>
                      <span className="text-[11px] text-muted">
                        {earningsSavedTickerCount || w.count} saved
                      </span>
                      <button
                        type="button"
                        onClick={scanning ? stopScan : () => startScan("earnings")}
                        disabled={!scanning && mode === "backtest" && !backtestDate}
                        className={`rounded px-2 py-1 text-xs font-bold transition-colors ${
                          scanning
                            ? "border border-red/30 bg-red/20 text-red hover:bg-red/30"
                            : mode === "backtest" && !backtestDate
                              ? "border border-border bg-card text-muted cursor-not-allowed"
                              : "border border-accent bg-accent text-black hover:bg-accent/85"
                        }`}
                      >
                        {scanning ? "STOP" : "SCAN"}
                      </button>
                    </div>
                    {watchlist === w.key && (
                      <div className="mt-2 grid gap-2 lg:grid-cols-[160px_92px_minmax(260px,1fr)_auto]">
                        <input
                          type="date"
                          value={earningsStartDate}
                          onChange={e => setEarningsStartDate(e.target.value)}
                          className="rounded border border-border bg-card px-2 py-1 text-xs font-mono text-white focus:border-accent focus:outline-none"
                        />
                        <input
                          type="number"
                          min={1}
                          max={14}
                          value={earningsDays}
                          onChange={e => setEarningsDays(Math.max(1, Math.min(14, Number(e.target.value) || 7)))}
                          className="rounded border border-border bg-card px-2 py-1 text-xs font-mono text-white focus:border-accent focus:outline-none"
                          title="Days"
                        />
                        <textarea
                          value={earningsInput}
                          onChange={e => setEarningsInput(e.target.value)}
                          placeholder={"AAPL, MSFT, NVDA\n2026-06-03: CRM, ORCL"}
                          className="min-h-[68px] resize-y rounded border border-border bg-card px-2 py-1 text-xs font-mono text-white placeholder-muted focus:border-accent focus:outline-none"
                        />
                        <div className="flex flex-wrap items-start gap-1">
                          <button
                            type="button"
                            onClick={saveEarningsPlaceholders}
                            disabled={earningsBusy || !earningsInput.trim()}
                            className="rounded border border-accent/40 px-2 py-1 text-xs font-bold text-accent hover:bg-accent/10 disabled:opacity-40"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={loadEarningsPlaceholders}
                            disabled={earningsBusy}
                            className="rounded border border-border px-2 py-1 text-xs font-semibold text-muted hover:text-white disabled:opacity-40"
                          >
                            Refresh
                          </button>
                          <button
                            type="button"
                            onClick={purgeEarningsPlaceholders}
                            disabled={earningsBusy}
                            className="rounded border border-yellow/30 px-2 py-1 text-xs font-semibold text-yellow hover:bg-yellow/10 disabled:opacity-40"
                          >
                            Purge Done
                          </button>
                          <button
                            type="button"
                            onClick={dropEarningsPlaceholders}
                            disabled={earningsBusy}
                            className="rounded border border-red/30 px-2 py-1 text-xs font-semibold text-red hover:bg-red/10 disabled:opacity-40"
                          >
                            Drop Week
                          </button>
                        </div>
                        <div className="lg:col-span-4 flex flex-wrap items-center gap-3 text-[11px] text-muted">
                          {earningsInputTickerCount > 0 && (
                            <span>{earningsInputTickerCount} in input</span>
                          )}
                          {earningsMsg && <span>{earningsMsg}</span>}
                          {Object.entries(earningsRowsByDate).slice(0, 7).map(([day, tickers]) => (
                            <span key={day} className="font-mono">
                              {day}: {tickers.slice(0, 10).join(", ")}{tickers.length > 10 ? ` +${tickers.length - 10}` : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              if (w.key === "telegram") {
                return (
                  <div key={w.key} className="flex items-center gap-1">
                    <button onClick={() => setWatchlist(w.key)}
                      className={`px-3 py-1.5 text-xs rounded-l-lg font-semibold border transition-colors ${
                        watchlist === w.key
                          ? "bg-accent text-black border-accent"
                          : "border-border text-muted hover:text-white hover:border-white/20"
                      }`}>
                      {w.label}
                    </button>
                    <button
                      onClick={hardPullTelegram}
                      disabled={tgPulling}
                      title="Force an immediate read of the TOS scan email — don't wait for the Saturday 7:15 PM CST job"
                      className="px-2 py-1.5 text-xs rounded-r-lg font-semibold border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40">
                      {tgPulling ? "…" : "↻ Hard pull"}
                    </button>
                  </div>
                );
              }
              return (
                <button key={w.key} onClick={() => setWatchlist(w.key)}
                  className={`px-3 py-1.5 text-xs rounded-lg font-semibold border transition-colors ${
                    watchlist === w.key
                      ? "bg-accent text-black border-accent"
                      : "border-border text-muted hover:text-white hover:border-white/20"
                  }`}>
                  {w.label}
                </button>
              );
            })}
            {tgPullMsg && (
              <span className="self-center text-[11px] text-muted">{tgPullMsg}</span>
            )}
            {holdingsMsg && (
              <span className="self-center text-[11px] text-muted">{holdingsMsg}</span>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[320px] max-w-2xl flex-1 items-center gap-2">
              <span className="shrink-0 rounded border border-accent/30 bg-accent/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-accent">
                Custom
              </span>
              <input
                type="text"
                value={customInput}
                onChange={e => setCustomInput(e.target.value)}
                onFocus={() => setWatchlist("custom")}
                onKeyDown={e => e.key === "Enter" && !scanning && customInput.trim() && startScan("custom")}
                placeholder="One or many tickers: AAPL, MSFT"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-mono text-white placeholder-muted focus:border-accent focus:outline-none"
              />
              <button
                onClick={scanning ? stopScan : () => startScan("custom")}
                disabled={!scanning && (!customInput.trim() || (mode === "backtest" && !backtestDate))}
                className={`shrink-0 rounded-lg px-4 py-1.5 text-xs font-bold uppercase transition-colors ${
                  scanning
                    ? "bg-red/20 text-red border border-red/30 hover:bg-red/30"
                    : !customInput.trim() || (mode === "backtest" && !backtestDate)
                      ? "bg-surface text-muted border border-border cursor-not-allowed"
                      : "bg-accent text-black border border-accent hover:bg-accent/85"
                }`}
              >
                {scanning ? "Stop" : "Scan"}
              </button>
              {customInput && (
                <span className="shrink-0 text-xs text-muted">
                  {customInput.split(",").filter(t => t.trim()).length} ticker{customInput.split(",").filter(t => t.trim()).length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            {mode === "backtest" && (
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted">As of date:</span>
                <input
                  type="date"
                  value={backtestDate}
                  max={new Date(Date.now() - 86400000).toISOString().split("T")[0]}
                  onChange={e => setBacktestDate(e.target.value)}
                  className="bg-surface border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent font-mono"
                />
                {!backtestDate && (
                  <span className="text-xs text-yellow">Pick a date to backtest</span>
                )}
                {backtestDate && prevTradingDay(backtestDate).note && (
                  <span className="text-xs text-yellow">{prevTradingDay(backtestDate).note}</span>
                )}
              </div>
            )}

            {/* ── Mode toggle ── */}
            <div className="hidden">
              <span className="rounded border border-accent/40 bg-accent/15 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-accent">
                Mode
              </span>
              <div className="flex rounded-lg border border-accent/40 bg-accent/5 shadow-[0_0_14px_rgba(96,165,250,0.12)] overflow-hidden">
                <button
                  onClick={() => setMode("live")}
                  className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                    mode === "live" ? "bg-accent text-black" : "text-muted hover:text-white bg-transparent"
                  }`}
                >
                  ▶ Live
                </button>
                <button
                  onClick={() => setMode("backtest")}
                  className={`px-4 py-1.5 text-xs font-semibold transition-colors border-l border-border ${
                    mode === "backtest" ? "bg-accent text-black" : "text-muted hover:text-white bg-transparent"
                  }`}
                >
                  ⏪ Backtest
                </button>
              </div>
              <button
                onClick={scanning ? stopScan : () => startScan()}
                disabled={!scanning && mode === "backtest" && !backtestDate}
                className={`px-6 py-1.5 rounded-lg font-bold text-sm uppercase tracking-wide transition-all ${
                  scanning
                    ? "bg-red/20 text-red border border-red/30 shadow-[0_0_16px_rgba(248,113,113,0.25)] hover:bg-red/30"
                    : mode === "backtest" && !backtestDate
                      ? "bg-surface text-muted border border-border cursor-not-allowed"
                      : "bg-accent text-black ring-1 ring-accent/60 shadow-[0_0_20px_rgba(96,165,250,0.35)] hover:bg-accent/90 hover:shadow-[0_0_26px_rgba(96,165,250,0.5)]"
                }`}
              >
                {scanning ? "⏹ STOP" : mode === "backtest" ? "⏪ BACKTEST" : "▶ SCAN"}
              </button>
              {mode === "backtest" && (
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-xs text-muted">As of date:</span>
                  <input
                    type="date"
                    value={backtestDate}
                    max={new Date(Date.now() - 86400000).toISOString().split("T")[0]}
                    onChange={e => setBacktestDate(e.target.value)}
                    className="bg-surface border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent font-mono"
                  />
                  {!backtestDate && (
                    <span className="text-xs text-yellow">Pick a date to backtest</span>
                  )}
                  {backtestDate && prevTradingDay(backtestDate).note && (
                    <span className="text-xs text-yellow">{prevTradingDay(backtestDate).note}</span>
                  )}
                </div>
              )}
            </div>

            {false && (scanning || results.length > 0 || snapshotStatus) && (
            <div className="flex gap-3 items-center">
              {(scanning || results.length > 0) && (
                <div className="flex-1 max-w-xs">
                  <div className="flex justify-between text-xs text-muted mb-1">
                    <span>{progress.done} / {progress.total} scanned</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                    <div className="h-full bg-accent transition-all duration-300 rounded-full"
                         style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}

              {results.length > 0 && !scanning && (
                <span className="text-xs text-muted">
                  {filtered.length} shown · {errors.length} errors
                </span>
              )}

              {/* Snapshot loading status (NYSE/NASDAQ swing) */}
              {snapshotStatus && (
                <span className="text-xs text-accent">{snapshotStatus}</span>
              )}
            </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface/45 px-3 py-2 text-[10px] text-muted">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white">House Rules</span>
              <div className="flex items-center gap-2">
                <span className="rounded border border-yellow/30 bg-yellow/10 px-1.5 py-0.5 text-[9px] font-semibold text-yellow">
                  Not financial advice
                </span>
                <button
                  type="button"
                  onClick={() => setHouseRulesOpen(v => !v)}
                  className="rounded border border-border px-2 py-0.5 text-[9px] font-semibold text-muted hover:border-white/20 hover:text-white"
                >
                  {houseRulesOpen ? "Collapse" : "Expand"}
                </button>
              </div>
            </div>
            {houseRulesOpen && (
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-4">
              {[
                "Respect stop loss; no averaging after invalidation.",
                "Plan entry, target, size, and exit before taking the trade.",
                "Always check the \"lightning symbol\" (⚡) for unusual volume tickers.",
                "For day trades, confirm market sentiment before entry.",
                "Day trades need liquidity, confirmation, and smaller risk.",
                "Options can expire worthless; favor defined risk and liquid chains.",
                "Do not chase gaps; wait for trigger or clean retest.",
                "Scanner output is a decision aid, not a trade command.",
              ].map(rule => (
                <div key={rule} className="flex gap-2 leading-snug">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80" />
                  <span>{rule}</span>
                </div>
              ))}
            </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Pooled multi-day backtest (8 Fridays) ── */}
      {scannerMode === "snapshots" && (
        <section className="rounded-lg border border-border bg-surface/35 px-4 py-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Saved Snapshots</h2>
              <p className="mt-1 text-xs text-muted">
                Persistent scanner snapshots are kept for 7 days, then pruned automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={saveCurrentSnapshot}
                disabled={snapshotBusy || scanning || results.length === 0}
                className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-xs font-bold uppercase text-black hover:bg-accent/85 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-muted"
              >
                Save Current
              </button>
              <button
                type="button"
                onClick={refreshSnapshotRows}
                disabled={snapshotBusy}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-muted hover:border-white/20 hover:text-white disabled:opacity-50"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={pruneSavedSnapshots}
                disabled={snapshotBusy}
                className="rounded-lg border border-yellow/30 bg-yellow/10 px-3 py-1.5 text-xs font-semibold text-yellow hover:bg-yellow/15 disabled:opacity-50"
              >
                Delete Old
              </button>
            </div>
          </div>

          {snapshotMsg && (
            <div className="mb-3 text-xs text-muted">{snapshotMsg}</div>
          )}

          {snapshotRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="border-b border-border text-muted">
                  <tr className="text-left">
                    <th className="py-2 pr-4">Watchlist</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4 text-right">Rows</th>
                    <th className="py-2 pr-4">Saved</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshotRows.map(row => (
                    <tr key={`${row.watchlist}:${row.date}`} className="border-b border-border/60 last:border-b-0">
                      <td className="py-2 pr-4 font-semibold text-white">
                        {WATCHLISTS.find(w => w.key === row.watchlist)?.label ?? row.watchlist}
                      </td>
                      <td className="py-2 pr-4 font-mono text-accent">{row.date}</td>
                      <td className="py-2 pr-4 text-right font-mono text-white">{row.count}</td>
                      <td className="py-2 pr-4 font-mono text-muted">{row.created_at ?? "-"}</td>
                      <td className="py-2">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => loadSavedSnapshot(row)}
                            disabled={snapshotBusy}
                            className="rounded border border-accent/40 px-2 py-1 font-semibold text-accent hover:bg-accent/10 disabled:opacity-50"
                          >
                            Load
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteSavedSnapshot(row)}
                            disabled={snapshotBusy}
                            className="rounded border border-red/30 px-2 py-1 font-semibold text-red hover:bg-red/10 disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
              No saved snapshots yet.
            </div>
          )}
        </section>
      )}

      {mode === "backtest" && scannerMode !== "snapshots" && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 rounded-lg bg-accent/5 border border-accent/20 text-sm">
          <span className="font-semibold text-accent">⏪⏪ Pooled backtest</span>
          {!pooling ? (
            <button
              onClick={runPooledBacktest}
              disabled={scanning}
              className="px-3 py-1 rounded-md bg-accent text-black text-xs font-semibold hover:opacity-90 disabled:opacity-40"
            >
              Run last 8 Fridays
            </button>
          ) : (
            <button
              onClick={stopPool}
              className="px-3 py-1 rounded-md bg-red/20 text-red text-xs font-semibold hover:bg-red/30"
            >
              ⏹ Stop pool
            </button>
          )}
          <span className="text-xs text-muted">
            {poolMsg || "Runs the current watchlist as-of each of the last 8 Fridays, then pools the swing-plan outcomes below."}
          </span>
        </div>
      )}

      {/* ── Backtest banner ── */}
      {activeBacktestDate && results.length > 0 && scannerMode !== "snapshots" && (() => {
        const { date: effectiveDate, note } = prevTradingDay(activeBacktestDate);
        return (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 border border-accent/20 text-sm">
            <span className="text-accent font-semibold">⏪ Backtest</span>
            <span className="text-muted">Showing scanner results as of</span>
            <span className="font-mono text-white">{effectiveDate}</span>
            {note && <span className="text-xs text-yellow ml-1">({note})</span>}
          </div>
        );
      })()}

      {/* ── Backtest: next-day outcome grouped by BTD ── */}
      {activeBacktestDate && results.length > 0 && scannerMode !== "snapshots" && (() => {
        const rows = results.filter(r => !r.error && r.btd_state);
        if (rows.length === 0) return null;
        const evaluated = rows.filter(r => r.bt_next_positive != null);
        if (evaluated.length === 0) {
          return (
            <div className="rounded-lg border border-yellow/20 bg-card px-4 py-2 text-xs text-yellow">
              📊 Next-day-by-BTD summary pending — the trading day after {prevTradingDay(activeBacktestDate).date} hasn&apos;t closed yet.
            </div>
          );
        }
        const order = ["TRIGGER", "ARMED", "ARMED-DEEP", "DISARMED", "N/A"];
        const nextDate = evaluated.find(r => r.bt_next_date)?.bt_next_date ?? null;
        const stat = (rs: ScanResult[]) => {
          const wins = rs.filter(r => r.bt_next_positive === true).length;
          const avg = rs.reduce((s, r) => s + (r.bt_next_chg_pct ?? 0), 0) / rs.length;
          return { n: rs.length, wins, winPct: (wins / rs.length) * 100, avg };
        };
        const buckets = order
          .map(state => ({ state, rs: evaluated.filter(r => (r.btd_state ?? "N/A") === state) }))
          .filter(b => b.rs.length > 0)
          .map(b => ({ state: b.state, ...stat(b.rs) }));
        const tot = stat(evaluated);
        const stateColor = (s: string) =>
          s === "TRIGGER" ? "text-green" :
          s === "ARMED" ? "text-accent" :
          s === "ARMED-DEEP" ? "text-yellow" :
          s === "DISARMED" ? "text-red" : "text-muted";
        return (
          <div className="rounded-lg border border-accent/20 bg-card px-4 py-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-accent">📊 Next-day outcome by BTD</span>
              <span className="text-xs text-muted">
                scan {prevTradingDay(activeBacktestDate).date}{nextDate ? ` → close ${nextDate}` : ""} · positive = next close above scan close · {tot.n} evaluated
              </span>
            </div>
            <div className="mb-2 text-[11px] text-yellow/80">
              ⚠ Long-only metric: a “win” = next close above scan close, <span className="font-semibold">not</span> adjusted for the verdict direction — BEARISH / short setups that rise still count as “positive” here.
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted">
                  <tr className="text-left">
                    <th className="py-1 pr-4">BTD State</th>
                    <th className="py-1 pr-4 text-right">Stocks</th>
                    <th className="py-1 pr-4 text-right">Closed + next day</th>
                    <th className="py-1 pr-4 text-right">Win %</th>
                    <th className="py-1 text-right">Avg next-day %</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {buckets.map(b => (
                    <tr key={b.state} className="border-t border-border/40">
                      <td className={`py-1 pr-4 font-semibold ${stateColor(b.state)}`}>{b.state}</td>
                      <td className="py-1 pr-4 text-right text-white">{b.n}</td>
                      <td className="py-1 pr-4 text-right text-white">{b.wins}</td>
                      <td className={`py-1 pr-4 text-right ${b.winPct >= 50 ? "text-green" : "text-red"}`}>{b.winPct.toFixed(0)}%</td>
                      <td className={`py-1 text-right ${b.avg >= 0 ? "text-green" : "text-red"}`}>{b.avg >= 0 ? "+" : ""}{b.avg.toFixed(2)}%</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="py-1 pr-4 font-semibold text-white">All</td>
                    <td className="py-1 pr-4 text-right text-white">{tot.n}</td>
                    <td className="py-1 pr-4 text-right text-white">{tot.wins}</td>
                    <td className={`py-1 pr-4 text-right ${tot.winPct >= 50 ? "text-green" : "text-red"}`}>{tot.winPct.toFixed(0)}%</td>
                    <td className={`py-1 text-right ${tot.avg >= 0 ? "text-green" : "text-red"}`}>{tot.avg >= 0 ? "+" : ""}{tot.avg.toFixed(2)}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ── Backtest: next-day outcome grouped by scanner category ── */}
      {activeBacktestDate && results.length > 0 && scannerMode !== "snapshots" && (() => {
        const evaluated = results.filter(r => !r.error && r.verdict && r.bt_next_positive != null);
        if (evaluated.length === 0) return null;
        const stat = (rs: ScanResult[]) => {
          const n = rs.length;
          const wins = rs.filter(r => r.bt_next_positive === true).length;
          const avg = n ? rs.reduce((s, r) => s + (r.bt_next_chg_pct ?? 0), 0) / n : 0;
          return { n, wins, winPct: n ? (wins / n) * 100 : 0, avg };
        };
        const cats: { label: string; test: (r: ScanResult) => boolean }[] = [
          { label: "🎯 Actionable", test: r => r.mtf_rank === 1 && (r.lre_status === "ACTIVE" || r.lre_status === "DISCOUNT") },
          { label: "Rank 1",        test: r => r.mtf_rank === 1 },
          { label: "Exceptional",   test: r => ["S", "A"].includes(r.entry_grade ?? "") && r.mtf_rank === 1 && r.vol_trend === "ACCUMULATING" },
          { label: "🌱 Day Spring", test: r => !!r.day_spring },
          { label: "🌱 LT Spring",  test: r => !!r.long_term_spring },
          { label: "⭐ Bullish",    test: r => r.lre_score === 3 && (r.verdict === "BULLISH" || r.verdict === "LEAN BULLISH") && r.confidence === "STRONG" },
        ];
        const rowsC = cats
          .map(c => ({ label: c.label, ...stat(evaluated.filter(c.test)) }))
          .filter(c => c.n > 0);
        if (rowsC.length === 0) return null;
        const base = stat(evaluated);
        return (
          <div className="rounded-lg border border-accent/20 bg-card px-4 py-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-accent">📊 Next-day outcome by category</span>
              <span className="text-xs text-muted">categories overlap — a stock can count in several rows · {base.n} evaluated</span>
            </div>
            <div className="mb-2 text-[11px] text-yellow/80">
              ⚠ Long-only metric: a “win” = next close above scan close, <span className="font-semibold">not</span> adjusted for the verdict direction — BEARISH / short setups that rise still count as “positive” here.
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted">
                  <tr className="text-left">
                    <th className="py-1 pr-4">Category</th>
                    <th className="py-1 pr-4 text-right">Stocks</th>
                    <th className="py-1 pr-4 text-right">Closed + next day</th>
                    <th className="py-1 pr-4 text-right">Win %</th>
                    <th className="py-1 text-right">Avg next-day %</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {rowsC.map(c => (
                    <tr key={c.label} className="border-t border-border/40">
                      <td className="py-1 pr-4 font-semibold text-accent">{c.label}</td>
                      <td className="py-1 pr-4 text-right text-white">{c.n}</td>
                      <td className="py-1 pr-4 text-right text-white">{c.wins}</td>
                      <td className={`py-1 pr-4 text-right ${c.winPct >= 50 ? "text-green" : "text-red"}`}>{c.winPct.toFixed(0)}%</td>
                      <td className={`py-1 text-right ${c.avg >= 0 ? "text-green" : "text-red"}`}>{c.avg >= 0 ? "+" : ""}{c.avg.toFixed(2)}%</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="py-1 pr-4 font-semibold text-white">All (baseline)</td>
                    <td className="py-1 pr-4 text-right text-white">{base.n}</td>
                    <td className="py-1 pr-4 text-right text-white">{base.wins}</td>
                    <td className={`py-1 pr-4 text-right ${base.winPct >= 50 ? "text-green" : "text-red"}`}>{base.winPct.toFixed(0)}%</td>
                    <td className={`py-1 text-right ${base.avg >= 0 ? "text-green" : "text-red"}`}>{base.avg >= 0 ? "+" : ""}{base.avg.toFixed(2)}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ── Pooled swing-plan outcome (direction-aware, multi-date) ── */}
      {pooled.length > 0 && (() => {
        const rows = pooled.filter(r => !r.error && r.verdict && r.bt_swing_outcome);
        if (rows.length === 0) return null;
        const swStat = (rs: ScanResult[]) => {
          const resolved = rs.filter(r => r.bt_swing_outcome === "WIN" || r.bt_swing_outcome === "LOSS");
          const wins = resolved.filter(r => r.bt_swing_outcome === "WIN").length;
          const open = rs.filter(r => r.bt_swing_outcome === "OPEN").length;
          const withR = rs.filter(r => r.bt_swing_r != null);
          const avgR = withR.length ? withR.reduce((s, r) => s + (r.bt_swing_r ?? 0), 0) / withR.length : 0;
          return { trades: resolved.length, wins, winPct: resolved.length ? (wins / resolved.length) * 100 : 0, avgR, open };
        };
        const order = ["TRIGGER", "ARMED", "ARMED-DEEP", "DISARMED", "N/A"];
        const stateColor = (s: string) =>
          s === "TRIGGER" ? "text-green" :
          s === "ARMED" ? "text-accent" :
          s === "ARMED-DEEP" ? "text-yellow" :
          s === "DISARMED" ? "text-red" : "text-muted";
        const btdRows = order
          .map(s => ({ key: s, cls: stateColor(s), rs: rows.filter(r => (r.btd_state ?? "N/A") === s) }))
          .filter(b => b.rs.length > 0)
          .map(b => ({ key: b.key, cls: b.cls, ...swStat(b.rs) }));
        const cats: { label: string; test: (r: ScanResult) => boolean }[] = [
          { label: "🎯 Actionable", test: r => r.mtf_rank === 1 && (r.lre_status === "ACTIVE" || r.lre_status === "DISCOUNT") },
          { label: "Rank 1",        test: r => r.mtf_rank === 1 },
          { label: "Exceptional",   test: r => ["S", "A"].includes(r.entry_grade ?? "") && r.mtf_rank === 1 && r.vol_trend === "ACCUMULATING" },
          { label: "🌱 Day Spring", test: r => !!r.day_spring },
          { label: "🌱 LT Spring",  test: r => !!r.long_term_spring },
          { label: "⭐ Bullish",    test: r => r.lre_score === 3 && (r.verdict === "BULLISH" || r.verdict === "LEAN BULLISH") && r.confidence === "STRONG" },
        ];
        const catRows = cats
          .map(c => ({ key: c.label, cls: "text-accent", rs: rows.filter(c.test) }))
          .filter(c => c.rs.length > 0)
          .map(c => ({ key: c.key, cls: c.cls, ...swStat(c.rs) }));
        const tot = swStat(rows);
        const dateCount = new Set(pooled.map(r => r.bt_scan_date).filter(Boolean)).size;
        type Row = { key: string; cls: string; trades: number; wins: number; winPct: number; avgR: number; open: number };
        const renderTable = (title: string, label: string, body: Row[]) => (
          <div className="flex-1 min-w-[340px]">
            <div className="mb-1 text-xs font-semibold text-accent">{title}</div>
            <table className="w-full text-xs">
              <thead className="text-muted">
                <tr className="text-left">
                  <th className="py-1 pr-3">{label}</th>
                  <th className="py-1 pr-3 text-right">Trades</th>
                  <th className="py-1 pr-3 text-right">Win %</th>
                  <th className="py-1 pr-3 text-right">Avg R</th>
                  <th className="py-1 text-right">Open</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {body.map(b => (
                  <tr key={b.key} className="border-t border-border/40">
                    <td className={`py-1 pr-3 font-semibold ${b.cls}`}>{b.key}</td>
                    <td className="py-1 pr-3 text-right text-white">{b.trades}</td>
                    <td className={`py-1 pr-3 text-right ${b.winPct >= 50 ? "text-green" : "text-red"}`}>{b.trades ? `${b.winPct.toFixed(0)}%` : "—"}</td>
                    <td className={`py-1 pr-3 text-right ${b.avgR >= 0 ? "text-green" : "text-red"}`}>{b.avgR >= 0 ? "+" : ""}{b.avgR.toFixed(2)}R</td>
                    <td className="py-1 text-right text-muted">{b.open}</td>
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td className="py-1 pr-3 font-semibold text-white">All</td>
                  <td className="py-1 pr-3 text-right text-white">{tot.trades}</td>
                  <td className={`py-1 pr-3 text-right ${tot.winPct >= 50 ? "text-green" : "text-red"}`}>{tot.trades ? `${tot.winPct.toFixed(0)}%` : "—"}</td>
                  <td className={`py-1 pr-3 text-right ${tot.avgR >= 0 ? "text-green" : "text-red"}`}>{tot.avgR >= 0 ? "+" : ""}{tot.avgR.toFixed(2)}R</td>
                  <td className="py-1 text-right text-muted">{tot.open}</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
        return (
          <div className="rounded-lg border border-accent/30 bg-card px-4 py-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-accent">🧪 Swing-plan outcome (pooled, direction-aware)</span>
              <span className="text-xs text-muted">
                {dateCount} scan dates · {rows.length} plans · WIN = target1 before stop in the verdict direction · R = realized risk-multiple · OPEN = unresolved within horizon (excluded from Win %)
              </span>
            </div>
            <div className="flex flex-wrap gap-6">
              {renderTable("By BTD state", "BTD State", btdRows)}
              {renderTable("By category (overlapping)", "Category", catRows)}
            </div>
          </div>
        );
      })()}

      {/* ── Filter + Sort ── */}
      {results.length > 0 && scannerMode !== "snapshots" && (
        <div className="flex flex-wrap gap-4 items-center">
          <div
            className="flex flex-wrap gap-1 bg-card border border-border rounded-lg p-1"
            title="Click a chip to toggle it. Stack multiple chips for an OR-match. Click All (or right-click any chip) to reset."
          >
            {(["all", "actionable", "rank1", "exceptional", "high_short", "btd", "btd_trigger", "day_spring", "lt_spring", "w30ma_curl", "sweep_reclaim_long", "sweep_reclaim_short", "breakout", "prebreakout", "quality_long", "speculative", "news_good", "news_bad"] as Filter[]).map(f => {
              const active = f === "all" ? filters.size === 0 : filters.has(f);
              return (
              <button key={f}
                onClick={() => toggleFilter(f)}
                onContextMenu={(e) => { e.preventDefault(); clearFilters(); }}
                className={`px-3 py-1 text-xs rounded-md font-semibold transition-colors ${
                  active ? "bg-accent text-black" : "text-muted hover:text-white"
                }`}>
                {f === "sweep_reclaim_long" ? `Sweep Reclaim Long (${results.filter(isSweepReclaimLong).length})`
                : f === "sweep_reclaim_short" ? `Sweep Reclaim Short (${results.filter(isSweepReclaimShort).length})`
                : f === "breakout"   ? `🚀 Breakout (${results.filter(isBreakout).length})`
                : f === "prebreakout" ? `PreBO (${results.filter(r => !!r.swing_prebreakout).length})`
                : f === "all"         ? `All (${results.filter(r => !r.error).length})`
                : f === "actionable" ? `🎯 Actionable (${results.filter(r => r.mtf_rank === 1 && (r.lre_status === "ACTIVE" || r.lre_status === "DISCOUNT")).length})`
                : f === "rank1"      ? `Rank 1 (${results.filter(r => r.mtf_rank === 1).length})`
                : f === "high_short" ? `🔥 High Short (${results.filter(r => (r.short_pct ?? 0) >= 10).length})`
                : f === "btd"        ? `📉 BTD (${results.filter(r => isBtdLive(r.btd_state)).length})`
                : f === "btd_trigger" ? `✅ BTD Trigger · FULL (${results.filter(r => r.btd_state === "TRIGGER").length})`
                : f === "day_spring" ? `🌱 Day Spring (${results.filter(r => !!r.day_spring).length})`
                : f === "lt_spring"  ? `🌱 LT Spring (${results.filter(r => !!r.long_term_spring).length})`
                : f === "w30ma_curl" ? `30wk MA Curl (${results.filter(r => !!r.w30ma_curl).length})`
                : f === "quality_long" ? `⭐⭐⭐ Bullish 💪 (${results.filter(r => r.lre_score === 3 && (r.verdict === "BULLISH" || r.verdict === "LEAN BULLISH") && r.confidence === "STRONG").length})`
                : f === "speculative" ? `🚀 Spec/Growth (${results.filter(r => r.multi_bagger || r.long_runway).length})`
                : f === "news_good"  ? `📰 Good News (${results.filter(r => r.news === "Good").length})`
                : f === "news_bad"   ? `📰 Bad News (${results.filter(r => r.news === "Bad").length})`
                : `Exceptional (${results.filter(r => ["S","A"].includes(r.entry_grade ?? "") && r.mtf_rank === 1 && r.vol_trend === "ACCUMULATING").length})`}
              </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
            <span>Sort:</span>
            {SORT_OPTIONS.map(s => (
              <button key={s.key} onClick={() => setSortBy(s.key)} title={s.title}
                className={`px-2 py-1 rounded transition-colors ${
                  sortBy === s.key ? "text-white font-semibold" : "hover:text-white"
                }`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex min-w-[230px] max-w-sm flex-1 items-center gap-2">
            <span className="shrink-0 text-xs text-muted">Filter:</span>
            <input
              type="text"
              value={tickerFilter}
              onChange={e => setTickerFilter(e.target.value)}
              placeholder="AAPL, MSFT"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-mono text-white placeholder-muted focus:border-accent focus:outline-none"
            />
          </div>

          <button
            onClick={() => downloadCsv(
              `scanner_${activeBacktestDate ?? "live"}.csv`,
              [
                "Ticker","Sector","Price","Verdict","BTD","BTD Zone","Long Term Grade","Long Term Status",
                "Verdict Flip Date","Verdict Flip From","Days Since Flip",
                "Long Term Entry Range","Long Term % From Entry","Long Term Risk%","Long Term Spring","30wk MA Curl","30wk MA","30wk MA Slope%","30wk MA Reason","Valuation","Valuation Fair Value","Valuation Upside%","Valuation Source","Valuation Reason",
                "Swing Entry","Swing Stop","Swing T1","Swing T1 Approx Days","Swing Reward%","Swing Risk%","Swing R/R","Swing Invalidation","Swing Spring",
                "Swing Pre-Breakout","Pre-Breakout Level","Pre-Breakout Distance%","Pre-Breakout Trigger","Pre-Breakout Reason","BTD Trigger",
                "Fib Target","Fib Reward%","Fib Level","Fib Source","Fib Commentary","Prev Earnings","Last Earnings","Next Earnings (Fib)","Earn Zone","Weekly Zone","Nearest Fib","Fib Compression",
                "News","Next Earnings",
                "Day Trading Result","Day Trading Entry","Day Trading Stop","Day Trading T1","Day Trading Reward%","Day Trading Spring","Day Trading Trigger","Day Trading Invalidation","Day Trading Target Plan","Day Trading Volume Confirm","Day Trading 15m Volume Confirm","Day Trading Ref",
                "Day Trading V4 Context","Day Trading V4 Setup","Day Trading V4 Side","Day Trading V4 Grade","Day Trading V4 Level","Day Trading V4 Watch","Day Trading V4 Stop","Day Trading V4 T1","Day Trading V4 T2","Day Trading V4 R/R","Day Trading V4 Trigger","Day Trading V4 Invalidation","Day Trading V4 Exit",
                "Next Day Date","Next Day Outcome","Next Day Bias","Next Day Summary","Next Day ATR","Next Day ATR%","Next Day Up Trigger","Next Day Down Trigger","Next Day Pivot","Next Day Target",
                "Short%","Options Strategy","Options Summary","Fundamental","CPR Text",
              ],
              filtered.map(r => {
                const lreFromEntry = r.lre_entry && r.price
                  ? `${(((r.price - r.lre_entry) / r.lre_entry) * 100).toFixed(1)}%`
                  : null;
                return [
                  r.ticker, r.sector, r.price, r.verdict, r.btd_state, r.btd_zone, r.lre_label, r.lre_status,
                  r.verdict_flip_date, r.verdict_flip_from, r.verdict_flip_days,
                  lreRangeText(r), lreFromEntry, r.lre_risk_pct, r.long_term_spring_text,
                  r.w30ma_curl ? "Y" : "", r.w30ma, r.w30ma_slope_pct, r.w30ma_reason,
                  r.valuation_label, valuationFairValue(r), valuationUpsidePct(r), r.valuation_source, r.valuation_reason,
                  r.entry, r.stop_loss, r.target1, r.t1_days_text ?? r.t1_days ?? "", rewardPct(r.entry, r.target1), r.risk_pct, r.rr_t1, r.swing_invalidation_text, r.swing_spring_text,
                  r.swing_prebreakout ? "Y" : "", r.swing_prebreakout_level, r.swing_prebreakout_dist_pct, r.swing_prebreakout_trigger, r.swing_prebreakout_reason, r.btd_trigger ? (r.btd_trigger_text || "Y") : "",
                  r.fib_target, r.fib_target_reward_pct != null ? `${r.fib_target_reward_pct.toFixed(2)}%` : "",
                  r.fib_target_name, r.fib_target_source, r.fib_commentary,
                  r.fib_prev_earnings, r.fib_last_earnings, r.fib_next_earnings,
                  r.earn_zone, r.weekly_zone,
                  r.near_fib_name && r.near_fib_price != null ? `${r.near_fib_name} ${r.near_fib_price}` : "",
                  r.fib_compression ? "Y" : "",
                  r.news && r.news !== "No" ? `${r.news} (+${r.news_good ?? 0}/-${r.news_bad ?? 0} sum ${newsNet(r) >= 0 ? "+" : ""}${newsNet(r)})` : "",
                  r.next_earnings ?? "",
                  r.cpr_day_result, r.cpr_day_entry, r.cpr_day_stop, r.cpr_day_t1, rewardPct(r.cpr_day_entry, r.cpr_day_t1),
                  r.day_spring_text, r.cpr_day_trigger_text, r.cpr_day_invalidation_text, r.cpr_day_target_text, r.cpr_day_volume_text, r.cpr_day_15m_volume_text, r.cpr_day_ref,
                  r.dt4_context, r.dt4_setup, r.dt4_side, r.dt4_grade, r.dt4_level, r.dt4_entry, r.dt4_stop, r.dt4_t1, r.dt4_t2, r.dt4_rr, r.dt4_trigger, r.dt4_invalidation, r.dt4_exit_plan,
                  r.next_day_date, r.next_day_outcome, r.next_day_bias, r.next_day_summary ?? r.next_day_prediction,
                  r.next_day_atr, r.next_day_atr_pct, r.next_day_trigger_up, r.next_day_trigger_down,
                  r.next_day_pivot, r.next_day_target,
                  r.short_pct != null ? Math.round(r.short_pct) : null,
                  r.opt_strategy, [r.opt_summary, r.opt_alt].filter(Boolean).join(" | "),
                  r.signals, r.cpr_interpretation,
                ];
              })
            )}
            className="ml-auto px-3 py-1.5 text-xs rounded-lg border border-border text-muted hover:text-white hover:border-white/20 transition-colors"
          >
            ⬇ CSV
          </button>
        </div>
      )}

      {/* ── Results Table ── */}
      {filtered.length > 0 && scannerMode !== "snapshots" && (
        <div className="card p-0 overflow-hidden">
          <div className="max-h-[72vh] overflow-auto">
            <table className="min-w-full table-auto text-sm" style={{ borderCollapse: "collapse", width: "max-content" }}>
              <thead className="sticky top-0 z-30 bg-card">
                <tr className="border-b border-border bg-card text-muted text-xs shadow-[0_1px_0_rgba(148,163,184,0.2)]">
                  {/* sticky ticker column */}
                  <th className="text-left pl-4 pr-3 py-3 whitespace-nowrap sticky left-0 bg-card z-40">Ticker</th>
                  <th className="w-[88px] min-w-[88px] max-w-[88px] text-center px-2 py-3">Sector</th>
                  <th className="text-right px-3 py-3 whitespace-nowrap">Price</th>
                  <th className="text-center px-3 py-3 whitespace-nowrap">Verdict</th>
                  <th className={`${showLongTermCol ? "" : "hidden"} text-center px-3 py-3 whitespace-nowrap`} title="Long Term scans weekly bars for spring action. A green sprout appears in rows when detected.">
                    Long Term <span className="text-green/60">{"\u{1F331}"}</span>
                  </th>
                  <th className={`${showSwingCol ? "" : "hidden"} text-left px-2 py-3 whitespace-nowrap border-l border-border/60 text-accent`} title="Swing scans daily bars for spring action. A green sprout appears in rows when detected. Includes the per-ticker BTD badge (Buy-The-Dip: 20/50/200 EMA structure) — double-click it for full detail + copy. Pair with the market BTD/γ badge in the top bar.">
                    SWING <span className="text-green/60">{"\u{1F331}"}</span>
                  </th>
                  <th className={`${showFibCol ? "" : "hidden"} text-left px-2 py-3 whitespace-nowrap border-l border-border/60 text-green`} title="Directional Fibonacci target from the last earnings swing when available, otherwise the 52-week swing. Separate from the risk-based Swing T1.">
                    Fib Target
                  </th>
                  <th className={`${showDayTradingCol ? "" : "hidden"} text-left px-2 py-3 whitespace-nowrap border-l border-border/60 text-yellow`} title="Day Trading includes CPR triggers plus V4 PDH/PDL/PWH/PWL next-session plans. A green sprout appears in rows when detected.">
                    Day Trading <span className="text-green/60">{"\u{1F331}"}</span>
                  </th>
                  <th className={`${showNextDayCol ? "" : "hidden"} text-left px-2 py-3 whitespace-nowrap border-l border-border/60 text-muted`} title="Prediction only. Use with caution and confirm with price action.">
                    <span className="block leading-tight">
                      <span className="block">Next Day</span>
                      <span className="block text-[9px] font-normal text-yellow">(Prediction/use with Caution)</span>
                    </span>
                  </th>
                  <th className={`${showShortCol ? "" : "hidden"} w-[42px] text-right px-1.5 py-3 whitespace-nowrap`}>Short%</th>
                  <th className={`${showOptionsCol ? "" : "hidden"} text-left px-3 py-3 whitespace-nowrap`}>Options</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const optEmoji = r.opt_strategy?.includes("Bull") ? "📈"
                                 : r.opt_strategy?.includes("Bear") ? "📉"
                                 : r.opt_strategy?.includes("Butterfly") ? "🦋"
                                 : r.opt_strategy?.includes("Condor") ? "🦋"
                                 : r.opt_strategy?.includes("Straddle") ? "🦋"
                                 : r.opt_strategy ? "📊" : null;
                  const optShort = r.opt_strategy
                    ?.replace("Bull Put Spread",  "Bull Put")
                     .replace("Bull Call Spread", "BCS")
                     .replace("Bear Put Spread",  "BPS")
                     .replace("Iron Butterfly",   "Iron Fly")
                     .replace("Iron Condor",      "Condor")
                     .replace("Long Call",        "Long C")
                     .replace("Long Put",         "Long P");
                  const optAltText = `${r.opt_summary ?? ""}\n${r.opt_alt ?? ""}`;
                  const hasZebra = optAltText.includes("ZEBRA");
                  const hasButterflyAlt = optAltText.includes("Butterfly") && !r.opt_strategy?.includes("Butterfly");
                  const hasCondorAlt = optAltText.includes("Iron Condor") && !r.opt_strategy?.includes("Condor");
                  const topCall = r.opt_liquid?.find(c => c.type === "CALL");
                  const topPut = r.opt_liquid?.find(c => c.type === "PUT");
                  const hasOtmData = topCall || topPut;
                  const otmInterp = hasOtmData ? interpretOtmFlow(r.opt_liquid ?? []) : "";
                  const sectorKey = sectorMacroKey(r.sector);
                  const sectorItem = sectorKey ? sectorMacro[sectorKey] : undefined;
                  const sectorToneInfo = sectorItem ? sectorTone(sectorItem.chg_1d) : null;
                  const sectorSign = sectorItem && sectorItem.chg_1d > 0 ? "+" : "";
                  return (
                    <tr key={r.ticker}
                      className="border-b border-border/40 hover:bg-surface/50 transition-colors">
                      <td className="pl-4 pr-3 py-2.5 whitespace-nowrap sticky left-0 bg-card">
                        <Link href={`/stock/${r.ticker}`}
                          className="font-bold text-white hover:text-accent transition-colors">
                          {r.ticker}
                        </Link>
                        {r.vol_surge && <span className="ml-1 text-[10px] text-yellow">⚡</span>}
                      </td>
                      <td className="w-[88px] min-w-[88px] max-w-[88px] px-2 py-2.5 text-center align-middle">
                        {r.sector && r.sector !== "Unknown" ? (
                          <span
                            className={`inline-flex w-[76px] items-center justify-center gap-1 rounded border px-1 py-0.5 text-[10px] leading-tight whitespace-normal break-words ${
                              sectorToneInfo
                                ? `${sectorToneInfo.border} ${sectorToneInfo.bg} ${sectorToneInfo.text}`
                                : "border-border/60 bg-surface/60 text-muted"
                            }`}
                            title={
                              sectorItem
                                ? `${r.sector}: sector ETF ${sectorItem.ticker} ${sectorSign}${sectorItem.chg_1d.toFixed(2)}% 1D. This is sector sentiment, not the ticker verdict.`
                                : r.sector
                            }
                          >
                            {sectorToneInfo && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sectorToneInfo.dot}`} />}
                            <span>{r.sector}</span>
                          </span>
                        ) : (
                          <span className="text-muted/40 text-xs">—</span>
                        )}
                          {/*

                          {hasOtmData && (
                            <div
                              className="cursor-pointer select-none"
                              onDoubleClick={() => setOtmModal({ r })}
                              title={otmInterp || "Double-click to view all OTM contracts"}
                            >
                              <span className="flex flex-col gap-0.5">
                                {[topCall, topPut].filter(Boolean).map((c, i) => {
                                  const cc = c!.type === "CALL" ? "text-green" : "text-red";
                                  return (
                                    <span key={i} className={`flex items-center gap-1 text-[10px] font-mono ${c!.unusual ? "bg-yellow/5 rounded px-0.5" : ""}`}>
                                      {c!.unusual && <span className="text-yellow text-[8px]">⚡</span>}
                                      <span className={`font-bold ${cc}`}>{c!.type[0]}</span>
                                      <span className="text-white">${c!.strike}</span>
                                      <span className="text-muted">{c!.otm_pct}%otm</span>
                                      <span className={c!.vol_oi_ratio > 0.5 ? "text-yellow" : "text-muted"}>
                                        {c!.volume >= 1000 ? `${(c!.volume / 1000).toFixed(1)}K` : c!.volume}v
                                      </span>
                                    </span>
                                  );
                                })}
                              </span>
                            </div>
                          )}
                          */}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-white whitespace-nowrap">
                        ${r.price?.toFixed(2)}
                      </td>
                      <td className="px-3 py-2.5 text-center whitespace-nowrap" title={r.lre_reason ?? ""}>
                        <div className="flex flex-col items-center leading-tight gap-0.5">
                          <span className={`text-xs font-semibold ${verdictColor[r.verdict ?? ""] ?? "text-muted"}`}>
                            {r.verdict}
                          </span>
                          {r.verdict_flip_text && (
                            <span
                              className="max-w-[62px] whitespace-normal text-[9px] font-mono text-yellow cursor-help"
                              title={`${r.verdict_flip_text}${r.verdict_flip_days != null ? ` (${r.verdict_flip_days} days ago)` : ""}`}
                            >
                              Flip{r.verdict_flip_days != null ? ` (${r.verdict_flip_days}d)` : ""}
                            </span>
                          )}
                          {r.lre_score && r.lre_score > 0 && (
                            <>
                              <span className={`text-xs font-bold ${
                                r.lre_score >= 5 ? "text-yellow" :
                                r.lre_score >= 4 ? "text-green"  :
                                r.lre_score >= 3 ? "text-accent" :
                                                    "text-muted"
                              }`}>
                                {"★".repeat(r.lre_score)}<span className="text-muted/30">{"☆".repeat(5 - r.lre_score)}</span>
                              </span>
                              <span className={`text-[9px] font-mono ${
                                r.lre_direction === "LONG"  ? "text-green" :
                                r.lre_direction === "SHORT" ? "text-red"   :
                                                              "text-muted"
                              }`}>
                                {r.lre_label}
                              </span>
                              {r.lre_status && (() => {
                                const styles: Record<string, string> = {
                                  ACTIVE:      "bg-green/15 text-green border-green/30",
                                  DISCOUNT:    "bg-accent/15 text-accent border-accent/30",
                                  STALE:       "bg-yellow/15 text-yellow border-yellow/30",
                                  INVALIDATED: "bg-red/15 text-red border-red/30",
                                };
                                return (
                                  <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${styles[r.lre_status!] ?? "text-muted border-border"}`}>
                                    {r.lre_status}
                                  </span>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      </td>
                      <td className={`${showLongTermCol ? "" : "hidden"} px-3 py-2.5 text-center whitespace-nowrap`} title={r.lre_reason ?? ""}>
                        {r.long_term_spring && (
                          <div className="mb-1 inline-flex items-center justify-center gap-1 text-[10px] font-mono text-green">
                            <SpringMarker title={r.long_term_spring_text} />
                            Weekly spring
                          </div>
                        )}
                        <div className="flex flex-col items-center gap-1">
                        {r.w30ma_curl && (
                          <div
                            className="inline-flex items-center justify-center gap-1 rounded border border-green/30 bg-green/10 px-1.5 py-0.5 text-[9px] font-semibold text-green cursor-help"
                            title={r.w30ma_reason ?? "Weinstein 30-week MA curling up (Stage 1→2 turn)"}
                          >
                            📈 30wk MA ↑
                            {r.w30ma != null && (
                              <span className="font-mono opacity-70">{fmtMoney(r.w30ma)}</span>
                            )}
                          </div>
                        )}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => openSeason(r.ticker)}
                          onKeyDown={e => (e.key === "Enter" || e.key === " ") && openSeason(r.ticker)}
                          className="inline-flex items-center justify-center gap-1 rounded border border-border/60 bg-card px-1.5 py-0.5 text-[9px] font-semibold text-muted hover:text-white hover:border-white/30 cursor-pointer"
                          title="Seasonality — tap for this month + 12-month history (loaded on demand)"
                        >
                          📅 Seasonality 📊
                        </div>
                        </div>
                        {(r.lre_entry != null && r.lre_stop != null) ? (
                          <div className="flex flex-col items-center leading-tight gap-0.5">
                            <div className="flex flex-col items-center gap-0.5 font-mono">
                              <span className="text-[9px] text-muted">Entry Range</span>
                              <span className="text-[10px] text-white">{lreRangeText(r)}</span>
                            </div>
                            {r.lre_entry != null && r.price != null && r.lre_entry > 0 && (() => {
                              const diffPct = ((r.price! - r.lre_entry!) / r.lre_entry!) * 100;
                              const stale = Math.abs(diffPct) > 5;
                              const dirLong = r.lre_direction === "LONG";
                              // For long: positive diff = price above entry = need pullback (stale)
                              // For short: negative diff = price below entry = need bounce (stale)
                              const needsPullback = (dirLong && diffPct > 5) || (!dirLong && diffPct < -5);
                              const sign = diffPct > 0 ? "+" : "";
                              return (
                                <span className={`text-[9px] font-mono ${
                                  needsPullback ? "text-yellow" :
                                  stale          ? "text-muted/60" :
                                                   "text-green/80"
                                }`}>
                                  {sign}{diffPct.toFixed(1)}% from entry
                                </span>
                              );
                            })()}
                            {r.lre_risk_pct != null && (
                              <span className="text-[9px] font-mono text-muted">
                                Risk {r.lre_risk_pct.toFixed(2)}%
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted/40 text-xs">—</span>
                        )}
                        {r.signals && (
                          <div className="mt-1 flex max-w-[140px] flex-wrap justify-center gap-1 leading-tight whitespace-normal" title={r.signals}>
                            {r.signals.split(" | ").slice(0, 4).map((signal, idx) => (
                              <span
                                key={`${r.ticker}-signal-${idx}`}
                                className="max-w-[132px] rounded border px-1 py-0.5 text-[8px] font-mono font-semibold leading-tight break-words cursor-help"
                                style={fundamentalChipStyle(signal)}
                                title={signal}
                                aria-label={signal}
                              >
                                {signal}
                              </span>
                            ))}
                            {r.signals.split(" | ").length > 4 && (
                              <span
                                className="rounded border border-border bg-surface px-1 py-0.5 text-[8px] font-mono text-muted cursor-help"
                                title={r.signals}
                              >
                                +{r.signals.split(" | ").length - 4}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="mt-1 flex flex-col items-center gap-0.5">
                          {r.valuation_label && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${valuationClass(r.valuation_label)}`}
                              title={[r.valuation_source, r.valuation_reason].filter(Boolean).join(" | ") || "Current valuation estimate from fundamentals"}
                            >
                              {r.valuation_label}
                            </span>
                          )}
                          {r.cyclical_peak_risk && (
                            <span
                              className="rounded border px-1.5 py-0.5 text-[9px] font-semibold border-orange-400/40 bg-orange-400/10 text-orange-300"
                              title={r.cyclical_peak_reason || "Trailing P/E suggests peak-cycle earnings — fundamentals may be inflated"}
                            >
                              ⟳ Cyclical Peak
                            </span>
                          )}
                          {r.long_runway && (
                            <span
                              className="rounded border px-1.5 py-0.5 text-[9px] font-semibold border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                              title={r.long_runway_reason || "Durable fundamentals: positive growth, healthy margins, positive FCF, moderate debt"}
                            >
                              ✦ Long Runway
                            </span>
                          )}
                          {r.multi_bagger && (
                            <span
                              className="rounded border px-1.5 py-0.5 text-[9px] font-semibold border-purple-400/40 bg-purple-400/10 text-purple-300"
                              title={r.multi_bagger_reason || "Speculative growth candidate — high revenue growth, small cap, manageable debt. Higher reward, higher loss rate."}
                            >
                              🚀 Multi-Bagger
                            </span>
                          )}
                          {r.valuation_pe_fair_value != null && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                                (r.valuation_pe_upside_pct ?? 0) >= 0
                                  ? "border-green/30 bg-green/10 text-green"
                                  : "border-red/30 bg-red/10 text-red"
                              }`}
                              title={[r.valuation_pe_source || "P/E fair value", r.valuation_reason].filter(Boolean).join(" | ")}
                            >
                              Fund {fmtMoney(r.valuation_pe_fair_value)} {fmtSignedPct(r.valuation_pe_upside_pct)}
                            </span>
                          )}
                          {r.valuation_analyst_fair_value != null && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                                (r.valuation_analyst_upside_pct ?? 0) >= 0
                                  ? "border-green/30 bg-green/10 text-green"
                                  : "border-red/30 bg-red/10 text-red"
                              }`}
                              title="Analyst consensus target — updates with current price"
                            >
                              Anlyst {fmtMoney(r.valuation_analyst_fair_value)} {fmtSignedPct(r.valuation_analyst_upside_pct)}
                            </span>
                          )}
                          {r.valuation_pe_fair_value == null && r.valuation_analyst_fair_value == null && valuationFairValue(r) != null && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                                (valuationUpsidePct(r) ?? 0) >= 0
                                  ? "border-green/30 bg-green/10 text-green"
                                  : "border-red/30 bg-red/10 text-red"
                              }`}
                              title={[r.valuation_source || "Score-implied fair value", r.valuation_reason].filter(Boolean).join(" | ")}
                            >
                              FV {fmtMoney(valuationFairValue(r))} {fmtSignedPct(valuationUpsidePct(r))}
                            </span>
                          )}
                          <a
                            href={`https://finance.yahoo.com/quote/${encodeURIComponent(r.ticker)}/financials/`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[9px] font-mono text-accent hover:text-white underline-offset-2 hover:underline"
                            title={`${r.ticker} Yahoo financials`}
                          >
                            Financials
                          </a>
                        </div>
                      </td>
                      <td className={`${showSwingCol ? "" : "hidden"} px-2 py-2 text-left text-[10px] whitespace-nowrap border-l border-border/30`}>
                        <div className="flex flex-col gap-0.5 font-mono leading-tight">
                          {(r.multi_bagger || r.long_runway) && (
                            <span
                              className={`inline-flex max-w-[130px] items-center gap-1 whitespace-normal font-semibold ${
                                r.multi_bagger ? "text-purple-300" : "text-emerald-300"
                              }`}
                              title={r.multi_bagger
                                ? (r.multi_bagger_reason || "Speculative growth candidate")
                                : (r.long_runway_reason || "Durable-growth fundamentals")}
                            >
                              {r.multi_bagger ? "🚀 Speculative" : "✦ Growth"}
                            </span>
                          )}
                          {(() => {
                            const hasHl = (r.news_headlines?.length ?? 0) > 0;
                            const good = r.news === "Good";
                            const bad  = r.news === "Bad";
                            const cls  = good ? "text-green" : bad ? "text-red" : "text-muted";
                            const lbl  = good ? "Positive" : bad ? "Negative" : "No news";
                            const net  = newsNet(r);
                            const sc   = (r.news_good || r.news_bad)
                              ? ` (+${r.news_good ?? 0}/-${r.news_bad ?? 0} · Σ${net >= 0 ? "+" : ""}${net})`
                              : "";
                            return (
                              <span
                                role={hasHl ? "button" : undefined}
                                tabIndex={hasHl ? 0 : undefined}
                                onClick={hasHl ? () => setNewsModal({ r }) : undefined}
                                onKeyDown={hasHl ? (e => (e.key === "Enter" || e.key === " ") && setNewsModal({ r })) : undefined}
                                className={`inline-flex max-w-[130px] items-center gap-1 whitespace-normal font-semibold ${cls} ${hasHl ? "cursor-pointer hover:underline" : ""}`}
                                title={[
                                  `News: ${r.news ?? "No"}${sc} (Finviz → yfinance)`,
                                  ...((r.news_headlines ?? []).slice(0, 8).map(
                                    hd => `${hd.s === "Good" ? "🟢" : hd.s === "Bad" ? "🔴" : "⚪"} ${hd.h}`
                                  )),
                                  hasHl ? "— tap for all headlines —" : "",
                                ].filter(Boolean).join("\n")}
                              >
                                📰 {lbl}{sc}
                              </span>
                            );
                          })()}
                          {r.swing_spring && (
                            <span className="inline-flex max-w-[130px] items-center gap-1 whitespace-normal text-green">
                              <SpringMarker title={r.swing_spring_text} />
                              Daily spring
                            </span>
                          )}
                          {r.lre_takeaway && (
                            <span className={`max-w-[130px] whitespace-normal ${
                              r.lre_takeaway.includes("bounce risk") || r.lre_takeaway.includes("fade risk")
                                ? "text-yellow"
                                : r.lre_direction === "LONG"
                                  ? "text-green/80"
                                  : r.lre_direction === "SHORT"
                                    ? "text-red/80"
                                    : "text-muted"
                            }`}>
                              <span className="font-semibold text-white">{r.ticker}</span>
                              {r.verdict ? `, ${r.verdict}` : ""}, {r.lre_takeaway}
                            </span>
                          )}
                          {r.swing_prebreakout && (
                            <div
                              className="grid grid-cols-[44px_96px] gap-x-1 gap-y-0.5 rounded border border-yellow/20 bg-yellow/5 p-1 text-[10px] font-mono"
                              title={[
                                r.swing_prebreakout_trigger,
                                r.swing_prebreakout_invalidation,
                                r.swing_prebreakout_reason,
                              ].filter(Boolean).join(" | ") || undefined}
                            >
                              <span className="text-yellow">PreBO</span>
                              <span className="text-right text-yellow">
                                {r.swing_prebreakout_dist_pct != null ? `${r.swing_prebreakout_dist_pct}%` : "-"} under
                              </span>
                              <span className="text-muted">Break</span>
                              <span className="text-right text-accent">{fmtMoney(r.swing_prebreakout_level)}</span>
                              <span className="text-muted">Score</span>
                              <span className="text-right text-white">{r.swing_prebreakout_score ?? "-"}</span>
                              <span className="text-muted">Why</span>
                              <span className="text-right text-muted/80 whitespace-normal">{r.swing_prebreakout_reason ?? "-"}</span>
                            </div>
                          )}
                          {r.btd_trigger && (
                            <div
                              className="mt-1 rounded border border-green/20 bg-green/5 px-1 py-0.5 text-[10px] font-mono text-green"
                              title={r.btd_trigger_text || undefined}
                            >
                              BTD Trigger{r.btd_trigger_text ? `: ${r.btd_trigger_text}` : ""}
                            </div>
                          )}
                          <div className="grid grid-cols-[44px_64px] gap-x-1 gap-y-0.5">
                            <span className="text-muted">Entry</span><span className="text-right text-accent">{fmtMoney(r.entry)}</span>
                            <span className="text-muted">Stop</span><span className="text-right text-red">{fmtMoney(r.stop_loss)}</span>
                            <span className="text-muted">T1</span><span className="text-right text-green">{fmtMoney(r.target1)}</span>
                            <span
                              className="text-muted"
                              title={r.t1_days_basis || "Approximate trading days to Swing T1"}
                            >
                              T1 ETA
                            </span>
                            <span className="text-right text-green/80">{approxDays(r.t1_days, r.t1_days_text)}</span>
                            <span className="text-muted">Reward</span><span className="text-right text-green">{rewardPct(r.entry, r.target1)}</span>
                            <span className="text-muted">Risk</span><span className="text-right text-muted">{r.risk_pct ? `${r.risk_pct}%` : "—"}</span>
                            {r.wk_atr != null && (
                              <>
                                <span className="text-muted" title="Weekly ATR (14w) — typical weekly range">WkATR</span>
                                <span className="text-right text-white">
                                  {fmtMoney(r.wk_atr)}{r.wk_atr_pct != null ? ` (${r.wk_atr_pct}%)` : ""}
                                </span>
                              </>
                            )}
                          </div>
                          {(r.ema11 != null || r.ema20 != null || r.ema50 != null || r.ema200 != null) && (
                            <div
                              className="mt-1 grid grid-cols-[44px_86px] gap-x-1 gap-y-0.5 border-t border-border/20 pt-1 text-[10px] font-mono"
                              title="Visible swing EMAs: 11 / 20 / 50 / 200"
                            >
                              <span className="text-muted">EMA11</span><span className="text-right text-accent">{fmtMoney(r.ema11)}</span>
                              <span className="text-muted">EMA20</span><span className="text-right text-accent">{fmtMoney(r.ema20)}</span>
                              <span className="text-muted">EMA50</span><span className="text-right text-yellow">{fmtMoney(r.ema50)}</span>
                              <span className="text-muted">EMA200</span><span className="text-right text-white">{fmtMoney(r.ema200)}</span>
                            </div>
                          )}
                          {(r.prev_week_high != null || r.prev_month_high != null || r.wk52_high != null) && (
                            <div
                              className="grid grid-cols-[42px_96px] gap-x-1 gap-y-0.5 border-t border-border/20 pt-1 mt-1 text-[10px] font-mono"
                              title="Multi-timeframe S/R for swing context — Prior Week / Prior Month / 52-week High & Low. Excludes today's bar."
                            >
                              {r.prev_week_high != null && (
                                <>
                                  <span className="text-muted">PWH/L</span>
                                  <span className="text-right">
                                    <span className="text-green/80">{fmtMoney(r.prev_week_high)}</span>
                                    <span className="text-muted/50"> / </span>
                                    <span className="text-red/80">{fmtMoney(r.prev_week_low)}</span>
                                  </span>
                                </>
                              )}
                              {r.prev_month_high != null && (
                                <>
                                  <span className="text-muted">PMH/L</span>
                                  <span className="text-right">
                                    <span className="text-green/80">{fmtMoney(r.prev_month_high)}</span>
                                    <span className="text-muted/50"> / </span>
                                    <span className="text-red/80">{fmtMoney(r.prev_month_low)}</span>
                                  </span>
                                </>
                              )}
                              {r.wk52_high != null && (
                                <>
                                  <span className="text-muted">52wH/L</span>
                                  <span className="text-right">
                                    <span className="text-green/80">{fmtMoney(r.wk52_high)}</span>
                                    <span className="text-muted/50"> / </span>
                                    <span className="text-red/80">{fmtMoney(r.wk52_low)}</span>
                                  </span>
                                </>
                              )}
                            </div>
                          )}
                          {r.swing_invalidation_text && (
                            <div className="grid grid-cols-[34px_96px] gap-x-1 gap-y-0.5">
                              <span className="text-muted">Inv</span>
                              <span className="text-right text-red whitespace-normal">{r.swing_invalidation_text}</span>
                            </div>
                          )}
                          {(() => {
                            const e = fmtEarnings(r.next_earnings);
                            if (!e) return null;
                            return (
                              <div className="grid grid-cols-[34px_96px] gap-x-1 gap-y-0.5">
                                <span className="text-muted">Earn</span>
                                <span
                                  className={`text-right whitespace-normal ${e.soon ? "text-yellow font-semibold" : "text-muted"}`}
                                  title={`Next earnings: ${r.next_earnings}${e.soon ? " — within a week" : ""}`}
                                >
                                  📅 {e.text}
                                </span>
                              </div>
                            );
                          })()}
                          {(() => {
                            const s = r.btd_state ?? "N/A";
                            if (s === "N/A") return null;
                            const col =
                              s === "TRIGGER"    ? "bg-green/15 text-green border-green/30"   :
                              s === "ARMED"      ? "bg-accent/15 text-accent border-accent/30" :
                              s === "ARMED-DEEP" ? "bg-yellow/15 text-yellow border-yellow/30" :
                              s === "DISARMED"   ? "bg-red/10 text-red border-red/20"          :
                                                   "text-muted/40 border-transparent";
                            return (
                              <div
                                className="mt-1 pt-1 border-t border-border/30 flex items-center gap-1.5 cursor-pointer group select-none"
                                onDoubleClick={() => r.btd_state && r.btd_state !== "N/A" && setBtdModal({ r })}
                                title={[
                                  r.btd_reason,
                                  r.ema11 != null && `EMA 11/20/50/200: ${r.ema11} / ${r.ema20} / ${r.ema50} / ${r.ema200}`,
                                  r.ema50_slope_pct != null && `50EMA slope ${r.ema50_slope_pct > 0 ? "+" : ""}${r.ema50_slope_pct}%`,
                                  "Double-click for detail + copy",
                                ].filter(Boolean).join("  ·  ")}
                              >
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${col}`}>
                                  BTD {s}
                                </span>
                                {r.btd_zone && (
                                  <span className="text-[8px] text-muted/70 whitespace-normal max-w-[80px]">{r.btd_zone}</span>
                                )}
                                <span className="text-muted/40 text-[8px]">⤢</span>
                              </div>
                            );
                          })()}
                        </div>
                      </td>
                      <td
                        className={`${showFibCol ? "" : "hidden"} group px-2 py-2 text-left text-[10px] whitespace-nowrap border-l border-border/30 ${
                          r.fib_target != null || r.near_fib_name
                            ? "cursor-pointer focus:outline-none focus:ring-1 focus:ring-green/40"
                            : ""
                        }`}
                        role={r.fib_target != null || r.near_fib_name ? "button" : undefined}
                        tabIndex={r.fib_target != null || r.near_fib_name ? 0 : undefined}
                        aria-label={r.fib_target != null || r.near_fib_name ? `${r.ticker} Fib Target details` : undefined}
                        onClick={() => (r.fib_target != null || r.near_fib_name) && setFibModal({ r })}
                        onKeyDown={e => {
                          if (!(r.fib_target != null || r.near_fib_name)) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setFibModal({ r });
                          }
                        }}
                        title={[
                          r.fib_target != null ? `Fib target ${fmtMoney(r.fib_target)}` : null,
                          r.fib_target_name ? `Target level ${r.fib_target_name}` : null,
                          r.fib_target_reward_pct != null ? `Reward ${r.fib_target_reward_pct.toFixed(2)}%` : null,
                          targetLadderText(r) ? `Fib target ladder ${targetLadderText(r)}` : null,
                          r.near_fib_name && r.near_fib_price != null ? `Nearest Fib ${r.near_fib_name} ${fmtMoney(r.near_fib_price)}` : null,
                          r.fib_swing_low != null && r.fib_swing_high != null ? `Swing range ${fmtMoney(r.fib_swing_low)} to ${fmtMoney(r.fib_swing_high)}` : null,
                          r.fib_commentary,
                          r.fib_next_earnings ? `Next earnings ${r.fib_next_earnings}` : null,
                          r.fib_last_earnings ? `Last earnings ${r.fib_last_earnings}` : null,
                          r.fib_target_source,
                          r.fib_earn_window ? `Earn window ${r.fib_earn_window}` : null,
                          r.fib_pos_pct != null ? `Swing pos ${r.fib_pos_pct}%` : null,
                          r.weekly_pos_pct != null ? `Weekly pos ${r.weekly_pos_pct}%` : null,
                        ].filter(Boolean).join(" | ") || undefined}
                      >
                        {r.fib_target != null || r.near_fib_name ? (
                          <div className="flex flex-col gap-0.5 leading-tight font-mono">
                            <div className="grid grid-cols-[38px_74px] gap-x-1 gap-y-0.5">
                              <span className="text-muted">Tgt</span>
                              <span className={`text-right ${r.direction === "SHORT" ? "text-red" : "text-green"}`}>
                                {fmtMoney(r.fib_target)}
                              </span>
                              <span className="text-muted">Level</span>
                              <span className="text-right text-white whitespace-normal">{r.fib_target_name ?? "-"}</span>
                              <span className="text-muted">Reward</span>
                              <span className="text-right text-green">
                                {r.fib_target_reward_pct != null ? `${r.fib_target_reward_pct.toFixed(2)}%` : rewardPct(r.price, r.fib_target)}
                              </span>
                              <span className="text-muted">Near</span>
                              <span className="text-right text-muted/80 whitespace-normal">
                                {r.near_fib_name ? `${r.near_fib_name} ${fmtMoney(r.near_fib_price)}` : "-"}
                              </span>
                              <span className="text-muted">Targets</span>
                              <span className="text-right text-muted/80 whitespace-normal">
                                {targetLadderText(r, 3) || "-"}
                              </span>
                              {(r.fib_next_earnings || r.fib_last_earnings) && (
                                <>
                                  <span className="text-muted">Earn</span>
                                  <span className="text-right text-muted/80 whitespace-normal">
                                    {r.fib_next_earnings ? `Next ${r.fib_next_earnings}` : `Last ${r.fib_last_earnings}`}
                                  </span>
                                </>
                              )}
                            </div>
                            {r.fib_commentary && (
                              <div className="mt-1 max-w-[150px] whitespace-normal border-t border-border/30 pt-1 text-[9px] leading-snug text-muted/90">
                                {r.fib_commentary}
                              </div>
                            )}
                            <div className="mt-1 flex max-w-[130px] flex-wrap gap-1">
                              {r.earn_zone && (
                                <span className={`rounded border px-1 py-0.5 text-[9px] ${
                                  r.earn_zone === "LOW" ? "border-green/30 bg-green/10 text-green" :
                                  r.earn_zone === "HIGH" ? "border-red/30 bg-red/10 text-red" :
                                                          "border-yellow/30 bg-yellow/10 text-yellow"
                                }`}>
                                  Earn {r.earn_zone}
                                </span>
                              )}
                              {r.weekly_zone && (
                                <span className={`rounded border px-1 py-0.5 text-[9px] ${
                                  r.weekly_zone === "LOW" ? "border-green/30 bg-green/10 text-green" :
                                  r.weekly_zone === "HIGH" ? "border-red/30 bg-red/10 text-red" :
                                                            "border-yellow/30 bg-yellow/10 text-yellow"
                                }`}>
                                  Wk {r.weekly_zone}
                                </span>
                              )}
                              {r.fib_compression && (
                                <span className="rounded border border-accent/30 bg-accent/10 px-1 py-0.5 text-[9px] text-accent">
                                  Comp
                                </span>
                              )}
                              {r.fib_target_source && (
                                <span className="rounded border border-border/50 px-1 py-0.5 text-[9px] text-muted">
                                  {r.fib_target_source}
                                </span>
                              )}
                              <span className="rounded border border-green/30 bg-green/10 px-1 py-0.5 text-[9px] text-green">
                                Details
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted/40 text-xs">-</span>
                        )}
                      </td>
                      <td
                        className={`${showDayTradingCol ? "" : "hidden"} px-2 py-2 text-left text-[10px] whitespace-nowrap border-l border-border/30`}
                        title={[r.cpr_interpretation, r.day_spring_text, r.dt4_note, r.dt4_exit_plan, r.cpr_day_15m_volume_text, r.cpr_day_volume_text, r.cpr_day_ref].filter(Boolean).join(" | ") || undefined}
                      >
                        {r.cpr_day_result ? (
                          <div className="flex flex-col gap-0.5 leading-tight font-mono">
                            <span className={`inline-flex max-w-[170px] items-start gap-1 whitespace-normal ${
                                r.cpr_position === "Above" ? "text-green" :
                                r.cpr_position === "Below" ? "text-red"   :
                                                              "text-yellow"
                              }`}
                            >
                              {r.day_spring && <SpringMarker title={r.day_spring_text} />}
                              {r.cpr_interpretation ?? compactDayResult(r.cpr_day_result)}
                            </span>
                            <div className="grid grid-cols-[38px_64px] gap-x-1 gap-y-0.5">
                              <span className="text-muted">Type</span><span className="text-right text-muted/70">{r.cpr_type}</span>
                              <span className="text-muted">Entry</span><span className="text-right text-accent">{fmtMoney(r.cpr_day_entry)}</span>
                              <span className="text-muted">Stop</span><span className="text-right text-red">{fmtMoney(r.cpr_day_stop)}</span>
                              <span className="text-muted">T1</span><span className="text-right text-green">{fmtMoney(r.cpr_day_t1)}</span>
                              <span className="text-muted">Reward</span><span className="text-right text-green">{rewardPct(r.cpr_day_entry, r.cpr_day_t1)}</span>
                            </div>
                            {(r.cpr_day_trigger_text || r.cpr_day_invalidation_text || r.cpr_day_target_text || r.cpr_day_15m_volume_text) && (
                              <div className="mt-1 border-t border-border/30 pt-1">
                                <div className="grid grid-cols-[34px_96px] gap-x-1 gap-y-0.5">
                                  <span className="text-yellow">V2</span><span className="text-yellow whitespace-normal">Trigger</span>
                                  <span className="text-muted">Trig</span><span className="text-right text-accent whitespace-normal">{r.cpr_day_trigger_text ?? "-"}</span>
                                  <span className="text-muted">Inv</span><span className="text-right text-red whitespace-normal">{r.cpr_day_invalidation_text ?? "-"}</span>
                                  <span className="text-muted">Tgt</span><span className="text-right text-green whitespace-normal">{r.cpr_day_target_text ?? "-"}</span>
                                  <span className="text-muted">15m</span><span className={`text-right whitespace-normal ${dayVolumeColor(r.cpr_day_15m_volume_text)}`}>{r.cpr_day_15m_volume_text ?? "15m pending"}</span>
                                </div>
                              </div>
                            )}
                            {hasV4Plan(r) && (
                              <div
                                className="group mt-1 cursor-pointer border-t border-border/30 pt-1 focus:outline-none focus:ring-1 focus:ring-yellow/40"
                                role="button"
                                tabIndex={0}
                                aria-label={`${r.ticker} Day Trading V4 details`}
                                onClick={() => setDt4Modal({ r })}
                                onKeyDown={e => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setDt4Modal({ r });
                                  }
                                }}
                                title={dt4DetailText(r)}
                              >
                                <div className="grid grid-cols-[34px_96px] gap-x-1 gap-y-0.5">
                                  <span className="text-yellow">V4</span>
                                  <span className={`whitespace-normal ${
                                    r.dt4_side === "long"  ? "text-green" :
                                    r.dt4_side === "short" ? "text-red"   :
                                                              "text-yellow"
                                  }`}>
                                    {r.dt4_context === "next_session" ? "Next: " : ""}
                                    {(r.dt4_setup ?? "").replaceAll("_", " ")}
                                    {r.dt4_grade ? ` · ${r.dt4_grade}` : ""}
                                  </span>
                                  <span className="text-muted">Bias</span>
                                  <span className="text-right text-muted/80 whitespace-normal">{r.dt4_bias ?? "-"}</span>
                                  <span className="text-muted">{r.dt4_setup === "range_wait" ? "Support" : "Lvl"}</span>
                                  <span className="text-right text-accent whitespace-normal">
                                    {r.dt4_setup === "range_wait"
                                      ? `PDL ${fmtMoney(r.dt4_pdl)} / PWL ${fmtMoney(r.dt4_pwl)}`
                                      : `${r.dt4_level ?? "PDH/PDL"} ${fmtMoney(r.dt4_level_val)}`}
                                  </span>
                                  <span className="text-muted">{r.dt4_setup === "range_wait" ? "Resist" : "Watch"}</span>
                                  <span className="text-right text-accent whitespace-normal">
                                    {r.dt4_setup === "range_wait"
                                      ? `PDH ${fmtMoney(r.dt4_pdh)} / PWH ${fmtMoney(r.dt4_pwh)}`
                                      : fmtMoney(r.dt4_entry)}
                                  </span>
                                  <span className="text-muted">{r.dt4_setup === "range_wait" ? "Entry" : "Stop"}</span>
                                  <span className={`text-right whitespace-normal ${r.dt4_setup === "range_wait" ? "text-accent" : "text-red"}`}>
                                    {r.dt4_setup === "range_wait" ? "wait for reclaim/reject" : fmtMoney(r.dt4_stop)}
                                  </span>
                                  <span className="text-muted">{r.dt4_setup === "range_wait" ? "Risk" : "T1"}</span>
                                  <span className="text-right text-green whitespace-normal">
                                    {r.dt4_setup === "range_wait" ? "after trigger" : fmtMoney(r.dt4_t1)}
                                  </span>
                                  {r.dt4_t2 != null && (
                                    <>
                                      <span className="text-muted">T2</span>
                                      <span className="text-right text-green/70">{fmtMoney(r.dt4_t2)}</span>
                                    </>
                                  )}
                                  <span className="text-muted">{r.dt4_setup === "range_wait" ? "Tgt" : "R:R"}</span>
                                  {r.dt4_setup === "range_wait" && (
                                    <span className="text-right text-accent whitespace-normal">VWAP/mid, then opposite edge</span>
                                  )}
                                  {r.dt4_setup !== "range_wait" && (
                                  <span className="text-right text-accent">{r.dt4_rr != null ? `${r.dt4_rr}×` : "-"}</span>
                                  )}
                                  <span className="text-muted">Trig</span>
                                  <span className="text-right text-accent whitespace-normal">{r.dt4_trigger ?? "-"}</span>
                                  <span className="text-muted">Inv</span>
                                  <span className="text-right text-red whitespace-normal">{r.dt4_invalidation ?? "-"}</span>
                                </div>
                                <div className="mt-1 flex justify-end">
                                  <span className="rounded border border-yellow/30 bg-yellow/10 px-1 py-0.5 text-[9px] text-yellow">
                                    Details
                                  </span>
                                </div>
                              </div>
                            )}
                            {r.dt3_setup && (
                              (r.dt3_setup === "no_setup" || r.dt3_setup === "error") ? (
                                // Heartbeat: v3 ran but found nothing, or
                                // errored. Either way, surface a visible
                                // line so the column never silently
                                // disappears — and show the levels v3 is
                                // watching when available.
                                <div
                                  className="mt-1 border-t border-border/30 pt-1 text-[10px] font-mono whitespace-normal"
                                  title={r.dt3_rationale ?? (r.dt3_setup === "error" ? "V3 errored — see backend logs." : "V3 engine running — no qualifying setup at this bar.")}
                                >
                                  <span className={r.dt3_setup === "error" ? "text-red/70" : "text-accent/60"}>V3</span>
                                  <span className={r.dt3_setup === "error" ? "text-red/80" : "text-muted/70"}>
                                    {r.dt3_setup === "error" ? " · errored" : " · waiting"}
                                  </span>
                                  {(r.dt3_pwh != null || r.dt3_pwl != null) && (
                                    <div className="text-muted/50 leading-tight">
                                      watching PWH {fmtMoney(r.dt3_pwh)} / PWL {fmtMoney(r.dt3_pwl)}
                                    </div>
                                  )}
                                  {(r.dt3_pdh != null || r.dt3_pdl != null) && (
                                    <div className="text-muted/40 leading-tight">
                                      PDH {fmtMoney(r.dt3_pdh)} / PDL {fmtMoney(r.dt3_pdl)}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div
                                  className="mt-1 border-t border-border/30 pt-1"
                                  title={r.dt3_rationale ?? undefined}
                                >
                                  <div className="grid grid-cols-[34px_96px] gap-x-1 gap-y-0.5">
                                    <span className="text-accent">V3</span>
                                    <span className={`whitespace-normal ${
                                      r.dt3_side === "long"  ? "text-green" :
                                      r.dt3_side === "short" ? "text-red"   :
                                                                "text-accent"
                                    }`}>
                                      {(r.dt3_setup ?? "").replace("_", "+")}
                                      {r.dt3_side ? ` · ${r.dt3_side}` : ""}
                                      {r.dt3_grade ? ` · ${r.dt3_grade}` : ""}
                                    </span>
                                    <span className="text-muted">Lvl</span>
                                    <span className="text-right text-accent whitespace-normal">
                                      {r.dt3_level ?? "—"} {fmtMoney(r.dt3_level_val)}
                                    </span>
                                    <span className="text-muted">Entry</span>
                                    <span className="text-right text-accent">{fmtMoney(r.dt3_entry)}</span>
                                    <span className="text-muted">Stop</span>
                                    <span className="text-right text-red">{fmtMoney(r.dt3_stop)}</span>
                                    <span className="text-muted">T1</span>
                                    <span className="text-right text-green">{fmtMoney(r.dt3_t1)}</span>
                                    {r.dt3_t2 != null && (
                                      <>
                                        <span className="text-muted">T2</span>
                                        <span className="text-right text-green/70">{fmtMoney(r.dt3_t2)}</span>
                                      </>
                                    )}
                                    <span className="text-muted">R:R</span>
                                    <span className="text-right text-accent">{r.dt3_rr != null ? `${r.dt3_rr}×` : "—"}</span>
                                  </div>
                                </div>
                              )
                            )}
                          </div>
                        ) : <span className="text-muted/40">—</span>}
                      </td>
                      <td
                        className={`${showNextDayCol ? "" : "hidden"} px-2 py-2 text-left text-[10px] whitespace-nowrap border-l border-border/30`}
                        title={r.next_day_summary ?? r.next_day_prediction ?? undefined}
                      >
                        {(r.next_day_outcome || r.next_day_bias) ? (
                          <div className="flex flex-col gap-0.5 leading-tight font-mono">
                            <span className={`max-w-[165px] whitespace-normal font-semibold ${nextDayColor(r.next_day_outcome ?? r.next_day_bias)}`}>
                              {r.next_day_outcome ?? r.next_day_bias}
                            </span>
                            {r.next_day_bias && r.next_day_outcome && (
                              <span className="max-w-[165px] whitespace-normal text-[9px] text-muted">
                                {r.next_day_bias}
                              </span>
                            )}
                            {r.next_day_date && (
                              <span className="text-[9px] text-muted">{r.next_day_date}</span>
                            )}
                            <div className="grid grid-cols-[42px_72px] gap-x-1 gap-y-0.5">
                              <span className="text-muted">ATR</span><span className="text-right text-accent">{fmtMoney(r.next_day_atr)}</span>
                              <span className="text-muted">Up &gt;</span><span className="text-right text-green">{fmtMoney(r.next_day_trigger_up)}</span>
                              <span className="text-muted">Dn &lt;</span><span className="text-right text-red">{fmtMoney(r.next_day_trigger_down)}</span>
                              <span className="text-muted">Pivot</span><span className="text-right text-muted/80">{fmtMoney(r.next_day_pivot)}</span>
                              <span className="text-muted">Ref</span><span className="text-right text-muted/80 truncate">{r.next_day_ref ?? "N/A"}</span>
                              <span className="text-muted">Target</span><span className={`text-right ${nextDayColor(r.next_day_bias)}`}>{fmtMoney(r.next_day_target)}</span>
                            </div>
                          </div>
                        ) : <span className="text-muted/40">N/A</span>}
                      </td>
                      <td className={`${showShortCol ? "" : "hidden"} w-[42px] px-1.5 py-2 text-right font-mono text-xs whitespace-nowrap`}>
                        {r.short_pct != null
                          ? <span className={r.short_pct >= 20 ? "text-red font-bold" : r.short_pct >= 10 ? "text-yellow" : "text-muted"}>
                              {Math.round(r.short_pct)}%
                            </span>
                          : <span className="text-muted">—</span>}
                      </td>
                      <td className={`${showOptionsCol ? "" : "hidden"} px-3 py-2.5 text-left whitespace-nowrap`}>
                        <div className="flex flex-col gap-1.5">
                          <div
                            onDoubleClick={() => (r.opt_summary || r.opt_alt) && setOptModal({ r })}
                            title={(r.opt_summary || r.opt_alt) ? "Double-click to view & copy" : undefined}
                          >
                        {optEmoji && optShort ? (
                          <span className="flex items-center gap-1 cursor-pointer select-none group">
                            <span className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                              r.opt_source === "alpaca"
                                ? "bg-accent/10 text-accent border-accent/30"
                                : "bg-muted/10 text-muted border-border"
                            }`}>
                              {r.opt_source === "alpaca" ? "A" : "Y"}
                            </span>
                            <span className="text-xs font-mono">
                              {optEmoji}{" "}
                              <span className={
                                r.direction === "LONG"  ? "text-green" :
                                r.direction === "SHORT" ? "text-red"   : "text-accent"
                              }>{optShort}</span>
                              {r.opt_debit != null && (
                                <span className="text-muted ml-1">${r.opt_debit}</span>
                              )}
                              {r.opt_profit != null && (
                                <span className="text-green ml-1">→${r.opt_profit}</span>
                              )}
                              {hasZebra && (
                                <span className="text-accent ml-1">Z</span>
                              )}
                              {hasButterflyAlt && (
                                <span className="text-yellow ml-1">Fly</span>
                              )}
                              {hasCondorAlt && (
                                <span className="text-green ml-1">IC</span>
                              )}
                            </span>
                            <span className="text-muted/40 text-[10px]">⤢</span>
                          </span>
                        ) : (
                          <span className="text-muted text-xs">—</span>
                        )}
                          </div>

                          {hasOtmData && (
                            <div
                              className="cursor-pointer select-none"
                              onDoubleClick={() => setOtmModal({ r })}
                              title={otmInterp || "Double-click to view all OTM contracts"}
                            >
                              <span className="flex flex-col gap-0.5">
                                {[topCall, topPut].filter(Boolean).map((c, i) => {
                                  const cc = c!.type === "CALL" ? "text-green" : "text-red";
                                  return (
                                    <span key={i} className={`flex items-center gap-1 text-[10px] font-mono ${c!.unusual ? "bg-yellow/5 rounded px-0.5" : ""}`}>
                                      {c!.unusual && <span className="text-yellow text-[8px]">⚡</span>}
                                      <span className={`font-bold ${cc}`}>{c!.type[0]}</span>
                                      <span className="text-white">${c!.strike}</span>
                                      <span className="text-muted">{c!.otm_pct}%otm</span>
                                      <span className={c!.vol_oi_ratio > 0.5 ? "text-yellow" : "text-muted"}>
                                        {c!.volume >= 1000 ? `${(c!.volume / 1000).toFixed(1)}K` : c!.volume}v
                                      </span>
                                    </span>
                                  );
                                })}
                              </span>
                            </div>
                          )}
                          {(() => {
                            const e = fmtEarnings(r.next_earnings);
                            if (!e) return null;
                            return (
                              <span
                                className={`text-[10px] font-mono ${e.soon ? "text-yellow font-semibold" : "text-muted"}`}
                                title={`Next earnings: ${r.next_earnings}${e.soon ? " — within a week" : ""}`}
                              >
                                📅 Earn {e.text}
                              </span>
                            );
                          })()}
                        </div>
                      </td>

                      {/* OTM Liquid column */}
                      {(() => {
                        const topCall    = r.opt_liquid?.find(c => c.type === "CALL");
                        const topPut     = r.opt_liquid?.find(c => c.type === "PUT");
                        const hasData    = topCall || topPut;
                        const interp     = hasData ? interpretOtmFlow(r.opt_liquid ?? []) : "";
                        return (
                          <td
                            className="hidden"
                            onDoubleClick={() => hasData && setOtmModal({ r })}
                            title={interp || (hasData ? "Double-click to view all OTM contracts" : undefined)}
                          >
                            {hasData ? (
                              <span className="flex flex-col gap-0.5 cursor-pointer select-none group">
                                {[topCall, topPut].filter(Boolean).map((c, i) => {
                                  const cc = c!.type === "CALL" ? "text-green" : "text-red";
                                  return (
                                    <span key={i} className={`flex items-center gap-1 text-[10px] font-mono ${c!.unusual ? "bg-yellow/5 rounded px-0.5" : ""}`}>
                                      {c!.unusual && <span className="text-yellow text-[8px]">⚡</span>}
                                      <span className={`font-bold ${cc}`}>{c!.type[0]}</span>
                                      <span className="text-white">${c!.strike}</span>
                                      <span className="text-muted">{c!.otm_pct}%otm</span>
                                      <span className={c!.vol_oi_ratio > 0.5 ? "text-yellow" : "text-muted"}>
                                        {c!.volume >= 1000 ? `${(c!.volume/1000).toFixed(1)}K` : c!.volume}v
                                      </span>
                                    </span>
                                  );
                                })}
                                <span className="text-muted/40 text-[9px]">⤢ details</span>
                              </span>
                            ) : (
                              <span className="text-muted text-xs">—</span>
                            )}
                          </td>
                        );
                      })()}

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Scanning skeleton ── */}
      {scanning && filtered.length === 0 && (
        <div className="card flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted text-sm">Scanning {progress.total} stocks…</p>
        </div>
      )}

      {/* ── Empty state ── */}
      {!scanning && results.length > 0 && filtered.length === 0 && (
        <div className="card flex items-center justify-center py-12">
          <p className="text-muted text-sm">No stocks match the current filter.</p>
        </div>
      )}

      {/* ── Options summary modal ── */}
      {optModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOptModal(null)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-lg mx-4 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">{optModal.r.ticker} — Options Play</span>
              <button onClick={() => setOptModal(null)} className="text-muted hover:text-white text-lg leading-none">×</button>
            </div>
            {optModal.r.opt_quote_ts && (
              <p className="text-[11px] text-muted font-mono">
                Quote: {(() => {
                  try {
                    const d = new Date(optModal.r.opt_quote_ts!);
                    return d.toLocaleString("en-US", {
                      timeZone: "America/New_York",
                      month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                      hour12: true,
                    }) + " ET";
                  } catch { return optModal.r.opt_quote_ts; }
                })()}
              </p>
            )}
            <textarea
              readOnly
              autoFocus
              onFocus={e => e.target.select()}
              value={[optModal.r.opt_summary, optModal.r.opt_alt].filter(Boolean).join("\n\n")}
              rows={10}
              className="w-full bg-surface border border-border rounded-lg p-3 text-sm font-mono text-white resize-none focus:outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => copyText([optModal.r.opt_summary, optModal.r.opt_alt].filter(Boolean).join("\n\n"))}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent text-black hover:bg-accent/80 transition-colors"
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
              <button
                onClick={() => setOptModal(null)}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── BTD detail modal (double-click a BTD cell) ── */}
      {btdModal && (() => {
        const r = btdModal.r;
        const text = [
          `${r.ticker} — Buy-The-Dip (EMA structure)`,
          ``,
          `State:   ${r.btd_state}${r.btd_size ? `  (${r.btd_size} size)` : ""}`,
          r.btd_zone   ? `Zone:    ${r.btd_zone}` : null,
          r.btd_reason ? `Reason:  ${r.btd_reason}` : null,
          ``,
          `Price:   $${r.price?.toFixed(2) ?? "—"}`,
          `EMA 11:  ${r.ema11 ?? "—"}`,
          `EMA 20:  ${r.ema20 ?? "—"}`,
          `EMA 50:  ${r.ema50 ?? "—"}   (slope ${r.ema50_slope_pct != null ? `${r.ema50_slope_pct > 0 ? "+" : ""}${r.ema50_slope_pct}%` : "—"})`,
          `EMA 200: ${r.ema200 ?? "—"}`,
          ``,
          `Note: per-ticker structure only. Combine with the market`,
          `BTD / γ-gamma badge in the top bar for the regime gate.`,
        ].filter(v => v !== null).join("\n");
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setBtdModal(null)}
          >
            <div
              className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-lg mx-4 space-y-3"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">{r.ticker} — Buy-The-Dip</span>
                <button onClick={() => setBtdModal(null)} className="text-muted hover:text-white text-lg leading-none">×</button>
              </div>
              <textarea
                readOnly
                autoFocus
                onFocus={e => e.target.select()}
                value={text}
                rows={14}
                className="w-full bg-surface border border-border rounded-lg p-3 text-sm font-mono text-white resize-none focus:outline-none focus:border-accent"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => copyText(text)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent text-black hover:bg-accent/80 transition-colors"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <button
                  onClick={() => setBtdModal(null)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── News headlines modal (tap the 📰 badge — works on mobile) ── */}
      {newsModal && (() => {
        const r = newsModal.r;
        const hl = r.news_headlines ?? [];
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setNewsModal(null)}
          >
            <div
              className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-lg mx-4 space-y-3 max-h-[80vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">
                  {r.ticker} — News{" "}
                  <span className={r.news === "Good" ? "text-green" : r.news === "Bad" ? "text-red" : "text-muted"}>
                    {r.news} (+{r.news_good ?? 0}/-{r.news_bad ?? 0})
                  </span>
                </span>
                <button onClick={() => setNewsModal(null)} className="text-muted hover:text-white text-lg leading-none">×</button>
              </div>
              {hl.length === 0 ? (
                <p className="text-xs text-muted">No headlines captured.</p>
              ) : (
                <ul className="space-y-1.5">
                  {hl.map((hd, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs leading-snug">
                      <span className="mt-0.5">{hd.s === "Good" ? "🟢" : hd.s === "Bad" ? "🔴" : "⚪"}</span>
                      <span className="flex-1">
                        <span className="text-white">{hd.h}</span>
                        {(hd.src || hd.t) && (
                          <span className="ml-1 text-[10px] text-muted">
                            {hd.src ? `· ${hd.src}` : ""}{hd.t ? ` · ${hd.t}` : ""}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center justify-between pt-1">
                <a
                  href={`https://finviz.com/quote.ashx?t=${encodeURIComponent(r.ticker)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-mono text-accent hover:text-white underline-offset-2 hover:underline"
                >
                  Open Finviz ↗
                </a>
                <button
                  onClick={() => setNewsModal(null)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Fib detail modal (tap the Fib Target cell) */}
      {fibModal && (() => {
        const r = fibModal.r;
        const text = fibDetailText(r);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setFibModal(null)}
          >
            <div
              className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-lg mx-4 space-y-3"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">{r.ticker} - Fib Target</span>
                <button onClick={() => setFibModal(null)} className="text-muted hover:text-white text-lg leading-none">x</button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 font-mono text-sm text-white">
                {text}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => copyText(text)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent text-black hover:bg-accent/80 transition-colors"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={() => setFibModal(null)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Day Trading V4 detail modal (tap the V4 block) */}
      {dt4Modal && (() => {
        const r = dt4Modal.r;
        const text = dt4DetailText(r);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setDt4Modal(null)}
          >
            <div
              className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-lg mx-4 space-y-3"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">{r.ticker} - Day Trading V4</span>
                <button onClick={() => setDt4Modal(null)} className="text-muted hover:text-white text-lg leading-none">x</button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 font-mono text-sm text-white">
                {text}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => copyText(text)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent text-black hover:bg-accent/80 transition-colors"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={() => setDt4Modal(null)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Seasonality modal — 12-month bar chart (tap badge, mobile-safe) ── */}
      {seasonModal && (() => {
        const sg = seasonModal.data;
        const months = sg?.months ?? [];
        const curM = sg?.month ?? null;
        const maxAbs = Math.max(
          1,
          ...months.map(x => Math.abs(x.avg_pct ?? 0)),
        );
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setSeasonModal(null)}
          >
            <div
              className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-md mx-4 space-y-3 max-h-[85vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">
                  {seasonModal.ticker} — Seasonality{" "}
                  <span className="text-muted font-normal">
                    ({sg?.years ?? months.find(x => x.m === curM)?.years ?? 0}y monthly history)
                  </span>
                </span>
                <button onClick={() => setSeasonModal(null)} className="text-muted hover:text-white text-lg leading-none">×</button>
              </div>
              {seasonModal.loading && (
                <p className="py-6 text-center text-xs text-muted animate-pulse">Loading seasonality…</p>
              )}
              {!seasonModal.loading && seasonModal.error && (
                <p className="py-6 text-center text-xs text-red">Failed to load: {seasonModal.error}</p>
              )}
              {!seasonModal.loading && !seasonModal.error && !sg?.available && months.length === 0 && (
                <p className="py-6 text-center text-xs text-muted">
                  No seasonality data{sg?.reason ? ` — ${sg.reason}` : " (insufficient history)"}.
                </p>
              )}
              {!seasonModal.loading && months.length > 0 && (
              <>
              <p className="text-[10px] text-muted">
                Avg close-to-close return per calendar month · green = up, red = down ·
                current month highlighted. Historical tendency, not a forecast.
              </p>
              <div className="space-y-1">
                {months.map(x => {
                  const a = x.avg_pct;
                  const isCur = x.m === curM;
                  const w = a == null ? 0 : Math.min(50, (Math.abs(a) / maxAbs) * 50);
                  const pos = (a ?? 0) >= 0;
                  return (
                    <div
                      key={x.m}
                      className={`grid grid-cols-[30px_1fr_92px] items-center gap-2 rounded px-1 py-0.5 ${
                        isCur ? "bg-accent/10" : ""
                      }`}
                    >
                      <span className={`text-[10px] font-mono ${isCur ? "font-bold text-accent" : "text-muted"}`}>
                        {isCur ? "▶" : ""}{x.name}
                      </span>
                      <div className="relative h-3 rounded bg-surface">
                        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                        {a != null && (
                          <div
                            className={`absolute inset-y-0 ${pos ? "bg-green/70" : "bg-red/70"} rounded-sm`}
                            style={pos
                              ? { left: "50%", width: `${w}%` }
                              : { right: "50%", width: `${w}%` }}
                          />
                        )}
                      </div>
                      <span className="text-right text-[10px] font-mono">
                        <span className={a == null ? "text-muted" : pos ? "text-green" : "text-red"}>
                          {a == null ? "—" : `${pos ? "+" : ""}${a}%`}
                        </span>
                        <span className="text-muted">
                          {" "}{x.win_rate != null ? `${x.win_rate}%` : "—"}·{x.years}y
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {sg?.available && (
                <div className="border-t border-border/40 pt-2 text-[10px] text-muted">
                  <span className="font-semibold text-white">{sg.month_name}</span>: avg{" "}
                  {(sg.avg_pct ?? 0) >= 0 ? "+" : ""}{sg.avg_pct}% · median{" "}
                  {(sg.median_pct ?? 0) >= 0 ? "+" : ""}{sg.median_pct}% · win {sg.win_rate}% ·
                  best +{sg.best_pct}% · worst {sg.worst_pct}%
                </div>
              )}
              </>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => setSeasonModal(null)}
                  className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── OTM Liquid modal ── */}
      {otmModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOtmModal(null)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-2xl mx-4 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">{otmModal.r.ticker} — OTM Liquid Options</span>
              <button onClick={() => setOtmModal(null)} className="text-muted hover:text-white text-lg leading-none">×</button>
            </div>
            {otmModal.r.opt_liquid && otmModal.r.opt_liquid.length > 0 && (
              <p className="text-xs text-accent bg-accent/5 border border-accent/20 rounded px-2 py-1.5">
                {interpretOtmFlow(otmModal.r.opt_liquid)}
              </p>
            )}
            <div className="space-y-1">
              <div className="grid grid-cols-[auto_auto_auto_auto_auto_auto_auto] text-[10px] text-muted px-2 pb-1 border-b border-border gap-x-3">
                <span>Type</span>
                <span className="text-right">Strike</span>
                <span className="text-right">Exp</span>
                <span className="text-right">OTM%</span>
                <span className="text-right">Volume</span>
                <span className="text-right">OI</span>
                <span className="text-right">IV%</span>
              </div>
              {(otmModal.r.opt_liquid ?? []).map((c, i) => {
                const cc = c.type === "CALL" ? "text-green" : "text-red";
                return (
                  <div key={i} className={`grid grid-cols-[auto_auto_auto_auto_auto_auto_auto] text-[12px] font-mono px-2 py-1.5 rounded gap-x-3 ${c.unusual ? "bg-yellow/5" : "hover:bg-surface/50"}`}>
                    <span className={`font-bold ${cc} flex items-center gap-1`}>
                      {c.type}
                      {c.unusual && <span className="text-[9px] bg-yellow/20 text-yellow px-1 rounded">⚡</span>}
                    </span>
                    <span className={`text-right ${cc}`}>${c.strike}</span>
                    <span className="text-right text-muted">{c.expiry.slice(5)}</span>
                    <span className="text-right text-muted">{c.otm_pct}%</span>
                    <span className={`text-right ${c.vol_oi_ratio > 0.5 ? "text-yellow font-semibold" : "text-white"}`}>
                      {c.volume >= 1000 ? `${(c.volume/1000).toFixed(1)}K` : c.volume}
                    </span>
                    <span className="text-right text-muted">
                      {c.oi >= 1000 ? `${(c.oi/1000).toFixed(1)}K` : c.oi}
                    </span>
                    <span className={`text-right ${c.iv > 80 ? "text-red" : c.iv > 50 ? "text-yellow" : "text-muted"}`}>
                      {c.iv}%
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-muted/60">⚡ unusual flow &nbsp;·&nbsp; Vol highlighted when Vol/OI &gt; 0.5</p>
            <div className="flex justify-end">
              <button
                onClick={() => setOtmModal(null)}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border text-muted hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
