import { api, clearSession, getCurrentUser, setSession } from "./api.js";
import { renderAdmin } from "./admin.js";
import { renderPasswordReset, renderProfile, renderRequestAccess, renderSignIn, renderSignup } from "./auth.js";

export const root = document.getElementById("app");
let dashboardTimer = null;

export function stopDashboardPolling() {
  if (dashboardTimer) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function loadNotificationBanner() {
  if (!getCurrentUser()) return;

  const el = document.getElementById("notificationBanner");
  if (!el) return;

  try {
    const { notifications } = await api.getNotifications();

    if (notifications.length === 0) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = notifications.map((n) => `
      <div class="banner">
        <span>${escapeHtml(n.message)}</span>
        <button data-dismiss-notification="${n.id}" aria-label="Dismiss">&times;</button>
      </div>
    `).join("");

    el.querySelectorAll("[data-dismiss-notification]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.markNotificationRead(btn.dataset.dismissNotification);
        } catch {
          // best-effort — don't block dismissal on a failed request
        }
        loadNotificationBanner();
      });
    });
  } catch {
    // Best-effort — a failed notification fetch shouldn't disrupt the page.
  }
}

// Independent of dashboardTimer (which only runs on some pages) — the
// banner should stay current on every authenticated page.
setInterval(loadNotificationBanner, 30000);

export function layout(activeRoute, bodyHtml) {
  const links = [
    ["#/", "Dashboard"],
    ["#/submit", "Submit build"],
    ["#/profile", "Profile"],
    ["#/admin", "Admin"],
    ["#/help", "Help"],
  ];

  const nav = links
    .map(([href, label]) => `<a href="${href}" class="${activeRoute === href ? "active" : ""}">${label}</a>`)
    .join("");

  root.innerHTML = `
    <header>
      <h1>build-server</h1>
      <div class="row">
        <nav>${nav}</nav>
        <button id="signOut">Sign out</button>
      </div>
    </header>
    <div id="notificationBanner"></div>
    <main>${bodyHtml}</main>
  `;

  document.getElementById("signOut").addEventListener("click", async () => {
    stopDashboardPolling();

    try {
      await api.logout();
    } catch {
      clearSession();
    }

    renderRoute();
  });

  loadNotificationBanner();
}

export function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

async function renderDashboard() {
  layout("#/", `
    <div class="spaced">
      <h2>Builds</h2>
      <button id="refreshBtn">Refresh</button>
    </div>
    <div id="dashboardError"></div>
    <div id="buildsTable">Loading…</div>
  `);

  document.getElementById("refreshBtn").addEventListener("click", loadBuilds);

  async function loadBuilds() {
    try {
      const { builds } = await api.listBuilds({ limit: 50 });
      const errorEl = document.getElementById("dashboardError");
      const tableEl = document.getElementById("buildsTable");

      if (!errorEl || !tableEl) return; // navigated away

      errorEl.innerHTML = "";

      if (builds.length === 0) {
        tableEl.innerHTML = `<p class="muted">No builds yet — submit one to get started.</p>`;
        return;
      }

      tableEl.innerHTML = `
        <table>
          <thead>
            <tr><th>Project</th><th>Status</th><th>Platform</th><th>Submitted</th></tr>
          </thead>
          <tbody>
            ${builds.map((b) => `
              <tr>
                <td><a class="row-link" href="#/builds/${encodeURIComponent(b.id)}">${escapeHtml(b.projectName ?? b.id)}</a></td>
                <td>${statusBadge(b.status)}</td>
                <td>${escapeHtml(b.platform ?? "—")}</td>
                <td class="muted">${escapeHtml(new Date(b.submittedAt).toLocaleString())}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    } catch (error) {
      const errorEl = document.getElementById("dashboardError");
      if (errorEl) errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      if (error.message.includes("session")) renderRoute();
    }
  }

  await loadBuilds();
  stopDashboardPolling();
  dashboardTimer = setInterval(loadBuilds, 5000);
}

