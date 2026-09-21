// Thin fetch wrapper around the build-server API. This file (and every
// other file in web/) is served as plain static content, never by the API
// process itself — it never touches Gradle, Docker, SQLite, or build
// directories directly, only the same HTTP API any other client uses.

const API_KEY_STORAGE = "build-server-api-key";
const BASE_URL_STORAGE = "build-server-base-url";

export function getApiKey() {
  return sessionStorage.getItem(API_KEY_STORAGE);
}

export function setApiKey(key) {
  sessionStorage.setItem(API_KEY_STORAGE, key);
}

export function clearApiKey() {
  sessionStorage.removeItem(API_KEY_STORAGE);
}

export function getBaseUrl() {
  return sessionStorage.getItem(BASE_URL_STORAGE) || window.location.origin;
}

export function setBaseUrl(url) {
  sessionStorage.setItem(BASE_URL_STORAGE, url.replace(/\/$/, ""));
}

async function request(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${getApiKey()}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(`${getBaseUrl()}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearApiKey();
    throw new Error("Unauthorized — the API key was rejected. Please sign in again.");
  }

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = isJson && body && body.error ? body.error : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return body;
}

export const api = {
  health: () => request("/health"),
  listBuilds: (params = {}) => request(`/api/v1/builds?${new URLSearchParams(params)}`),
  getBuild: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}`),
  getLogs: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}/logs`),
  getArtifacts: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}/artifacts`),
  submitBuild: (job) => request("/api/v1/builds", { method: "POST", body: JSON.stringify(job) }),
  cancelBuild: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};
