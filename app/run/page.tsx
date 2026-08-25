"use client";

import { useEffect, useRef, useState } from "react";
import type { SseFrame } from "@/app/api/run/stream/route";
import type { PipelineEvent } from "@/src/pipeline/types";
import type { RunResult } from "@/src/pipeline/run";
import { STAGES, STAGE_INDEX, stageName } from "@/app/components/stages";

const RUN_INPUT_KEY = "rainmaker:runInput";

type RunResultData = Pick<RunResult, "icp" | "leads" | "disqualified"> & {
  stats: RunResult["stats"];
};

type FeedItem = PipelineEvent & { id: number };

function isSignalEvent(event: PipelineEvent): boolean {
  if (event.stage !== "scan") return false;
  const data = event.data as { signals?: unknown[] } | undefined;
  return Array.isArray(data?.signals) && data.signals.length > 0;
}

/** Warnings come through as plain messages; pick them out by their wording. */
function isWarningEvent(event: PipelineEvent): boolean {
  return /\b(failed|skipped|could not|rejected|no results|nothing to|stopping)\b/i.test(
    event.message,
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

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
    }

    function handleFrame(frame: SseFrame) {
      if (frame.type === "event") {
        const event = frame.event;

        // Take the id now, not inside the updater: React batches updaters and
        // runs them at render time, so several frames from one chunk would
        // otherwise all read the ref's final value and collide on one key.
        const id = ++eventIdRef.current;
        setEvents((prev) => [...prev, { ...event, id }]);

        if (event.stage in STAGE_INDEX) {
          setStageIndex((prev) => Math.max(prev, STAGE_INDEX[event.stage]));
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
        setStageIndex(STAGES.length);
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
      <div className="wrap section">
        <div className="sheet error-sheet narrow">
          <span className="label">Nothing queued</span>
          <p>
            There is no hunt to run. Give Rainmaker an agency website or a
            description on the setup page first.
          </p>
          <div className="actions">
            <a href="/" className="btn btn-primary">
              Go to setup
            </a>
          </div>
        </div>
      </div>
    );
  }

  const status = running ? "running" : errorMessage ? "stopped" : "done";
  const title = running ? "Hunting" : errorMessage ? "Hunt stopped" : "Hunt complete";
  const leadCount = result?.leads.length ?? 0;

  return (
    <div className="wrap section">
      <div className="run-head rise">
        <h1 className={`run-title ${status}`}>
          {title}
          {running ? <span className="ellipsis" aria-hidden="true" /> : null}
        </h1>
      </div>

      <ol className="front rise rise-2" aria-label="Stages">
        {STAGES.map((item, index) => {
          const state =
            stageIndex > index || stageIndex >= STAGES.length
              ? "done"
              : stageIndex === index
                ? "active"
                : "";
          return (
            <li key={item.stage} className={`front-node ${state}`.trim()}>
              <span className="front-dot" />
              <span className="front-name">{item.name}</span>
            </li>
          );
        })}
      </ol>

      <div className="readouts rise rise-3" aria-live="polite">
        <span className="readout">
          <b>{pad(candidatesFound)}</b>
          <span className="label">candidates</span>
        </span>
        <span className="readout">
          <b>{pad(signalsFound)}</b>
          <span className="label">signals</span>
        </span>
        <span className="readout">
          <b>{formatElapsed(elapsedMs)}</b>
          <span className="label">elapsed</span>
        </span>
      </div>

      <div className="wire rise rise-4">
        <div className="wire-bar">
          <span>Wire</span>
          <span className={running ? "on" : ""}>
            {running ? (
              <>
                <span className="pulse" />
                listening
              </>
            ) : (
              "idle"
            )}
          </span>
        </div>
        <div className="feed" ref={feedRef}>
          {events.length === 0 ? (
            <div className="feed-empty">Starting the hunt</div>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                className={`feed-line${
                  isSignalEvent(event) ? " signal" : isWarningEvent(event) ? " warn" : ""
                }`}
              >
                <span className="t">
                  {typeof event.at === "number" ? `${(event.at / 1000).toFixed(1)}s` : ""}
                </span>
                <span className="st">{stageName(event.stage)}</span>
                <span className="msg">{event.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {errorMessage ? (
        <div className="sheet error-sheet">
          <span className="label">Stopped</span>
          <p>{errorMessage}</p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Run it again
            </button>
            <a href="/" className="btn btn-ghost">
              Back to setup
            </a>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="sheet result-sheet rise">
          <div>
            <div className="big">{leadCount}</div>
            <div className="cap">
              lead{leadCount === 1 ? "" : "s"} worth a call &middot;{" "}
              {result.disqualified.length} disqualified &middot;{" "}
              {formatElapsed(result.stats.durationMs)}
            </div>
            <div className="cost">
              est. ${result.stats.estCostUsd.toFixed(2)}
              {result.stats.reportedCostUsd
                ? ` · reported $${result.stats.reportedCostUsd.toFixed(4)}`
                : ""}
            </div>
          </div>
          <a href="/leads" className="btn btn-primary">
            Open the shortlist &rarr;
          </a>
        </div>
      ) : null}
    </div>
  );
}
