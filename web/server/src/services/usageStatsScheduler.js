/**
 * Scheduler for Usage Statistics webhook.
 * Runs every minute and sends stats when the configured time matches.
 */
import { readMergedConfig } from "../utils/config.js";
import { collectUsageStats, sendUsageStatsWebhook } from "./usageStatsWebhook.js";

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Returns current local time as HH:MM.
 */
function getCurrentHHMM() {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/**
 * Starts the usage stats webhook scheduler.
 * @param {object} options
 * @param {string} [options.configPath] - Override config path
 * @param {string} [options.defaultConfigPath] - Default config path
 * @param {object} options.ctx - App context (clickhouseClient, dnsControlUrl, etc.)
 * @returns {NodeJS.Timeout} Interval handle for cleanup
 */
export function startUsageStatsScheduler({ configPath, defaultConfigPath, ctx }) {
  let lastSentMinute = null;

  const tick = async () => {
    if (!configPath && !defaultConfigPath) return;
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const usageStats = config.webhooks?.usage_stats_webhook || {};
      if (!usageStats.enabled || !String(usageStats.url || "").trim()) return;

      const scheduleTime = String(usageStats.schedule_time || "08:00").trim();
      const current = getCurrentHHMM();
      if (scheduleTime !== current) return;

      // Avoid sending multiple times in the same minute (e.g. if tick runs twice)
      const minuteKey = `${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}-${current}`;
      if (lastSentMinute === minuteKey) return;
      lastSentMinute = minuteKey;

      const payload = await collectUsageStats(ctx);
      const result = await sendUsageStatsWebhook(usageStats.url.trim(), payload);
      if (!result.ok) {
        console.error("Usage stats webhook failed:", result.error);
      }
    } catch (err) {
      console.error("Usage stats scheduler error:", err.message);
    }
  };

  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  // Run once after 10s to catch startup edge case (e.g. server started at 08:00:05)
  setTimeout(tick, 10000);
  return interval;
}
