export const THEME_STORAGE_KEY = "ui-theme";

export function applyTheme(preference) {
  const resolved =
    preference === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function getStoredTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) || "dark";
}

export function setTheme(preference) {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyTheme(preference);
  window.dispatchEvent(new CustomEvent("theme-change", { detail: { theme: preference } }));
}
