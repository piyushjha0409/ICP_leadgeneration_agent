"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Isobars } from "@/app/components/Isobars";
import { SIGNAL_NAMES, STAGES } from "@/app/components/stages";

export const RUN_INPUT_KEY = "rainmaker:runInput";

type LatestRunSummary = {
  empty: boolean;
  startedAt?: number;
  leads?: unknown[];
  disqualified?: unknown[];
};

type Mode = "url" | "description";

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** People type "acme.com"; the pipeline wants a URL. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("url");
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

    const trimmedUrl = mode === "url" ? normalizeUrl(agencyUrl) : "";
    const trimmedDescription = mode === "description" ? description.trim() : "";

    if (!trimmedUrl && !trimmedDescription) {
      setError(
        mode === "url"
          ? "Add your agency's website to start."
          : "Describe the agency in a sentence or two to start.",
      );
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

  const leadCount = summary?.leads?.length ?? 0;

  return (
    <>
      <section className="hero">
        <div className="hero-field" aria-hidden="true">
          <Isobars />
        </div>

        <div className="wrap hero-grid">
          <div className="hero-copy">
            <h1 className="claim rise">
              Finds the companies that will need an agency{" "}
              <em>this quarter.</em>
            </h1>
            <p className="hero-sub rise rise-2">
              Give it your agency website. It works out who you sell to, hunts
              the open web for companies that match, and ranks them by how
              badly they need you, and how soon.
            </p>
            <div className="listens rise rise-3">
              <span className="label">Listens for</span>
              <ul>
                {Object.values(SIGNAL_NAMES).map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          </div>

          <form className="station rise rise-2" onSubmit={handleSubmit} noValidate>
            <div className="station-head">
              <span className="label">Start a hunt</span>
              <button
                type="button"
                className="switch"
                onClick={() => {
                  setError(null);
                  setMode(mode === "url" ? "description" : "url");
                }}
              >
                {mode === "url" ? "Describe it instead" : "Use the website instead"}
              </button>
            </div>

            {mode === "url" ? (
              <div className="field">
                <label htmlFor="agencyUrl">Agency website</label>
                <input
                  id="agencyUrl"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  placeholder="youragency.com"
                  value={agencyUrl}
                  onChange={(evt) => setAgencyUrl(evt.target.value)}
                />
                <p className="field-hint">
                  Rainmaker reads the site to work out who you sell to.
                </p>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="description">What the agency does, and for whom</label>
                <textarea
                  id="description"
                  rows={5}
                  placeholder="Performance marketing for seed-to-Series-A B2B SaaS in the US. Paid acquisition and lifecycle email."
                  value={description}
                  onChange={(evt) => setDescription(evt.target.value)}
                />
                <p className="field-hint">Two sentences is plenty.</p>
              </div>
            )}

            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="btn btn-primary btn-block">
              Run the hunt
            </button>
            <p className="fineprint">
              About three minutes. 24 web searches, 23 model calls, $0 on the
              free tiers. Nothing is sent to anyone.
            </p>
          </form>
        </div>
      </section>

      <section className="wrap below-hero">
        {summary && !summary.empty ? (
          <div className="lastrun rise rise-3">
            <p>
              <span className="label">Last hunt</span>
              <b>
                {leadCount} lead{leadCount === 1 ? "" : "s"}
              </b>{" "}
              worth a call &middot; {summary.disqualified?.length ?? 0} disqualified
              {summary.startedAt ? <> &middot; {formatWhen(summary.startedAt)}</> : null}
            </p>
            <a href="/leads" className="btn btn-ghost">
              Open the shortlist &rarr;
            </a>
          </div>
        ) : null}

        <ol className="stages-strip rise rise-4" aria-label="What a hunt does">
          {STAGES.map((item, index) => (
            <li key={item.stage}>
              <span className="stage-n">{index + 1}</span>
              <span className="stage-name">{item.name}</span>
              <span className="stage-blurb">{item.blurb}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
