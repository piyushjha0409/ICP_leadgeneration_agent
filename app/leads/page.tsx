"use client";

import { useEffect, useMemo, useState } from "react";
import { suggestTargetRole } from "@/src/lib/enrich";
import type { Icp, Lead } from "@/src/pipeline/types";

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

function formatSignalType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function ScoreRing({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="score">
      <div
        className="ring"
        style={{
          background: `conic-gradient(var(--hot) 0 ${pct}%, var(--border) ${pct}% 100%)`,
        }}
      >
        <span>{Math.round(score)}</span>
      </div>
      <div className="cap">ICP-fit</div>
    </div>
  );
}

/** The drafted message, hidden until asked for, copyable in one click. */
function DraftFirstTouch({ message }: { message: string }) {
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

  return (
    <details className="draft-box">
      <summary>Draft first touch</summary>
      <div className="draft-body">
        <pre className="draft">{message}</pre>
        <button
          type="button"
          className={`copy-btn${copied ? " copied" : ""}`}
          onClick={handleCopy}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </details>
  );
}

function LeadCard({
  lead,
  suggestedRole,
  feedback,
  onFeedback,
}: {
  lead: Lead;
  /** Who to aim at when enrichment could not name a person. */
  suggestedRole: string;
  feedback: FeedbackDirection | undefined;
  onFeedback: (domain: string, direction: FeedbackDirection) => void;
}) {
  const { company, signals, scoreReasons } = lead;

  return (
    <div className="dossier">
      <div className="dos-head">
        <div>
          <div className="co">{company.name}</div>
          <div className="domain">
            <a
              href={`https://${company.domain}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {company.domain}
            </a>
          </div>
        </div>
        <ScoreRing score={lead.score} />
      </div>

      <div className="dos-body">
        {signals.length > 0 ? (
          <div className="dos-row">
            <div className="k">Signals detected</div>
            <div className="chips">
              {signals.map((signal, index) => (
                <a
                  key={`${signal.type}-${index}`}
                  className="chip"
                  href={signal.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={signal.evidence}
                >
                  {formatSignalType(signal.type)}
                  {signal.date ? <span className="date">{signal.date}</span> : null}
                </a>
              ))}
            </div>
          </div>
        ) : null}

        {scoreReasons.length > 0 ? (
          <div className="dos-row">
            <div className="k">Why it scored this way</div>
            <ul className="reasons">
              {scoreReasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {lead.contact ? (
          <div className="dos-row">
            <div className="k">Right person to reach</div>
            <div className="v contact-line">
              <b>{lead.contact.name}</b> &mdash; {lead.contact.role}
              {lead.contact.email ? (
                <>
                  {" · "}
                  <a className="contact-email" href={`mailto:${lead.contact.email}`}>
                    {lead.contact.email}
                  </a>
                </>
              ) : null}
            </div>
          </div>
        ) : lead.pitchAngle ? (
          <div className="dos-row">
            <div className="k">Right person to reach</div>
            <div className="v suggested-target">
              Suggested target: <b>{suggestedRole}</b>
            </div>
          </div>
        ) : null}

        {lead.pitchAngle ? (
          <div className="dos-row">
            <div className="k">Pitch angle</div>
            <div className="v">{lead.pitchAngle}</div>
          </div>
        ) : null}

        {lead.draftMessage ? (
          <div className="dos-row">
            <DraftFirstTouch message={lead.draftMessage} />
          </div>
        ) : null}
      </div>

      <div className="dos-foot">
        <div className="why-line">
          {company.why ? <>Shortlisted because: {company.why}</> : null}
        </div>
        <div className="fb-row">
          <button
            type="button"
            className={`fb-btn up${feedback === "up" ? " active" : ""}`}
            aria-label="Good lead"
            onClick={() => onFeedback(company.domain, "up")}
          >
            &#128077;
          </button>
          <button
            type="button"
            className={`fb-btn down${feedback === "down" ? " active" : ""}`}
            aria-label="Bad lead"
            onClick={() => onFeedback(company.domain, "down")}
          >
            &#128078;
          </button>
        </div>
      </div>
    </div>
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
      <div className="wrap" style={{ paddingTop: 60, paddingBottom: 60 }}>
        <p className="mono" style={{ color: "var(--faint)" }}>
          Loading leads&hellip;
        </p>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="wrap" style={{ paddingTop: 60, paddingBottom: 60 }}>
        <div className="error-card" style={{ maxWidth: 560, margin: "0 auto" }}>
          <span className="eyebrow">Could not load leads</span>
          <p>{errorMessage}</p>
        </div>
      </div>
    );
  }

  if (!data || data.empty) {
    return (
      <div className="wrap">
        <div className="empty-state">
          <span className="eyebrow">No leads yet</span>
          <p style={{ marginTop: 12 }}>
            Rainmaker hasn&rsquo;t completed a run yet. Start one from the setup
            screen to build your first shortlist.
          </p>
          <a href="/" className="btn btn-primary">
            Go to setup
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ paddingTop: 40, paddingBottom: 70 }}>
      <div className="leads-head">
        <div>
          <span className="eyebrow">Ranked shortlist</span>
          <h1>{sortedLeads.length} qualified leads</h1>
          <div className="meta">
            Run finished {new Date(data.startedAt).toLocaleString()} &middot; est.
            cost ${data.stats.estCostUsd.toFixed(4)}
          </div>
        </div>
        <a href="/" className="btn btn-ghost">
          New run
        </a>
      </div>

      {sortedLeads.length === 0 ? (
        <div className="empty-state">
          <p>No companies qualified in the latest run.</p>
        </div>
      ) : (
        <div className="lead-grid">
          {sortedLeads.map((lead) => (
            <LeadCard
              key={lead.company.domain}
              lead={lead}
              suggestedRole={suggestedRole}
              feedback={feedback[lead.company.domain]}
              onFeedback={handleFeedback}
            />
          ))}
        </div>
      )}

      {data.disqualified.length > 0 ? (
        <details className="disclosure">
          <summary>Disqualified ({data.disqualified.length})</summary>
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
