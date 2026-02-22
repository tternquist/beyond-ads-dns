/**
 * Sets up visibility-aware polling: runs the load callback immediately and at the given
 * interval, but pauses when the tab is hidden (document.visibilityState === "hidden")
 * and resumes when the tab becomes visible.
 *
 * Reduces unnecessary network requests and CPU usage when the user is not viewing the app.
 *
 * @param {() => void} load - Callback to run (e.g. API fetch)
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {() => void} Cleanup function to remove listener and clear timer
 */
export function setupVisibilityAwarePolling(load, intervalMs) {
  let timer = null;

  const scheduleNext = () => {
    if (document.visibilityState === "hidden") return;
    timer = setTimeout(() => {
      load();
      scheduleNext();
    }, intervalMs);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      load();
      scheduleNext();
    } else {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };

  load();
  scheduleNext();
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (timer) clearTimeout(timer);
  };
}
