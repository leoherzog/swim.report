// src/beachState.js — the shape of the beach_state table (migration 0014), as
// pure SQL fragments and statement builders. The four derived per-beach records
// — estimate, official, wqfloor, reading — are read here on the request path and
// written here by the crons, so the column list, the expiry rule and the upsert
// live in exactly one module.
//
// Pure: no fetch, no Date, no env. Every builder takes the D1 binding only to
// call prepare/bind, and the caller supplies the clock.

// The wqfloor lease, in seconds. Expiry is the only retraction path for a
// water-quality advisory: a run that finds no advisory writes nothing and the
// standing one ages out.
export const WQFLOOR_TTL_SECONDS = 7200;

// Selected by every request-path query that joins the table. Aliased s, because
// only the beaches side is splatted with b.*.
export const BEACH_STATE_SELECT =
  "s.estimate, s.estimate_expires, s.official, s.official_expires, " +
  "s.wqfloor, s.wqfloor_expires, s.reading, s.reading_expires";

// Leading space so it concatenates straight onto "FROM beaches b".
export const BEACH_STATE_JOIN = " LEFT JOIN beach_state s ON s.beach_id = b.id";

// Selected instead of BEACH_STATE_SELECT by every query that renders a color
// chip and nothing else — the home list, ?ids=, the nearby cards and the map
// features. Those surfaces read the estimate's color and whether an official
// exists, so they take the scalar mirror columns and never the JSON blobs: an
// alert-bearing estimate runs kilobytes, and the home proximity branch ranks
// five times the rows it renders.
export const CHIP_STATE_SELECT =
  "s.estimate_color, s.estimate_updated, s.estimate_expires, " +
  "s.official_color, s.official_updated, s.official_expires";

// Column order of the upsert. beach_id is bound as ?1 and the rest follow in
// this order, so the VALUES list and the bind array cannot drift apart.
const UPSERT_COLUMNS = [
  "estimate",
  "estimate_color",
  "estimate_updated",
  "estimate_expires",
  "official",
  "official_color",
  "official_updated",
  "official_expires",
  "wqfloor",
  "wqfloor_expires",
  "reading",
  "reading_expires"
];

// A record is only ever replaced by a newer one of its own kind or left to
// expire, so every column COALESCEs onto its stored value: a bound NULL means
// "this run produced none", never "clear it".
function buildUpsertSql() {
  const placeholders = [];
  const sets = [];
  for (let i = 0; i < UPSERT_COLUMNS.length; i = i + 1) {
    placeholders.push("?" + String(i + 2));
    sets.push(
      UPSERT_COLUMNS[i] + " = COALESCE(excluded." + UPSERT_COLUMNS[i] +
      ", beach_state." + UPSERT_COLUMNS[i] + ")"
    );
  }
  return "INSERT INTO beach_state (beach_id, " + UPSERT_COLUMNS.join(", ") + ") " +
    "VALUES (?1, " + placeholders.join(", ") + ") " +
    "ON CONFLICT(beach_id) DO UPDATE SET " + sets.join(", ");
}

const UPSERT_SQL = buildUpsertSql();

// The alert refresh rewrites the estimate blob and its color only. Leaving
// estimate_updated out of the SET list keeps the standing instant, which is both
// the remaining lease's anchor and the CAS token; leaving estimate_expires out
// keeps the original lease so a refreshed estimate never outlives it.
//
// Adding either column to the SET list breaks both that lifetime neutrality and
// the safety of writing while the refresh is still paging, since the paging
// SELECT filters on estimate_expires.
const CAS_SQL =
  "UPDATE beach_state SET estimate = ?1, estimate_color = ?2 " +
  "WHERE beach_id = ?3 AND estimate_updated = ?4";

// D1 caps a batch at 200 statements per call.
const MAX_STATEMENTS_PER_BATCH = 200;

function parseBlob(blob, expires, nowEpoch) {
  if (typeof blob !== "string" || blob === "") {
    return null;
  }
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= nowEpoch) {
    return null;
  }
  try {
    const parsed = JSON.parse(blob);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}

// Row from any query that selected BEACH_STATE_SELECT (extra columns ignored),
// or null. Returns { estimate, official, wqfloor, reading }, each a parsed
// object or null. Expired (expires <= nowEpoch), NULL or unparseable JSON reads
// as null. Never throws.
export function liveBeachState(row, nowMs) {
  const nowEpoch = Math.floor(nowMs / 1000);
  if (!row) {
    return { estimate: null, official: null, wqfloor: null, reading: null };
  }
  return {
    estimate: parseBlob(row.estimate, row.estimate_expires, nowEpoch),
    official: parseBlob(row.official, row.official_expires, nowEpoch),
    wqfloor: parseBlob(row.wqfloor, row.wqfloor_expires, nowEpoch),
    reading: parseBlob(row.reading, row.reading_expires, nowEpoch)
  };
}

