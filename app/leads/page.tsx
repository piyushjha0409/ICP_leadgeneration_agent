"use client";

import { useEffect, useMemo, useState } from "react";
import { suggestTargetRole } from "@/src/lib/enrich";
import type { Icp, Lead } from "@/src/pipeline/types";
import { Gauge } from "@/app/components/Gauge";
import { SIGNAL_NAMES } from "@/app/components/stages";

type FeedbackDirection = "up" | "down";

type LeadsResponse =
  | { empty: true; feedback: Record<string, FeedbackDirection> }
  | {
      empty: false;
      startedAt: number;
      icp: Icp;
      leads: Lead[];
      disqualified: Lead[];
      stats: { estCostUsd: number; durationMs: number };
      feedback: Record<string, FeedbackDirection>;
    };

/** The qualify stage's rubric, in the same order and with the same maxima. */
const RUBRIC = [
  { key: "fit", label: "Fit", max: 40 },
  { key: "pain", label: "Pain", max: 30 },
  { key: "timing", label: "Timing", max: 30 },
] as const;

/**
 * Score reasons arrive as "Fit: …", "Pain: …", "Timing: …". Lay them out as
 * a reading against the rubric; anything that doesn't carry a prefix goes in
 * an "Also" row rather than being dropped.
 */
function splitReasons(reasons: string[]) {
  const byKey = new Map<string, string>();
  const other: string[] = [];
  for (const reason of reasons) {
    const match = reason.match(/^\s*(fit|pain|timing)\s*[:—–-]\s*(.+)$/is);
    const key = match?.[1]?.toLowerCase();
    if (match && key && !byKey.has(key)) byKey.set(key, match[2].trim());
    else other.push(reason);
  }
  return { byKey, other };
}

function signalName(type: string): string {
  return SIGNAL_NAMES[type] ?? type.replace(/_/g, " ");
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** The drafted email, folded until asked for, copyable in one click. */
function FirstEmail({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      // Clipboard is unavailable on insecure origins — the text is on screen
      // and selectable either way, so there is nothing useful to say here.
    }
  }

  const words = message.trim().split(/\s+/).filter(Boolean).length;

  return (
    <details className="telegram">
      <summary>
        <span>Read the email</span>
        <span className="telegram-hint">{words} words</span>
      </summary>
      <div className="telegram-body">
        <pre className="telegram-text">{message}</pre>
        <button
          type="button"
          className={`btn btn-ghost btn-sm${copied ? " copied" : ""}`}
          onClick={handleCopy}
        >
          {copied ? "Copied" : "Copy message"}
        </button>
      </div>
    </details>
  );
}

