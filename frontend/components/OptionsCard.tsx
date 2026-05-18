import { interpretOtmFlow } from "@/lib/optionsFlow";

interface UnusualContract {
  volume: number; oi: number; strike: number;
  iv: number; itm: boolean; expiry: string; type: string;
  otm_pct?: number; notional?: number; flow_type?: string;
}

interface OtmLiquidContract {
  strike: number; type: string; expiry: string;
  volume: number; oi: number; iv: number;
  otm_pct: number; vol_oi_ratio: number; unusual: boolean;
}

interface OptionsBias {
  call_oi?: number; put_oi?: number;
  oi_pc_ratio?: number; vol_pc_ratio?: number;
  oi_sentiment?: string; delta_sentiment?: string;
  delta_bull_pct?: number; delta_bear_pct?: number;
  unusual_count?: number; unusual_activity?: UnusualContract[];
  otm_liquid?: OtmLiquidContract[];
  error?: string;
}

interface OptionsLeg {
  action: string; type: string; strike: number; exp: string; mid: number;
}

interface OptionsStrategy {
  strategy?: string; summary?: string; alt?: string;
  net_debit?: number; max_profit?: number; legs?: OptionsLeg[];
}

interface Props {
  bias:          OptionsBias;
  strategy:      OptionsStrategy | null;
  isExceptional: boolean;
}

const sentColor: Record<string, string> = {
  BULLISH: "text-green", BEARISH: "text-red", NEUTRAL: "text-yellow", "N/A": "text-muted",
};