// The color/updated pair a chip renders from, or null when the record is absent
// or past its lease. Same boundary as parseBlob: expires at or below the current
// epoch second is expired.
function liveChipRecord(color, updated, expires, nowEpoch) {
  if (typeof color !== "string" || color === "") {
    return null;
  }
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= nowEpoch) {
    return null;
  }
  return {
    color: color,
    updated: typeof updated === "string" ? updated : null
  };
}

// Row from a query that selected CHIP_STATE_SELECT (extra columns ignored), or
// null. Returns { estimate, official }, each { color, updated } or null, under
// the same expiry rule liveBeachState applies. These are deliberately partial
// records: they carry what a chip and an OFFICIAL badge read and nothing else,
// so a surface that renders a reason string, sources or a reading must select
// BEACH_STATE_SELECT and use liveBeachState instead. Never throws.
export function liveChipState(row, nowMs) {
  const nowEpoch = Math.floor(nowMs / 1000);
  if (!row) {
    return { estimate: null, official: null };
  }
  return {
    estimate: liveChipRecord(
      row.estimate_color, row.estimate_updated, row.estimate_expires, nowEpoch
    ),
    official: liveChipRecord(
      row.official_color, row.official_updated, row.official_expires, nowEpoch
    )
  };
}

function jsonOrNull(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function fieldOrNull(value, key) {
  if (value === null || value === undefined) {
    return null;
  }
  return value[key] === null || value[key] === undefined ? null : value[key];
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const DESCRIPTOR_FIELDS = [
  "estimate",
  "estimateExpires",
  "official",
  "officialExpires",
  "wqfloor",
  "wqfloorExpires",
  "reading",
  "readingExpires"
];

// The hourly gathers its estimate and its official/reading in two separate
// passes, so one beach can arrive as two descriptors; merging before building
// means one statement per beach and no self-conflicting pair inside a batch.
function mergeWrites(writes) {
  const merged = new Map();
  for (const write of writes) {
    if (!write || !write.beachId) {
      continue;
    }
    let entry = merged.get(write.beachId);
    if (!entry) {
      entry = { beachId: write.beachId };
      merged.set(write.beachId, entry);
    }
    for (const field of DESCRIPTOR_FIELDS) {
      if (write[field] !== null && write[field] !== undefined) {
        entry[field] = write[field];
      }
    }
  }
  return merged;
}

// One write descriptor per beach:
//   { beachId, estimate, estimateExpires, official, officialExpires,
//     wqfloor, wqfloorExpires, reading, readingExpires }
// Every field after beachId is optional; an absent one binds NULL and so leaves
// the stored column untouched. Returns one bound statement per beach, for
// env.DB.batch.
export function beachStateUpsertStatements(db, writes) {
  const statements = [];
  for (const write of mergeWrites(writes).values()) {
    statements.push(db.prepare(UPSERT_SQL).bind(
      write.beachId,
      jsonOrNull(write.estimate),
      fieldOrNull(write.estimate, "color"),
      fieldOrNull(write.estimate, "updated"),
      numberOrNull(write.estimateExpires),
      jsonOrNull(write.official),
      fieldOrNull(write.official, "color"),
      fieldOrNull(write.official, "updated"),
      numberOrNull(write.officialExpires),
      jsonOrNull(write.wqfloor),
      numberOrNull(write.wqfloorExpires),
      jsonOrNull(write.reading),
      numberOrNull(write.readingExpires)
    ));
  }
  return statements;
}

// Compare-and-set for the alert refresh: the write lands only while the standing
// estimate_updated is still the one the recompute was decided against, so an
// hourly run that superseded it in between wins and this statement reports
// meta.changes 0.
export function estimateCasStatement(db, beachId, estimate, standingUpdated) {
  return db.prepare(CAS_SQL).bind(
    jsonOrNull(estimate),
    fieldOrNull(estimate, "color"),
    beachId,
    standingUpdated
  );
}

// Splits statements into batch-sized chunks; an empty input yields no chunks.
export function chunkStatements(statements) {
  const chunks = [];
  for (let i = 0; i < statements.length; i = i + MAX_STATEMENTS_PER_BATCH) {
    chunks.push(statements.slice(i, i + MAX_STATEMENTS_PER_BATCH));
  }
  return chunks;
}