function Sheet({
  lead,
  rank,
  suggestedRole,
  feedback,
  onFeedback,
}: {
  lead: Lead;
  rank: number;
  /** Who to aim at when enrichment could not name a person. */
  suggestedRole: string;
  feedback: FeedbackDirection | undefined;
  onFeedback: (domain: string, direction: FeedbackDirection) => void;
}) {
  const { company, signals, scoreReasons } = lead;
  const { byKey, other } = splitReasons(scoreReasons);
  const score = Math.round(lead.score);

  return (
    <article
      className="sheet lead-sheet"
      style={{ animationDelay: `${Math.min(rank - 1, 6) * 70}ms` }}
    >
      <header className="sheet-head">
        <div className="sheet-id">
          <span className="sheet-rank">#{rank}</span>
          <h2 className="sheet-co">{company.name}</h2>
          <a
            className="sheet-domain"
            href={`https://${company.domain}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {company.domain}
          </a>
        </div>
        <div className="gauge" role="img" aria-label={`Score ${score} out of 100`}>
          <div className="gauge-num">
            {score}
            <small>/100</small>
          </div>
          <Gauge score={lead.score} />
        </div>
      </header>

      <div className="sheet-body">
        {signals.length > 0 ? (
          <div className="row">
            <div className="k">Signals</div>
            <div className="v tags">
              {signals.map((signal, index) => (
                <a
                  key={`${signal.type}-${index}`}
                  className="tag"
                  href={signal.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={signal.evidence}
                >
                  {signalName(signal.type)}
                  {signal.date ? <span className="date">{signal.date}</span> : null}
                </a>
              ))}
            </div>
          </div>
        ) : null}

        {RUBRIC.map((item) =>
          byKey.has(item.key) ? (
            <div className="row" key={item.key}>
              <div className="k">
                {item.label}
                <span className="max">/{item.max}</span>
              </div>
              <div className="v">{byKey.get(item.key)}</div>
            </div>
          ) : null,
        )}

        {other.length > 0 ? (
          <div className="row">
            <div className="k">Also</div>
            <ul className="v plain">
              {other.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {lead.contact ? (
          <div className="row">
            <div className="k">Reach</div>
            <div className="v">
              <b>{lead.contact.name}</b>, {lead.contact.role}
              {lead.contact.email ? (
                <>
                  {" · "}
                  <a className="email" href={`mailto:${lead.contact.email}`}>
                    {lead.contact.email}
                  </a>
                </>
              ) : null}
            </div>
          </div>
        ) : lead.pitchAngle ? (
          <div className="row">
            <div className="k">Reach</div>
            <div className="v soft">
              No named contact yet. Aim for the <b>{suggestedRole}</b>.
            </div>
          </div>
        ) : null}

        {lead.pitchAngle ? (
          <div className="row">
            <div className="k">Angle</div>
            <div className="v">{lead.pitchAngle}</div>
          </div>
        ) : null}

        {lead.draftMessage ? (
          <div className="row">
            <div className="k">First email</div>
            <div className="v">
              <FirstEmail message={lead.draftMessage} />
            </div>
          </div>
        ) : null}
      </div>

      <footer className="sheet-foot">
        <span className="foot-via" title={company.why}>
          {company.discoveredVia ? (
            <>
              Found via <b>{company.discoveredVia}</b>
            </>
          ) : company.why ? (
            <>Shortlisted: {company.why}</>
          ) : null}
        </span>
        <div className="verdict" role="group" aria-label="Was this a good lead?">
          <button
            type="button"
            className={`verdict-btn good${feedback === "up" ? " active" : ""}`}
            aria-pressed={feedback === "up"}
            onClick={() => onFeedback(company.domain, "up")}
          >
            Good lead
          </button>
          <button
            type="button"
            className={`verdict-btn bad${feedback === "down" ? " active" : ""}`}
            aria-pressed={feedback === "down"}
            onClick={() => onFeedback(company.domain, "down")}
          >
            Not a fit
          </button>
        </div>
      </footer>
    </article>
  );
}

export default function LeadsPage() {
  const [data, setData] = useState<LeadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackDirection>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leads")
      .then((res) => res.json())
      .then((json: LeadsResponse) => {
        if (cancelled) return;
        setData(json);
        setFeedback(json.feedback ?? {});
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedLeads = useMemo(() => {
    if (!data || data.empty) return [];
    return [...data.leads].sort((a, b) => b.score - a.score);
  }, [data]);

  // Fallback "who to reach" for briefed leads Hunter could not put a name to.
  const suggestedRole = useMemo(
    () => (data && !data.empty && data.icp ? suggestTargetRole(data.icp) : "Head of Marketing"),
    [data],
  );

  async function handleFeedback(domain: string, direction: FeedbackDirection) {
    const previous = feedback[domain];
    const optimisticNext = previous === direction ? undefined : direction;

    setFeedback((prev) => {
      const next = { ...prev };
      if (optimisticNext) next[domain] = optimisticNext;
      else delete next[domain];
      return next;
    });

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, direction }),
      });
      const json: { direction: FeedbackDirection | null } = await res.json();
      setFeedback((prev) => {
        const next = { ...prev };
        if (json.direction) next[domain] = json.direction;
        else delete next[domain];
        return next;
      });
    } catch {
      // Revert on failure.
      setFeedback((prev) => {
        const next = { ...prev };
        if (previous) next[domain] = previous;
        else delete next[domain];
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="wrap section">
        <p className="loading">Loading the shortlist</p>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="wrap section">
        <div className="sheet error-sheet narrow">
          <span className="label">Could not load the shortlist</span>
          <p>{errorMessage}</p>
        </div>
      </div>
    );
  }

  if (!data || data.empty) {
    return (
      <div className="wrap section">
        <div className="empty rise">
          <h1 className="board-title">No shortlist yet</h1>
          <p>Run a hunt and the ranked leads land here.</p>
          <a href="/" className="btn btn-primary">
            Start a hunt
          </a>
        </div>
      </div>
    );
  }

  const count = sortedLeads.length;

  return (
    <div className="wrap section">
      <div className="board-head rise">
        <div>
          <h1 className="board-title">
            {count === 0
              ? "Nothing qualified this time"
              : `${count} lead${count === 1 ? "" : "s"} worth a call`}
          </h1>
          {data.icp ? (
            <p className="board-icp">
              Looking for <b>{data.icp.industry}</b> &middot; <b>{data.icp.companySize}</b>{" "}
              &middot; <b>{data.icp.geography}</b>
            </p>
          ) : null}
          <p className="board-meta">
            Hunt finished {formatWhen(data.startedAt)} &middot;{" "}
            {formatDuration(data.stats.durationMs)} &middot; est. $
            {data.stats.estCostUsd.toFixed(2)}
          </p>
        </div>
        <a href="/" className="btn btn-ghost">
          New hunt
        </a>
      </div>

      {count === 0 ? (
        <div className="empty">
          <p>
            No company cleared the bar. A broader description, or a different
            site, usually does.
          </p>
        </div>
      ) : (
        <div className="sheets">
          {sortedLeads.map((lead, index) => (
            <Sheet
              key={lead.company.domain}
              lead={lead}
              rank={index + 1}
              suggestedRole={suggestedRole}
              feedback={feedback[lead.company.domain]}
              onFeedback={handleFeedback}
            />
          ))}
        </div>
      )}

      {data.disqualified.length > 0 ? (
        <details className="dq">
          <summary>
            <span>Disqualified ({data.disqualified.length})</span>
            <span className="dq-hint">failed a hard ICP rule</span>
          </summary>
          <div className="dq-list">
            {data.disqualified.map((lead) => (
              <div className="dq-row" key={lead.company.domain}>
                <span className="name">{lead.company.name}</span>
                <span className="reason">
                  {lead.disqualifiedReason ?? "Structural mismatch with the ICP."}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
