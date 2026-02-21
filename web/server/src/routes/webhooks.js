/**
 * Webhook / integrations configuration routes.
 */
import {
  readMergedConfig,
  readOverrideConfig,
  writeConfig,
} from "../utils/config.js";

const WEBHOOK_TARGETS = [
  { id: "default", label: "Default (raw JSON)", description: "Native format for custom endpoints, relays, or generic webhooks" },
  { id: "discord", label: "Discord", description: "Discord webhook format (embeds). Use your Discord webhook URL directly" },
];

function resolveRateLimit(hookOrTarget, parent) {
  const max = hookOrTarget?.rate_limit_max_messages ?? parent?.rate_limit_max_messages;
  const tf = hookOrTarget?.rate_limit_timeframe ?? parent?.rate_limit_timeframe;
  if (max !== undefined && max !== null && max !== "") return { max: Number(max) || 60, tf: tf || "1m" };
  const legacy = hookOrTarget?.rate_limit_per_minute ?? parent?.rate_limit_per_minute;
  if (legacy !== undefined && legacy !== null && legacy !== "") return { max: Number(legacy) || 60, tf: "1m" };
  return { max: 60, tf: "1m" };
}

function normalizeWebhookTargets(hook, parentRateLimit) {
  const targets = Array.isArray(hook?.targets) ? hook.targets : [];
  if (targets.length > 0) {
    return targets.map((t) => {
      const { max, tf } = resolveRateLimit(t, hook);
      return {
        url: String(t?.url || "").trim(),
        timeout: String(t?.timeout || "5s").trim() || "5s",
        target: (String(t?.target || t?.format || "default").trim().toLowerCase()) || "default",
        rate_limit_max_messages: max,
        rate_limit_timeframe: tf,
        context: t?.context && typeof t.context === "object" ? t.context : {},
      };
    }).filter((t) => t.url);
  }
  if (hook?.url?.trim()) {
    const { max, tf } = resolveRateLimit(hook, parentRateLimit);
    return [{
      url: String(hook.url).trim(),
      timeout: String(hook.timeout || "5s").trim() || "5s",
      target: (String(hook.target || hook.format || "default").trim().toLowerCase()) || "default",
      rate_limit_max_messages: max,
      rate_limit_timeframe: tf,
      context: hook.context && typeof hook.context === "object" ? hook.context : {},
    }];
  }
  return [];
}

function buildTestPayload(hookType, target, context) {
  const t = (String(target || "default").trim().toLowerCase()) || "default";
  const ctx = context && typeof context === "object" ? context : {};
  const timestamp = new Date().toISOString();

  if (hookType === "on_error") {
    const payload = {
      qname: "example.test",
      client_ip: "192.168.1.100",
      timestamp,
      outcome: "upstream_error",
      upstream_address: "1.1.1.1:53",
      qtype: "A",
      duration_ms: 125.5,
      error_message: "connection refused",
      context: Object.keys(ctx).length ? ctx : undefined,
    };
    if (t === "discord") {
      const body = {
        content: null,
        embeds: [{
          title: "DNS Error (Test)",
          color: 15158332,
          fields: [
            { name: "Query", value: payload.qname, inline: true },
            { name: "Outcome", value: payload.outcome, inline: true },
            { name: "Client", value: payload.client_ip, inline: true },
            { name: "QType", value: payload.qtype, inline: true },
            { name: "Duration", value: `${payload.duration_ms} ms`, inline: true },
            { name: "Upstream", value: payload.upstream_address, inline: true },
            { name: "Error", value: payload.error_message, inline: false },
          ],
          timestamp: payload.timestamp,
        }],
      };
      if (Object.keys(ctx).length) {
        for (const [k, v] of Object.entries(ctx)) {
          body.embeds[0].fields.push(
            { name: k, value: Array.isArray(v) ? v.join(", ") : String(v), inline: true }
          );
        }
      }
      return JSON.stringify(body);
    }
    return JSON.stringify(payload);
  }

  const payload = {
    qname: "ads.example.com",
    client_ip: "192.168.1.100",
    timestamp,
    outcome: "blocked",
    context: Object.keys(ctx).length ? ctx : undefined,
  };
  if (t === "discord") {
    const body = {
      content: null,
      embeds: [{
        title: "Blocked Query (Test)",
        color: 3066993,
        fields: [
          { name: "Query", value: payload.qname, inline: true },
          { name: "Client", value: payload.client_ip, inline: true },
          { name: "Outcome", value: payload.outcome, inline: true },
        ],
        timestamp: payload.timestamp,
      }],
    };
    if (Object.keys(ctx).length) {
      for (const [k, v] of Object.entries(ctx)) {
        body.embeds[0].fields.push(
          { name: k, value: Array.isArray(v) ? v.join(", ") : String(v), inline: true }
        );
      }
    }
    return JSON.stringify(body);
  }
  return JSON.stringify(payload);
}

function getCtx(req) {
  return req.app.locals.ctx ?? {};
}

