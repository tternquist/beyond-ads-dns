/**
 * ClickHouse query endpoints for DNS query data.
 */
import { toNumber, clampNumber } from "../utils/helpers.js";
import { readMergedConfig } from "../utils/config.js";
import {
  normalizeSortBy,
  normalizeSortDir,
  buildQueryFilters,
} from "../services/clickhouse.js";

function ctx(req) {
  return req.app.locals.ctx ?? {};
}

export function registerQueriesRoutes(app) {
  app.get("/api/queries/recent", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        sortBy: "ts",
        sortDir: "desc",
      });
      return;
    }
    const page = clampNumber(req.query.page, 1, 1, 100000);
    const pageSize = clampNumber(req.query.page_size, 50, 1, 500);
    const offset = (page - 1) * pageSize;
    const sortBy = normalizeSortBy(req.query.sort_by);
    const sortDir = normalizeSortDir(req.query.sort_dir);
    const filters = buildQueryFilters(req);

    const whereClause = filters.clauses.length
      ? `WHERE ${filters.clauses.join(" AND ")}`
      : "";

    const baseQuery = `
      FROM ${clickhouseDatabase}.${clickhouseTable}
      ${whereClause}
    `;
    const query = `
      SELECT ts, client_ip, client_name, protocol, qname, qtype, qclass, outcome, rcode, duration_ms
      ${baseQuery}
      ORDER BY ${sortBy} ${sortDir}
      LIMIT {limit: UInt32}
      OFFSET {offset: UInt32}
    `;
    const countQuery = `
      SELECT count() as total
      ${baseQuery}
    `;
    try {
      const [result, countResult] = await Promise.all([
        clickhouseClient.query({
          query,
          query_params: { ...filters.params, limit: pageSize, offset },
        }),
        clickhouseClient.query({
          query: countQuery,
          query_params: filters.params,
        }),
      ]);
      const rows = await result.json();
      const countRows = await countResult.json();
      const total =
        countRows.data && countRows.data.length > 0
          ? Number(countRows.data[0].total)
          : 0;
      res.json({
        enabled: true,
        rows: rows.data || [],
        total,
        page,
        pageSize,
        sortBy,
        sortDir,
      });
    } catch (err) {
      // Return enabled: true with empty data so UI shows loading, not "disabled".
      // Query may fail transiently (e.g. table not created yet on slow Pi).
      res.json({
        enabled: true,
        rows: [],
        total: 0,
        page,
        pageSize,
        sortBy,
        sortDir,
      });
    }
  });

  app.get("/api/queries/export", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.status(400).json({ error: "ClickHouse is not enabled" });
      return;
    }
    const limit = clampNumber(req.query.limit, 5000, 1, 50000);
    const sortBy = normalizeSortBy(req.query.sort_by);
    const sortDir = normalizeSortDir(req.query.sort_dir);
    const filters = buildQueryFilters(req);
    const whereClause = filters.clauses.length
      ? `WHERE ${filters.clauses.join(" AND ")}`
      : "";
    const query = `
      SELECT ts, client_ip, client_name, protocol, qname, qtype, qclass, outcome, rcode, duration_ms
      FROM ${clickhouseDatabase}.${clickhouseTable}
      ${whereClause}
      ORDER BY ${sortBy} ${sortDir}
      LIMIT {limit: UInt32}
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { ...filters.params, limit },
        format: "CSVWithNames",
      });
      const body = await result.text();
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=\"dns-queries.csv\""
      );
      res.send(body);
    } catch (err) {
      res.status(500).json({ error: err.message || "Export failed" });
    }
  });

  app.get("/api/queries/summary", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, windowMinutes: null, total: 0, statuses: [] });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT outcome, count() as count
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
      GROUP BY outcome
      ORDER BY count DESC
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const statuses = (rows.data || []).map((row) => ({
        outcome: row.outcome,
        count: toNumber(row.count),
      }));
      const total = statuses.reduce((sum, row) => sum + row.count, 0);
      res.json({ enabled: true, windowMinutes, total, statuses });
    } catch (err) {
      // Return enabled: true with empty data so UI shows loading, not "disabled".
      res.json({ enabled: true, windowMinutes, total: 0, statuses: [] });
    }
  });

  app.get("/api/queries/latency", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        windowMinutes: null,
        count: 0,
        avgMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT
        count() as count,
        avg(duration_ms) as avg,
        min(duration_ms) as min,
        max(duration_ms) as max,
        quantile(0.5)(duration_ms) as p50,
        quantile(0.95)(duration_ms) as p95,
        quantile(0.99)(duration_ms) as p99
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const stats = rows.data && rows.data.length > 0 ? rows.data[0] : {};
      const count = toNumber(stats.count);
      res.json({
        enabled: true,
        windowMinutes,
        count,
        avgMs: count ? toNumber(stats.avg) : null,
        minMs: count ? toNumber(stats.min) : null,
        maxMs: count ? toNumber(stats.max) : null,
        p50Ms: count ? toNumber(stats.p50) : null,
        p95Ms: count ? toNumber(stats.p95) : null,
        p99Ms: count ? toNumber(stats.p99) : null,
      });
    } catch (err) {
      // Return enabled: true with empty data so UI shows loading, not "disabled".
      res.json({
        enabled: true,
        windowMinutes,
        count: 0,
        avgMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      });
    }
  });

  app.get("/api/queries/time-series", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        windowMinutes: null,
        bucketMinutes: null,
        buckets: [],
        latencyBuckets: [],
      });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const bucketMinutes = clampNumber(req.query.bucket_minutes, 5, 1, Math.min(60, windowMinutes));
    const bucketExpr = `toStartOfInterval(ts, INTERVAL {bucket: UInt32} MINUTE)`;
    const whereClause = `WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE`;
    try {
      const [countResult, latencyResult] = await Promise.all([
        clickhouseClient.query({
          query: `
            SELECT
              ${bucketExpr} as bucket,
              count() as total,
              countIf(outcome = 'cached') as cached,
              countIf(outcome = 'local') as local,
              countIf(outcome = 'stale') as stale,
              countIf(outcome = 'upstream') as upstream,
              countIf(outcome = 'blocked') as blocked,
              countIf(outcome = 'upstream_error') as upstream_error,
              countIf(outcome = 'invalid') as invalid
            FROM ${clickhouseDatabase}.${clickhouseTable}
            ${whereClause}
            GROUP BY bucket
            ORDER BY bucket
          `,
          query_params: { window: windowMinutes, bucket: bucketMinutes },
        }),
        clickhouseClient.query({
          query: `
            SELECT
              ${bucketExpr} as bucket,
              count() as count,
              avg(duration_ms) as avg_ms,
              quantile(0.5)(duration_ms) as p50_ms,
              quantile(0.95)(duration_ms) as p95_ms,
              quantile(0.99)(duration_ms) as p99_ms
            FROM ${clickhouseDatabase}.${clickhouseTable}
            ${whereClause}
            GROUP BY bucket
            ORDER BY bucket
          `,
          query_params: { window: windowMinutes, bucket: bucketMinutes },
        }),
      ]);
      const countRows = (await countResult.json()).data || [];
      const latencyRows = (await latencyResult.json()).data || [];
      const buckets = countRows.map((row) => ({
        ts: row.bucket,
        total: toNumber(row.total),
        cached: toNumber(row.cached),
        local: toNumber(row.local),
        stale: toNumber(row.stale),
        upstream: toNumber(row.upstream),
        blocked: toNumber(row.blocked),
        upstream_error: toNumber(row.upstream_error),
        invalid: toNumber(row.invalid),
      }));
      const latencyBuckets = latencyRows.map((row) => ({
        ts: row.bucket,
        count: toNumber(row.count),
        avgMs: toNumber(row.avg_ms),
        p50Ms: toNumber(row.p50_ms),
        p95Ms: toNumber(row.p95_ms),
        p99Ms: toNumber(row.p99_ms),
      }));
      res.json({
        enabled: true,
        windowMinutes,
        bucketMinutes,
        buckets,
        latencyBuckets,
      });
    } catch (err) {
      // Return enabled: true with empty data so UI shows loading, not "disabled".
      res.json({
        enabled: true,
        windowMinutes,
        bucketMinutes,
        buckets: [],
        latencyBuckets: [],
      });
    }
  });

  app.get("/api/queries/upstream-stats", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, windowMinutes: null, total: 0, upstreams: [] });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT upstream_address as address, count() as count
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
        AND outcome IN ('upstream', 'servfail')
        AND upstream_address != ''
      GROUP BY upstream_address
      ORDER BY count DESC
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const upstreams = (rows.data || []).map((row) => ({
        address: row.address || "-",
        count: toNumber(row.count),
      }));
      const total = upstreams.reduce((sum, row) => sum + row.count, 0);
      res.json({ enabled: true, windowMinutes, total, upstreams });
    } catch (err) {
      // Return enabled: true with empty data so UI shows loading, not "disabled".
      res.json({ enabled: true, windowMinutes, total: 0, upstreams: [] });
    }
  });

  app.get("/api/queries/filter-options", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, options: {} });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 1440, 1, 10080);
    const limit = 10;

    try {
      const queries = [
        { field: "outcome", query: `SELECT outcome as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY outcome ORDER BY count DESC LIMIT ${limit}` },
        { field: "rcode", query: `SELECT rcode as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY rcode ORDER BY count DESC LIMIT ${limit}` },
        { field: "qtype", query: `SELECT qtype as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY qtype ORDER BY count DESC LIMIT ${limit}` },
        { field: "protocol", query: `SELECT protocol as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY protocol ORDER BY count DESC LIMIT ${limit}` },
        { field: "client_ip", query: `SELECT coalesce(nullif(client_name, ''), client_ip) as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY value ORDER BY count DESC LIMIT ${limit}` },
        { field: "qname", query: `SELECT qname as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY qname ORDER BY count DESC LIMIT ${limit}` },
      ];

      const results = await Promise.all(
        queries.map(async ({ field, query }) => {
          const result = await clickhouseClient.query({
            query,
            query_params: { window: windowMinutes },
          });
          const rows = await result.json();
          return {
            field,
            values: (rows.data || []).map((row) => ({
              value: row.value,
              count: toNumber(row.count),
            })),
          };
        })
      );

      const options = {};
      for (const { field, values } of results) {
        options[field] = values;
      }

      res.json({ enabled: true, options });
    } catch (err) {
      // Return enabled: true with empty data so UI shows loading, not "disabled".
      res.json({ enabled: true, options: {} });
    }
  });

  app.get("/api/clients/discovery", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable, defaultConfigPath, configPath } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, discovered: [] });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 5, 10080);
    const limit = clampNumber(req.query.limit, 50, 1, 200);
    try {
      const query = `SELECT client_ip as ip, count() as query_count
        FROM ${clickhouseDatabase}.${clickhouseTable}
        WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
          AND client_ip != '' AND client_ip != '-'
        GROUP BY client_ip
        ORDER BY query_count DESC
        LIMIT {limit: UInt32}`;
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes, limit },
      });
      const rows = await result.json();
      const allDiscovered = (rows.data || []).map((r) => ({
        ip: String(r.ip || "").trim(),
        query_count: toNumber(r.query_count),
      })).filter((r) => r.ip);

      let knownIPs = new Set();
      if (defaultConfigPath || configPath) {
        const merged = await readMergedConfig(defaultConfigPath, configPath).catch(() => ({}));
        const clientsRaw = merged?.client_identification?.clients || [];
        const clientsList = Array.isArray(clientsRaw)
          ? clientsRaw
          : Object.keys(clientsRaw);
        for (const c of clientsList) {
          const ip = typeof c === "string" ? c : (c?.ip || "");
          if (ip) knownIPs.add(ip);
        }
      }
      const discovered = allDiscovered
        .filter((r) => !knownIPs.has(r.ip))
        .map((r) => ({ ip: r.ip, query_count: r.query_count }));
      res.json({ enabled: true, discovered });
    } catch (err) {
      res.json({ enabled: false, discovered: [] });
    }
  });

  app.post("/api/system/clear/clickhouse", async (req, res) => {
    const { clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = ctx(req);
    if (!clickhouseEnabled || !clickhouseClient) {
      res.status(400).json({ error: "ClickHouse is not enabled" });
      return;
    }
    try {
      await clickhouseClient.command({
        query: `TRUNCATE TABLE ${clickhouseDatabase}.${clickhouseTable}`,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to clear ClickHouse" });
    }
  });
}
