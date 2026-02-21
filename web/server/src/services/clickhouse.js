/**
 * ClickHouse client creation and query helpers.
 */
import { createClient } from "@clickhouse/client";
import { clampNumber } from "../utils/helpers.js";

/**
 * Creates a ClickHouse client for query execution.
 * @param {object} options - Client options
 * @param {string} options.url - ClickHouse server URL (e.g. http://localhost:8123)
 * @param {string} [options.database] - Database name
 * @param {string} [options.username] - Username
 * @param {string} [options.password] - Password
 * @returns {import('@clickhouse/client').ClickHouseClient}
 */
export function createClickhouseClient(options) {
  const { url, database = "beyond_ads", username = "default", password = "" } = options;
  return createClient({
    url,
    database,
    username,
    password,
  });
}

export function normalizeSortBy(value) {
  const allowed = new Set([
    "ts",
    "duration_ms",
    "qname",
    "qtype",
    "qclass",
    "outcome",
    "rcode",
    "client_ip",
    "client_name",
    "protocol",
  ]);
  const raw = String(value || "ts").toLowerCase();
  return allowed.has(raw) ? raw : "ts";
}

export function normalizeSortDir(value) {
  const raw = String(value || "desc").toLowerCase();
  return raw === "asc" ? "asc" : "desc";
}

export function buildQueryFilters(req) {
  const clauses = [];
  const params = {};

  const search = String(req.query.q || req.query.search || "").trim();
  if (search) {
    clauses.push(
      "(positionCaseInsensitive(qname, {search: String}) > 0 OR " +
      "positionCaseInsensitive(client_ip, {search: String}) > 0 OR " +
      "positionCaseInsensitive(client_name, {search: String}) > 0)"
    );
    params.search = search;
  }

  const qname = String(req.query.qname || "").trim();
  if (qname) {
    clauses.push("positionCaseInsensitive(qname, {qname: String}) > 0");
    params.qname = qname;
  }
  const outcome = String(req.query.outcome || "").trim();
  if (outcome) {
    const outcomes = outcome.split(",").map((s) => s.trim()).filter(Boolean);
    if (outcomes.length === 1) {
      clauses.push("outcome = {outcome: String}");
      params.outcome = outcomes[0];
    } else if (outcomes.length > 1) {
      const orClauses = outcomes.map((_, i) => `outcome = {outcome_${i}: String}`);
      clauses.push(`(${orClauses.join(" OR ")})`);
      outcomes.forEach((o, i) => {
        params[`outcome_${i}`] = o;
      });
    }
  }
  const rcode = String(req.query.rcode || "").trim();
  if (rcode) {
    clauses.push("rcode = {rcode: String}");
    params.rcode = rcode;
  }
  const qtype = String(req.query.qtype || "").trim();
  if (qtype) {
    clauses.push("qtype = {qtype: String}");
    params.qtype = qtype;
  }
  const qclass = String(req.query.qclass || "").trim();
  if (qclass) {
    clauses.push("qclass = {qclass: String}");
    params.qclass = qclass;
  }
  const protocol = String(req.query.protocol || "").trim();
  if (protocol) {
    clauses.push("protocol = {protocol: String}");
    params.protocol = protocol;
  }
  const client = String(req.query.client_ip || req.query.client || "").trim();
  if (client) {
    clauses.push(
      "(positionCaseInsensitive(client_ip, {client: String}) > 0 OR " +
      "positionCaseInsensitive(client_name, {client: String}) > 0)"
    );
    params.client = client;
  }
  const sinceMinutes = clampNumber(req.query.since_minutes, 0, 0, 525600);
  if (sinceMinutes > 0) {
    clauses.push("ts >= now() - INTERVAL {since: UInt32} MINUTE");
    params.since = sinceMinutes;
  }

  const minDuration = clampNumber(req.query.min_duration_ms, 0, 0, 10_000_000);
  if (minDuration > 0) {
    clauses.push("duration_ms >= {min_duration: UInt32}");
    params.min_duration = minDuration;
  }
  const maxDuration = clampNumber(req.query.max_duration_ms, 0, 0, 10_000_000);
  if (maxDuration > 0) {
    clauses.push("duration_ms <= {max_duration: UInt32}");
    params.max_duration = maxDuration;
  }

  return { clauses, params };
}