export function registerWebhooksRoutes(app) {
  app.get("/api/webhooks", async (req, res) => {
    const { defaultConfigPath, configPath } = getCtx(req);
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const webhooks = config.webhooks || {};
      const onBlock = webhooks.on_block || {};
      const onError = webhooks.on_error || {};
      const onBlockRateLimit = resolveRateLimit(onBlock, {});
      const onErrorRateLimit = resolveRateLimit(onError, {});
      res.json({
        targets: WEBHOOK_TARGETS,
        on_block: {
          enabled: onBlock.enabled === true,
          targets: normalizeWebhookTargets(onBlock, onBlock),
          rate_limit_max_messages: onBlockRateLimit.max,
          rate_limit_timeframe: onBlockRateLimit.tf,
        },
        on_error: {
          enabled: onError.enabled === true,
          targets: normalizeWebhookTargets(onError, onError),
          rate_limit_max_messages: onErrorRateLimit.max,
          rate_limit_timeframe: onErrorRateLimit.tf,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read webhooks config" });
    }
  });

  app.put("/api/webhooks", async (req, res) => {
    const { defaultConfigPath, configPath } = getCtx(req);
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const body = req.body || {};
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.webhooks = overrideConfig.webhooks || {};

      const updateHook = (key, input) => {
        if (!input) return;
        const existing = overrideConfig.webhooks[key] || {};
        const hook = { ...existing };
        if (input.enabled !== undefined) hook.enabled = Boolean(input.enabled);
        if (input.rate_limit_max_messages !== undefined) {
          const v = Number(input.rate_limit_max_messages);
          hook.rate_limit_max_messages = Number.isNaN(v) ? 60 : v;
        }
        if (input.rate_limit_timeframe !== undefined) {
          hook.rate_limit_timeframe = String(input.rate_limit_timeframe || "1m").trim() || "1m";
        }
        if (Array.isArray(input.targets)) {
          const defaultMax = hook.rate_limit_max_messages ?? 60;
          const defaultTf = hook.rate_limit_timeframe ?? "1m";
          const normalized = input.targets
            .filter((t) => t && String(t?.url || "").trim())
            .map((t) => ({
              url: String(t.url).trim(),
              timeout: String(t?.timeout || "5s").trim() || "5s",
              target: (String(t?.target || "default").trim().toLowerCase()) || "default",
              rate_limit_max_messages: t?.rate_limit_max_messages ?? defaultMax,
              rate_limit_timeframe: t?.rate_limit_timeframe ?? defaultTf,
              context: t?.context && typeof t.context === "object" ? t.context : {},
            }));
          hook.targets = normalized;
          if (normalized.length === 0) {
            delete hook.url;
            delete hook.target;
            delete hook.context;
          }
        }
        overrideConfig.webhooks[key] = hook;
      };

      if (body.on_block !== undefined) updateHook("on_block", body.on_block);
      if (body.on_error !== undefined) updateHook("on_error", body.on_error);

      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, message: "Webhooks saved. Restart the DNS service to apply changes." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update webhooks config" });
    }
  });

  app.post("/api/webhooks/test", async (req, res) => {
    const { type, url, target, context, targets } = req.body || {};
    const hookType = String(type || "on_block").trim().toLowerCase();

    let toTest = [];
    if (Array.isArray(targets) && targets.length > 0) {
      toTest = targets
        .filter((t) => t && String(t?.url || "").trim())
        .map((t) => ({
          url: String(t.url).trim(),
          target: (String(t?.target || "default").trim().toLowerCase()) || "default",
          context: t?.context && typeof t.context === "object" ? t.context : {},
        }));
    } else if (String(url || "").trim()) {
      toTest = [{
        url: String(url).trim(),
        target: (String(target || "default").trim().toLowerCase()) || "default",
        context: context && typeof context === "object" ? context : {},
      }];
    }

    if (toTest.length === 0) {
      res.status(400).json({ error: "url or targets with at least one URL is required" });
      return;
    }

    for (const t of toTest) {
      try {
        new URL(t.url);
      } catch {
        res.status(400).json({ error: `Invalid URL: ${t.url}` });
        return;
      }
    }

    const timeoutMs = 10000;
    const results = [];

    for (const t of toTest) {
      const body = buildTestPayload(hookType, t.target, t.context);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(t.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        results.push({ url: t.url, ok: response.ok, status: response.status, error: null });
        if (!response.ok) {
          const text = await response.text();
          results[results.length - 1].error = `${response.status}: ${text.slice(0, 100)}`;
        }
      } catch (err) {
        clearTimeout(timeoutId);
        results.push({
          url: t.url,
          ok: false,
          status: null,
          error: err.name === "AbortError" ? "Request timed out" : err.message,
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      const msg = results.length === 1
        ? `Test webhook delivered successfully (${results[0].status})`
        : `Test webhook delivered to ${results.length} target(s) successfully`;
      res.json({ ok: true, message: msg, results });
    } else {
      const errors = failed.map((r) => `${r.url}: ${r.error}`).join("; ");
      res.status(502).json({
        ok: false,
        error: failed.length === results.length ? errors : `${failed.length} of ${results.length} failed: ${errors}`,
        results,
      });
    }
  });
}
