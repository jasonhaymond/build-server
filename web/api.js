// Thin fetch wrapper around the build-server API. This file (and every
// other file in web/) is served as plain static content, never by the API
// process itself — it never touches Gradle, Docker, SQLite, or build
// directories directly, only the same HTTP API any other client uses.
//
// Auth is a real signed-in session (cookie-based, httpOnly — never
// touched directly by this file) rather than a pasted API key. The
// cookie can't carry CSRF protection on its own (that's the point of
// httpOnly), so the server hands back a CSRF token in the login/enroll/
// whoami response body instead; it's kept only in memory here (not
// localStorage/sessionStorage) and echoed back as X-CSRF-Token on every
// mutating request.

import { API_BASE_URL } from "./config.js";

let currentUser = null;
let currentCsrfToken = null;

export function getCurrentUser() {
  return currentUser;
}

export function setSession(user, csrfToken) {
  currentUser = user;
  currentCsrfToken = csrfToken;
}

export function clearSession() {
  currentUser = null;
  currentCsrfToken = null;
}

function baseUrl() {
  return API_BASE_URL || window.location.origin;
}

async function request(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(currentCsrfToken ? { "X-CSRF-Token": currentCsrfToken } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(`${baseUrl()}${path}`, { ...options, headers, credentials: "include" });

  if (res.status === 401) {
    clearSession();
    throw new Error("Your session has expired. Please sign in again.");
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
  whoami: () => request("/api/v1/whoami"),

  // --- Auth (public — no session exists yet for most of these) ---
  login: (username, password) => request("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  }),
  verifyMfa: (mfaToken, code) => request("/api/v1/auth/login/mfa", {
    method: "POST",
    body: JSON.stringify({ mfaToken, code }),
  }),
  logout: async () => {
    await request("/api/v1/auth/logout", { method: "POST" });
    clearSession();
  },
  getInvite: (token) => request(`/api/v1/auth/invites/${encodeURIComponent(token)}`),
  completeInvite: (token, payload) => request(`/api/v1/auth/invites/${encodeURIComponent(token)}/complete`, {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  enrollStart: (enrollmentToken) => request("/api/v1/auth/enroll/start", {
    method: "POST",
    body: JSON.stringify({ enrollmentToken }),
  }),
  enrollConfirm: (enrollmentToken, code) => request("/api/v1/auth/enroll/confirm", {
    method: "POST",
    body: JSON.stringify({ enrollmentToken, code }),
  }),
  getRequestAccessChallenge: () => request("/api/v1/request-access/challenge"),
  submitRequestAccess: (payload) => request("/api/v1/request-access", {
    method: "POST",
    body: JSON.stringify(payload),
  }),

  // --- Builds ---
  listBuilds: (params = {}) => request(`/api/v1/builds?${new URLSearchParams(params)}`),
  getBuild: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}`),
  getLogs: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}/logs`),
  getArtifacts: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}/artifacts`),
  submitBuild: (job) => request("/api/v1/builds", { method: "POST", body: JSON.stringify(job) }),
  cancelBuild: (id) => request(`/api/v1/builds/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  // --- My profile ---
  changePassword: (currentPassword, newPassword) => request("/api/v1/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  }),
  regenerateRecoveryCodes: (currentPassword) => request("/api/v1/me/recovery-codes", {
    method: "POST",
    body: JSON.stringify({ currentPassword }),
  }),
  listMyApiKeys: () => request("/api/v1/api-keys"),
  createMyApiKey: (name, scopes) => request("/api/v1/api-keys", {
    method: "POST",
    body: JSON.stringify(scopes ? { name, scopes } : { name }),
  }),
  revokeMyApiKey: (id) => request(`/api/v1/api-keys/${id}`, { method: "DELETE" }),
  deleteMyApiKey: (id) => request(`/api/v1/api-keys/${id}/purge`, { method: "DELETE" }),

  // --- System (admin) ---
  getSystemStatus: () => request("/api/v1/system"),
  getMetrics: () => request("/api/v1/metrics"),
  getSystemLogs: (params = {}) => request(`/api/v1/system/logs?${new URLSearchParams(params)}`),
  triggerUpdate: (targetRef) => request("/api/v1/system/update", {
    method: "POST",
    body: JSON.stringify(targetRef ? { targetRef } : {}),
  }),
  triggerBackup: () => request("/api/v1/system/backup", { method: "POST", body: "{}" }),

  // --- Admin: users/invites/signup requests/broadcasts ---
  listUsers: () => request("/api/v1/admin/users"),
  updateUser: (id, changes) => request(`/api/v1/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  }),
  resetUserPassword: (id) => request(`/api/v1/admin/users/${id}/reset-password`, { method: "POST", body: "{}" }),
  resetUserTotp: (id) => request(`/api/v1/admin/users/${id}/reset-2fa`, { method: "POST", body: "{}" }),
  createAdminInvite: (payload) => request("/api/v1/admin/invites", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  listAdminInvites: () => request("/api/v1/admin/invites"),
  revokeAdminInvite: (id) => request(`/api/v1/admin/invites/${id}`, { method: "DELETE" }),
  listSignupRequests: () => request("/api/v1/admin/signup-requests"),
  approveSignupRequest: (id, role) => request(`/api/v1/admin/signup-requests/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ role }),
  }),
  rejectSignupRequest: (id) => request(`/api/v1/admin/signup-requests/${id}/reject`, { method: "POST", body: "{}" }),
  sendBroadcast: (message) => request("/api/v1/admin/notifications", {
    method: "POST",
    body: JSON.stringify({ message }),
  }),

  // --- Notifications (any signed-in account's own inbox) ---
  getNotifications: () => request("/api/v1/notifications"),
  markNotificationRead: (id) => request(`/api/v1/notifications/${id}/read`, { method: "POST", body: "{}" }),
};
