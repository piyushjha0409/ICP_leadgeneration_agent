import { mkdir } from "node:fs/promises";
import path from "node:path";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import { normalizeDomain } from "@/src/lib/domain";
import type { RunStats } from "@/src/pipeline/run";
import type { Icp, Lead } from "@/src/pipeline/types";

/**
 * Tiny JSON-file persistence for Phase 2 — one lowdb file at `data/db.json`.
 * `data/` is gitignored; the file (and its parent dir) is created on first
 * use. Good enough for a hackathon demo, not for concurrent writers.
 */

export type FeedbackDirection = "up" | "down";

export type RunRecord = {
  id: string;
  startedAt: number;
  icp: Icp;
  leads: Lead[];
  disqualified: Lead[];
  stats: RunStats;
};

export type DbShape = {
  icp: Icp | null;
  runs: RunRecord[];
  feedback: Record<string, FeedbackDirection>;
  seenDomains: string[];
};

const DEFAULT_DATA: DbShape = {
  icp: null,
  runs: [],
  feedback: {},
  seenDomains: [],
};

const MAX_RUNS = 10;
const DB_PATH = path.join(process.cwd(), "data", "db.json");

// Next dev's hot-reload re-executes this module on every edit; caching the
// (lazily-created) db promise on `globalThis` keeps a single instance alive
// across reloads instead of racing multiple writers on the same file.
declare global {
  // eslint-disable-next-line no-var
  var __rainmakerDb: Promise<Low<DbShape>> | undefined;
}

async function initDb(): Promise<Low<DbShape>> {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  const db = await JSONFilePreset<DbShape>(DB_PATH, DEFAULT_DATA);
  // Backfill keys missing from an older db.json (or a fresh empty one).
  db.data = { ...DEFAULT_DATA, ...db.data };
  await db.write();
  return db;
}

/** The single lazily-initialized db instance for this process. */
export function getDb(): Promise<Low<DbShape>> {
  if (!globalThis.__rainmakerDb) {
    globalThis.__rainmakerDb = initDb();
  }
  return globalThis.__rainmakerDb;
}

export async function saveIcp(icp: Icp): Promise<void> {
  const db = await getDb();
  db.data.icp = icp;
  await db.write();
}

function domainsOf(leads: readonly Lead[]): string[] {
  return leads
    .map((lead) => normalizeDomain(lead.company.domain))
    .filter(Boolean);
}

/** Record a finished run: unshift it, keep the last 10, and grow seenDomains. */
export async function saveRun(record: RunRecord): Promise<void> {
  const db = await getDb();

  db.data.runs.unshift(record);
  db.data.runs = db.data.runs.slice(0, MAX_RUNS);
  db.data.icp = record.icp;

  const seen = new Set(db.data.seenDomains);
  for (const domain of domainsOf(record.leads)) seen.add(domain);
  for (const domain of domainsOf(record.disqualified)) seen.add(domain);
  db.data.seenDomains = [...seen];

  await db.write();
}

export async function getLatestRun(): Promise<RunRecord | null> {
  const db = await getDb();
  return db.data.runs[0] ?? null;
}

export async function getSeenDomains(): Promise<string[]> {
  const db = await getDb();
  return db.data.seenDomains;
}

export async function getIcp(): Promise<Icp | null> {
  const db = await getDb();
  return db.data.icp;
}

/**
 * Set feedback for a domain. Posting the same direction twice clears it
 * (a toggle), which is what the leads UI's thumbs buttons expect.
 */
export async function setFeedback(
  domain: string,
  direction: FeedbackDirection,
): Promise<FeedbackDirection | null> {
  const db = await getDb();
  const key = normalizeDomain(domain) || domain;

  const next = db.data.feedback[key] === direction ? null : direction;
  if (next) db.data.feedback[key] = next;
  else delete db.data.feedback[key];

  await db.write();
  return next;
}

export async function getFeedback(): Promise<Record<string, FeedbackDirection>> {
  const db = await getDb();
  return db.data.feedback;
}