export default function OptionsCard({ bias, strategy, isExceptional }: Props) {
  if (bias.error) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold text-muted mb-2">Options Flow</h3>
        <p className="text-xs text-muted">{bias.error}</p>
      </div>
    );
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted">Options Flow</h3>
        {isExceptional && (
          <span className="text-xs px-2 py-0.5 rounded bg-yellow/10 text-yellow border border-yellow/20 font-semibold">
            Exceptional Signal
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── Left column: flow analysis ── */}
        <div className="space-y-4">

          {/* Sentiment */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface rounded-lg p-3 text-center">
              <div className={`text-lg font-bold ${sentColor[bias.oi_sentiment ?? "N/A"]}`}>
                {bias.oi_sentiment ?? "N/A"}
              </div>
              <div className="text-xs text-muted">OI Sentiment</div>
              <div className="text-xs font-mono text-muted mt-1">P/C: {bias.oi_pc_ratio}</div>
            </div>
            <div className="bg-surface rounded-lg p-3 text-center">
              <div className={`text-lg font-bold ${sentColor[bias.delta_sentiment ?? "N/A"]}`}>
                {bias.delta_sentiment ?? "N/A"}
              </div>
              <div className="text-xs text-muted">Delta-Adjusted</div>
              <div className="text-xs font-mono text-muted mt-1">
                {bias.delta_bull_pct}% bull / {bias.delta_bear_pct}% bear
              </div>
            </div>
          </div>

          {/* Call/Put OI bar */}
          {bias.call_oi != null && (
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-green">Calls {(bias.call_oi / 1000).toFixed(0)}K OI</span>
                <span className="text-red">Puts {(bias.put_oi! / 1000).toFixed(0)}K OI</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden flex">
                {(() => {
                  const total = (bias.call_oi ?? 0) + (bias.put_oi ?? 0);
                  const callPct = total > 0 ? ((bias.call_oi ?? 0) / total) * 100 : 50;
                  return (
                    <>
                      <div className="bg-green/60 h-full" style={{ width: `${callPct}%` }} />
                      <div className="bg-red/60 h-full flex-1" />
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Unusual activity */}
          {bias.unusual_count != null && bias.unusual_count > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-yellow font-semibold">
                ⚡ {bias.unusual_count} unusual flow signal{bias.unusual_count > 1 ? "s" : ""}
              </p>
              {bias.unusual_activity && bias.unusual_activity.length > 0 && (
                <div className="space-y-1">
                  <div className="grid grid-cols-[auto_1fr_auto_auto_auto] text-[10px] text-muted px-1 pb-0.5 border-b border-border gap-x-2">
                    <span>Type</span><span>Tags</span>
                    <span className="text-right">Strike</span>
                    <span className="text-right">Vol</span>
                    <span className="text-right">Exp</span>
                  </div>
                  {bias.unusual_activity.map((c, i) => {
                    const isBlock    = c.flow_type?.includes("BLOCK");
                    const isFarOtm   = c.flow_type?.includes("FAR_OTM");
                    const isOpening  = c.flow_type?.includes("OPENING");
                    const isNotional = c.flow_type?.includes("LARGE_NOTIONAL");
                    const isSweep    = c.flow_type?.includes("SWEEP");
                    const callColor  = c.type === "CALL" ? "text-green" : "text-red";
                    return (
                      <div key={i} className={`grid grid-cols-[auto_1fr_auto_auto_auto] text-[11px] font-mono px-1 py-1 rounded gap-x-2 ${isFarOtm || isNotional ? "bg-yellow/5" : ""}`}>
                        <span className={`font-bold ${callColor}`}>{c.type}</span>
                        <span className="flex flex-wrap gap-0.5">
                          {isFarOtm   && <span className="text-[9px] bg-yellow/20 text-yellow px-1 rounded">FAR-OTM</span>}
                          {isOpening  && <span className="text-[9px] bg-accent/20 text-accent px-1 rounded">OPENING</span>}
                          {isSweep    && <span className="text-[9px] bg-orange-500/20 text-orange-400 px-1 rounded">SWEEP</span>}
                          {isBlock    && <span className="text-[9px] bg-purple-500/20 text-purple-400 px-1 rounded">BLOCK</span>}
                          {isNotional && <span className="text-[9px] bg-green/20 text-green px-1 rounded">
                            ${c.notional! >= 1_000_000 ? `${(c.notional!/1_000_000).toFixed(1)}M` : c.notional! >= 1_000 ? `${(c.notional!/1_000).toFixed(0)}K` : c.notional}
                          </span>}
                        </span>
                        <span className={`text-right ${callColor}`}>
                          ${c.strike}
                          {c.otm_pct != null && c.otm_pct > 5 && <span className="text-muted text-[10px] ml-0.5">({c.otm_pct}%)</span>}
                        </span>
                        <span className={`text-right ${callColor}`}>{c.volume >= 1000 ? `${(c.volume/1000).toFixed(1)}K` : c.volume}</span>
                        <span className="text-right text-muted">{c.expiry.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Options strategy */}
          {strategy?.summary && (
            <div className="border-t border-border pt-3 space-y-3">
              <span className="text-sm font-semibold text-white">{strategy.strategy}</span>
              <p className="text-xs text-accent font-mono leading-relaxed">{strategy.summary}</p>
              {strategy.legs && strategy.legs.length > 0 && (
                <div className="space-y-1">
                  {strategy.legs.map((leg, i) => (
                    <div key={i} className={`flex justify-between text-xs font-mono px-2 py-1 rounded ${leg.action === "BUY" ? "bg-green/5 text-green" : "bg-red/5 text-red"}`}>
                      <span>{leg.action} {leg.type} ${leg.strike}</span>
                      <span>exp {leg.exp} | ~${leg.mid}</span>
                    </div>
                  ))}
                </div>
              )}
              {strategy.net_debit != null && (
                <div className="flex gap-4 text-xs text-muted">
                  <span>Net debit: <span className="text-white font-mono">${strategy.net_debit}</span></span>
                  <span>Max profit: <span className="text-green font-mono">${strategy.max_profit}</span></span>
                </div>
              )}
              {strategy.alt && <p className="text-xs text-muted italic">{strategy.alt}</p>}
            </div>
          )}

          {isExceptional && !strategy && (
            <p className="text-xs text-muted italic">Options strategy unavailable (Alpaca options not enabled for this ticker)</p>
          )}
        </div>

        {/* ── Right column: OTM liquid options ── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted">OTM — Liquid &amp; Notable</p>
          {bias.otm_liquid && bias.otm_liquid.length > 0 && (
            <p className="text-[11px] text-accent bg-accent/5 border border-accent/20 rounded px-2 py-1">
              {interpretOtmFlow(bias.otm_liquid)}
            </p>
          )}
          <div className="space-y-1">
            <div className="grid grid-cols-[auto_auto_auto_auto_auto_auto] text-[10px] text-muted px-1 pb-0.5 border-b border-border gap-x-2">
              <span>Type</span>
              <span className="text-right">Strike</span>
              <span className="text-right">OTM%</span>
              <span className="text-right">Vol</span>
              <span className="text-right">OI</span>
              <span className="text-right">IV%</span>
            </div>
            {(bias.otm_liquid ?? []).map((c, i) => {
              const callColor = c.type === "CALL" ? "text-green" : "text-red";
              return (
                <div key={i} className={`grid grid-cols-[auto_auto_auto_auto_auto_auto] text-[11px] font-mono px-1 py-1 rounded gap-x-2 ${c.unusual ? "bg-yellow/5" : ""}`}>
                  <span className={`font-bold ${callColor} flex items-center gap-1`}>
                    {c.type}
                    {c.unusual && <span className="text-[8px] bg-yellow/20 text-yellow px-0.5 rounded">⚡</span>}
                  </span>
                  <span className={`text-right ${callColor}`}>${c.strike}</span>
                  <span className="text-right text-muted">{c.otm_pct}%</span>
                  <span className={`text-right ${c.vol_oi_ratio > 0.5 ? "text-yellow" : "text-white"}`}>
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
            {(!bias.otm_liquid || bias.otm_liquid.length === 0) && (
              <p className="text-xs text-muted py-2">No liquid OTM contracts found</p>
            )}
          </div>
          <p className="text-[10px] text-muted/60">Vol highlighted yellow when Vol/OI &gt; 0.5 · ⚡ = unusual flow</p>
        </div>

      </div>
    </div>
  );
}
