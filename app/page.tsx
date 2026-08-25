"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export const RUN_INPUT_KEY = "rainmaker:runInput";

type LatestRunSummary = {
  empty: boolean;
  startedAt?: number;
  leads?: unknown[];
  disqualified?: unknown[];
};

type Tab = "url" | "description";

export default function HomePage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("url");
  const [agencyUrl, setAgencyUrl] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<LatestRunSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leads")
      .then((res) => res.json())
      .then((data: LatestRunSummary) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSubmit(evt: React.FormEvent) {
    evt.preventDefault();

    const trimmedUrl = agencyUrl.trim();
    const trimmedDescription = description.trim();

    if (!trimmedUrl && !trimmedDescription) {
      setError("Give Rainmaker an agency URL or a short description to hunt from.");
      return;
    }

    setError(null);
    sessionStorage.setItem(
      RUN_INPUT_KEY,
      JSON.stringify({
        agencyUrl: trimmedUrl || undefined,
        description: trimmedDescription || undefined,
      }),
    );
    router.push("/run");
  }

  return (
    <>
      <header className="hero">
        <div className="wrap">
          <div className="hero-grid">
            <div>
              <div className="live" style={{ marginBottom: 18 }}>
                <span className="pulse" />
                Autonomous &middot; Always scanning
              </div>
              <h1 className="title">
                Rain<span className="drop">maker</span>
              </h1>
              <p className="subtitle">The ICP lead-generation agent</p>
              <p className="lede">
                Define your <b>Ideal Customer Profile</b> once. Rainmaker hunts the
                open web for companies that match, spots the signals that mean
                they need you now, and hands you a ranked, ready-to-contact
                shortlist.
              </p>
            </div>
            <div className="radar-wrap" aria-hidden="true">
              <div className="radar">
                <div className="sweep" />
                <span className="blip b1" />
                <span className="blip b2" />
                <span className="blip b3" />
                <span className="core" />
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="wrap" style={{ paddingTop: 44, paddingBottom: 70 }}>
        <div className="card" style={{ maxWidth: 640, margin: "0 auto" }}>
          <span className="eyebrow">Start a run</span>
          <h2 style={{ fontSize: 22, marginTop: 10, marginBottom: 18 }}>
            Tell Rainmaker who you are
          </h2>

          <div className="tabs">
            <button
              type="button"
              className={`tab${tab === "url" ? " active" : ""}`}
              onClick={() => setTab("url")}
            >
              Agency URL
            </button>
            <button
              type="button"
              className={`tab${tab === "description" ? " active" : ""}`}
              onClick={() => setTab("description")}
            >
              Describe it
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {tab === "url" ? (
              <div className="field">
                <label htmlFor="agencyUrl">Agency website</label>
                <input
                  id="agencyUrl"
                  type="url"
                  placeholder="https://youragency.com"
                  value={agencyUrl}
                  onChange={(evt) => setAgencyUrl(evt.target.value)}
                />
                <p className="field-hint">
                  Rainmaker reads the site to infer who you sell to.
                </p>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="description">What does the agency do?</label>
                <textarea
                  id="description"
                  placeholder="A performance-marketing agency for seed-to-Series-A B2B SaaS companies in the US, focused on paid acquisition and lifecycle email..."
                  value={description}
                  onChange={(evt) => setDescription(evt.target.value)}
                />
                <p className="field-hint">
                  A couple of sentences on who you are and who you serve is enough.
                </p>
              </div>
            )}

            {error ? <p className="error-text">{error}</p> : null}

            <button type="submit" className="btn btn-primary btn-block">
              Start hunting
            </button>
          </form>
        </div>

        {summary && !summary.empty ? (
          <div className="summary-strip" style={{ maxWidth: 640, margin: "22px auto 0" }}>
            <div>
              <div className="label">Latest run</div>
              <div className="value">
                <b>{summary.leads?.length ?? 0}</b> qualified leads &middot;{" "}
                <b>{summary.disqualified?.length ?? 0}</b> disqualified
                {summary.startedAt ? (
                  <> &middot; {new Date(summary.startedAt).toLocaleString()}</>
                ) : null}
              </div>
            </div>
            <a href="/leads" className="btn btn-ghost">
              View leads &rarr;
            </a>
          </div>
        ) : null}
      </div>
    </>
  );
}