async function renderSubmit() {
  stopDashboardPolling();

  layout("#/submit", `
    <h2>Submit a build</h2>
    <div id="submitError"></div>
    <div class="card">
      <div class="field">
        <label for="projectName">Project name</label>
        <input id="projectName" placeholder="MyApp" />
      </div>
      <div class="field">
        <label for="sourceType">Source type</label>
        <select id="sourceType">
          <option value="git">git</option>
          <option value="directory">directory (trusted/internal only)</option>
        </select>
      </div>
      <div class="field">
        <label for="sourceValue">Git URL (or directory path)</label>
        <input id="sourceValue" placeholder="https://github.com/example/project.git" />
      </div>
      <div class="field">
        <label for="ref">Git ref (optional)</label>
        <input id="ref" placeholder="main" />
      </div>
      <div class="field">
        <label for="projectRoot">Project root (optional, for monorepos)</label>
        <input id="projectRoot" placeholder="app" />
      </div>
      <div class="row">
        <div class="field" style="flex:1">
          <label for="variant">Variant</label>
          <select id="variant">
            <option value="release">release</option>
            <option value="debug">debug</option>
          </select>
        </div>
        <div class="field" style="flex:1">
          <label for="artifact">Artifact</label>
          <select id="artifact">
            <option value="apk">apk</option>
            <option value="aab">aab</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="envJson">Environment variables (JSON object, optional)</label>
        <input id="envJson" placeholder='{"EXPO_PUBLIC_API_URL":"https://example.com"}' />
      </div>
      <div class="field">
        <label for="secretsJson">Secrets (JSON object, optional — never logged or redisplayed)</label>
        <input id="secretsJson" type="password" placeholder='{"ANDROID_GOOGLE_MAPS_API_KEY":"..."}' />
      </div>
      <button class="primary" id="submitBtn">Submit build</button>
    </div>
  `);

  document.getElementById("submitBtn").addEventListener("click", async () => {
    const errorEl = document.getElementById("submitError");
    errorEl.innerHTML = "";

    const projectName = document.getElementById("projectName").value.trim();
    const sourceType = document.getElementById("sourceType").value;
    const sourceValue = document.getElementById("sourceValue").value.trim();
    const ref = document.getElementById("ref").value.trim();
    const projectRoot = document.getElementById("projectRoot").value.trim();
    const variant = document.getElementById("variant").value;
    const artifact = document.getElementById("artifact").value;
    const envJson = document.getElementById("envJson").value.trim();
    const secretsJson = document.getElementById("secretsJson").value.trim();

    if (!projectName || !sourceValue) {
      errorEl.innerHTML = `<div class="error">Project name and source are required.</div>`;
      return;
    }

    let env;
    let secrets;

    try {
      env = envJson ? JSON.parse(envJson) : undefined;
      secrets = secretsJson ? JSON.parse(secretsJson) : undefined;
    } catch {
      errorEl.innerHTML = `<div class="error">Environment/secrets must be valid JSON objects.</div>`;
      return;
    }

    const source = sourceType === "git"
      ? { type: "git", url: sourceValue, ...(ref ? { ref } : {}) }
      : { type: "directory", path: sourceValue };

    const job = {
      project: {
        name: projectName,
        source,
        ...(projectRoot ? { projectRoot } : {}),
      },
      build: {
        platform: "android",
        variant,
        artifact,
        ...(env ? { env } : {}),
        ...(secrets ? { secrets } : {}),
      },
    };

    try {
      const result = await api.submitBuild(job);
      window.location.hash = `#/builds/${encodeURIComponent(result.id)}`;
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

async function renderBuildDetail(id) {
  stopDashboardPolling();

  layout("#/", `
    <p><a class="row-link" href="#/">&larr; Back to dashboard</a></p>
    <div id="detailError"></div>
    <div id="detailBody">Loading…</div>
  `);

  async function load() {
    try {
      const [build, logs, artifactsResp] = await Promise.all([
        api.getBuild(id),
        api.getLogs(id).catch(() => ({ logs: "" })),
        api.getArtifacts(id).catch(() => ({ artifacts: [] })),
      ]);

      const bodyEl = document.getElementById("detailBody");
      if (!bodyEl) return;

      const canCancel = ["queued", "building"].includes(build.status);
      const logText = typeof logs === "string" ? logs : (logs.logs ?? "");

      bodyEl.innerHTML = `
        <div class="card">
          <div class="spaced">
            <h2>${escapeHtml(build.id)}</h2>
            ${statusBadge(build.status)}
          </div>
          <p class="muted">
            Platform: ${escapeHtml(build.platform ?? "—")} ·
            Variant: ${escapeHtml(build.variant ?? "—")} ·
            Artifact: ${escapeHtml(build.artifactType ?? "—")}
          </p>
          <p class="muted">
            Submitted: ${escapeHtml(new Date(build.submittedAt).toLocaleString())}
            ${build.completedAt ? ` · Completed: ${escapeHtml(new Date(build.completedAt).toLocaleString())}` : ""}
          </p>
          ${build.failureReason ? `<div class="error">${escapeHtml(build.failureReason)}</div>` : ""}
          ${canCancel ? `<button class="danger" id="cancelBtn">Cancel build</button>` : ""}
        </div>

        <div class="card">
          <h3>Artifacts</h3>
          ${artifactsResp.artifacts.length === 0
            ? `<p class="muted">No artifacts yet.</p>`
            : `<ul>${artifactsResp.artifacts.map((a) => `
                <li><a href="${a.downloadUrl}">${escapeHtml(a.filename)}</a>
                  <span class="muted">(${(a.size / (1024 * 1024)).toFixed(1)} MB)</span></li>
              `).join("")}</ul>`}
        </div>

        <div class="card">
          <h3>Logs</h3>
          <pre class="logs">${escapeHtml(logText || "(no logs yet)")}</pre>
        </div>
      `;

      const cancelBtn = document.getElementById("cancelBtn");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", async () => {
          cancelBtn.disabled = true;
          try {
            await api.cancelBuild(id);
            await load();
          } catch (error) {
            document.getElementById("detailError").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
            cancelBtn.disabled = false;
          }
        });
      }
    } catch (error) {
      const errorEl = document.getElementById("detailError");
      if (errorEl) errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  }

  await load();
  dashboardTimer = setInterval(load, 4000);
}

function renderHelpContent() {
  return `
    <h2>Help</h2>
    <div class="card">
      <h3>Signing in</h3>
      <p>Sign in with your username and password, then a 6-digit code
        from an authenticator app (or one of your recovery codes).
        Two-factor authentication is required for every account here —
        there's no way to turn it off.</p>
      <p class="muted">Don't have an account? Use
        <a class="row-link" href="#/request-access">Request access</a> —
        an admin reviews it and, if approved, sends you an invite link.</p>
    </div>
    <div class="card">
      <h3>What you can do</h3>
      <p>Your own account and any API keys you create for yourself only
        ever see your own builds — never anyone else's, and admins can't
        see them either. A "missing required scope" error on an API key
        means that action isn't part of what that specific key can do,
        not a bug.</p>
    </div>
    <div class="card">
      <h3>Dashboard</h3>
      <p>Lists your builds. Click a project name for details. Refreshes
        automatically every 5 seconds.</p>
      <table>
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>${statusBadge("queued")}</td><td>Waiting its turn — only one build runs at a time.</td></tr>
          <tr><td>${statusBadge("building")}</td><td>Running right now.</td></tr>
          <tr><td>${statusBadge("completed")}</td><td>Done — check its Artifacts.</td></tr>
          <tr><td>${statusBadge("failed")}</td><td>Something went wrong — check its Logs.</td></tr>
          <tr><td>${statusBadge("cancelled")}</td><td>Stopped before finishing.</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <h3>Submitting a build</h3>
      <p>Git sources must be <code>https://</code> URLs (non-HTTPS and
        internal addresses are rejected as a security measure unless this
        deployment specifically allows them). Use "Project root" only for
        a monorepo where the Android project isn't at the repository's
        top level. Secrets are encrypted while queued and masked
        everywhere afterward — there's no way to view one back out once
        submitted.</p>
    </div>
    <div class="card">
      <h3>Build detail</h3>
      <p>Artifacts appear here once a build completes, as a direct,
        permanent download link — no sign-in needed to use it, so treat
        the link itself as a credential. Logs show the build's real
        output; the failure reason (if any) is just a short summary.
        Cancel is only available while a build is queued or building.</p>
    </div>
    <div class="card">
      <h3>Profile</h3>
      <p>Change your password, regenerate your two-factor recovery codes
        (invalidates the old ones), and create or revoke your own API
        keys for CI/scripted access — always scoped to your own builds,
        never able to manage other accounts or the server itself.</p>
    </div>
    <div class="card">
      <h3>Admin page</h3>
      <p>Requires an admin account, signed in — never an API key, even a
        full-access one. Manage accounts (never their build data),
        invites, signup requests, and send a broadcast notification to
        everyone (the one deliberate exception to every account's
        isolation from every other). Also: the running version, a real
        update/backup trigger, and the service's own log.</p>
    </div>
    <p class="muted">
      Full walkthrough:
      <a href="https://github.com/jasonhaymond/build-server/blob/master/docs/using-the-web-ui.md">docs/using-the-web-ui.md</a>
      · API reference:
      <a href="https://github.com/jasonhaymond/build-server/blob/master/docs/api-reference.md">docs/api-reference.md</a>
    </p>
  `;
}

function renderHelp() {
  stopDashboardPolling();

  if (getCurrentUser()) {
    layout("#/help", renderHelpContent());
    return;
  }

  root.innerHTML = `
    <main style="max-width: 640px; margin: 40px auto;">
      <p><a class="row-link" href="#/signin">&larr; Back to sign in</a></p>
      ${renderHelpContent()}
    </main>
  `;
}

let sessionRestoreAttempted = false;

// A page reload keeps the session cookie (it's not something JS ever
// touches) but loses every in-memory JS variable, including the CSRF
// token — whoami() re-establishes both from the still-valid cookie
// alone. Only ever attempted once per page load; a failure just means
// "not signed in," not something to keep retrying.
async function ensureSessionRestored() {
  if (getCurrentUser() || sessionRestoreAttempted) return;
  sessionRestoreAttempted = true;

  try {
    const who = await api.whoami();

    if (who.authMethod === "session") {
      setSession({ id: who.id, username: who.username, role: who.role }, who.csrfToken);
    }
  } catch {
    // Not signed in — the normal, expected case on a fresh visit.
  }
}

export async function renderRoute() {
  await ensureSessionRestored();

  const hash = window.location.hash || "#/";

  if (hash === "#/help") {
    renderHelp();
    return;
  }

  if (hash.startsWith("#/signup")) {
    stopDashboardPolling();
    renderSignup(hash);
    return;
  }

  if (hash.startsWith("#/password-reset")) {
    stopDashboardPolling();
    renderPasswordReset(hash);
    return;
  }

  if (hash === "#/request-access") {
    stopDashboardPolling();
    renderRequestAccess();
    return;
  }

  if (!getCurrentUser()) {
    stopDashboardPolling();
    renderSignIn();
    return;
  }

  const buildMatch = hash.match(/^#\/builds\/(.+)$/);

  if (hash === "#/submit") {
    renderSubmit();
  } else if (hash === "#/admin") {
    renderAdmin();
  } else if (hash === "#/profile") {
    renderProfile();
  } else if (buildMatch) {
    renderBuildDetail(decodeURIComponent(buildMatch[1]));
  } else {
    renderDashboard();
  }
}

window.addEventListener("hashchange", renderRoute);
renderRoute();
