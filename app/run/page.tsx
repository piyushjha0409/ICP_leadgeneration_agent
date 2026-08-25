"use client";

import { useEffect, useRef, useState } from "react";
import type { SseFrame } from "@/app/api/run/stream/route";
import type { PipelineEvent, PipelineStage } from "@/src/pipeline/types";
import type { RunResult } from "@/src/pipeline/run";

const RUN_INPUT_KEY = "rainmaker:runInput";

const RAIL_STAGES: { stage: PipelineStage; label: string }[] = [
  { stage: "icp", label: "ICP" },
  { stage: "hunt", label: "Hunt" },
  { stage: "scan", label: "Scan" },
  { stage: "qualify", label: "Qualify" },
  { stage: "enrich", label: "Enrich" },
  { stage: "brief", label: "Brief" },
];
const RAIL_INDEX: Record<string, number> = {
  icp: 0,
  hunt: 1,
  scan: 2,
  qualify: 3,
  enrich: 4,
  brief: 5,
};

type RunResultData = Pick<RunResult, "icp" | "leads" | "disqualified"> & {
  stats: RunResult["stats"];
};

type FeedItem = PipelineEvent & { id: number };

function isSignalEvent(event: PipelineEvent): boolean {
  if (event.stage !== "scan") return false;
  const data = event.data as { signals?: unknown[] } | undefined;
  return Array.isArray(data?.signals) && data.signals.length > 0;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function RunPage() {
  const [noInput, setNoInput] = useState(false);
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [stageIndex, setStageIndex] = useState(-1);
  const [candidatesFound, setCandidatesFound] = useState(0);
  const [signalsFound, setSignalsFound] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<RunResultData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(true);

  const startedRef = useRef(false);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const eventIdRef = useRef(0);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(interval);
  }, [running]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const raw = sessionStorage.getItem(RUN_INPUT_KEY);
    if (!raw) {
      setNoInput(true);
      setRunning(false);
      return;
    }

    let input: { agencyUrl?: string; description?: string };
    try {
      input = JSON.parse(raw);
    } catch {
      setNoInput(true);
      setRunning(false);
      return;
    }

    void streamRun(input);

    async function streamRun(body: unknown) {
      try {
        const response = await fetch("/api/run/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.body) {
          throw new Error("The server did not return a stream.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const dataLine = rawFrame
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) continue;

            const jsonText = dataLine.slice("data:".length).trim();
            if (!jsonText) continue;

            let frame: SseFrame;
            try {
              frame = JSON.parse(jsonText);
            } catch {
              continue;
            }

            handleFrame(frame);
          }
        }

        setRunning(false);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setRunning(false);
      }
    };

    function handleFrame(frame: SseFrame) {
      if (frame.type === "event") {
        const event = frame.event;

        // Take the id now, not inside the updater: React batches updaters and
        // runs them at render time, so several frames from one chunk would
        // otherwise all read the ref's final value and collide on one key.
        const id = ++eventIdRef.current;
        setEvents((prev) => [...prev, { ...event, id }]);

        if (event.stage in RAIL_INDEX) {
          setStageIndex((prev) => Math.max(prev, RAIL_INDEX[event.stage]));
        }

        if (event.stage === "hunt") {
          const data = event.data as
            | { candidates?: unknown[]; companies?: unknown[] }
            | undefined;
          if (Array.isArray(data?.candidates)) {
            setCandidatesFound(data.candidates.length);
          } else if (Array.isArray(data?.companies)) {
            setCandidatesFound((prev) => prev + (data!.companies as unknown[]).length);
          }
        }

        if (event.stage === "scan") {
          const data = event.data as { signals?: unknown[] } | undefined;
          if (Array.isArray(data?.signals)) {
            setSignalsFound((prev) => prev + data!.signals!.length);
          }
        }
      } else if (frame.type === "result") {
        setStageIndex(RAIL_STAGES.length);
        setResult({
          icp: frame.icp,
          leads: frame.leads,
          disqualified: frame.disqualified,
          stats: frame.stats,
        });
      } else if (frame.type === "error") {
        setErrorMessage(frame.message);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (noInput) {
    return (
      <div className="wrap" style={{ paddingTop: 60, paddingBottom: 60 }}>
        <div className="error-card" style={{ maxWidth: 560, margin: "0 auto" }}>
          <span className="eyebrow">No run to show</span>
          <p>
            Rainmaker doesn&rsquo;t have an agency URL or description queued up.
            Start one from the setup screen.
          </p>
          <div style={{ marginTop: 18 }}>
            <a href="/" className="btn btn-primary">
              Back to setup
            </a>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="wrap" style={{ paddingTop: 40, paddingBottom: 70 }}>
      <div style={{ marginBottom: 26 }}>
        <span className="eyebrow">Live run</span>
        <h1 style={{ fontSize: 28, marginTop: 8, display: "flex", alignItems: "center", gap: 14 }}>
          {running ? (
            <span className="live">
              <span className="pulse" />
              Scanning
            </span>
          ) : errorMessage ? (
            <span className="live" style={{ color: "var(--danger)" }}>
              Stopped
            </span>
          ) : (
            <span className="live" style={{ color: "var(--hot)" }}>
              Run complete
            </span>
          )}
        </h1>
      </div>

      <div className="stage-rail">
        {RAIL_STAGES.map((item, index) => {
          const state =
            stageIndex > index || stageIndex >= RAIL_STAGES.length
              ? "done"
              : stageIndex === index
                ? "active"
                : "";
          return (
            <div key={item.stage} className={`stage ${state}`.trim()}>
              <span className="stage-dot" />
              <span className="stage-label">{item.label}</span>
            </div>
          );
        })}
      </div>

      <div className="counters">
        <div className="counter">
          <div className="num">{candidatesFound}</div>
          <div className="lab">Candidates found</div>
        </div>
        <div className="counter">
          <div className="num">{signalsFound}</div>
          <div className="lab">Signals found</div>
        </div>
        <div className="counter">
          <div className="num">{formatElapsed(elapsedMs)}</div>
          <div className="lab">Elapsed</div>
        </div>
      </div>

      <div className="console">
        <div className="console-bar">
          <span className="mono">Activity</span>
          <span className={`mono${running ? " on" : ""}`}>
            {running ? "● LISTENING" : "● IDLE"}
          </span>
        </div>
        <div className="feed" ref={feedRef}>
          {events.length === 0 ? (
            <div className="feed-empty">Waiting for the first event&hellip;</div>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                className={`feed-line${isSignalEvent(event) ? " signal" : ""}`}
              >
                <span className="t">
                  {typeof event.at === "number"
                    ? `${(event.at / 1000).toFixed(1)}s`
                    : ""}
                </span>
                <span className="chip-stage">{event.stage}</span>
                <span className="msg">{event.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {errorMessage ? (
        <div className="error-card" style={{ marginTop: 24 }}>
          <span className="eyebrow">Run failed</span>
          <p>{errorMessage}</p>
          <div style={{ marginTop: 18, display: "flex", gap: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
            <a href="/" className="btn btn-ghost">
              Back to setup
            </a>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="card result-card" style={{ marginTop: 24 }}>
          <span className="eyebrow">Done</span>
          <div className="big-num">{result.leads.length}</div>
          <div className="cap">
            qualified lead{result.leads.length === 1 ? "" : "s"} &middot;{" "}
            {result.disqualified.length} disqualified &middot; {formatElapsed(result.stats.durationMs)}
          </div>
          <div className="cost">
            est. cost ${result.stats.estCostUsd.toFixed(4)}
            {result.stats.reportedCostUsd
              ? ` · reported $${result.stats.reportedCostUsd.toFixed(4)}`
              : ""}
          </div>
          <div className="result-actions">
            <a href="/leads" className="btn btn-primary">
              View ranked leads &rarr;
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
};
