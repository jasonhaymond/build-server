// Admin page: version/update/backup/logs (Overview — unchanged from
// before v2.0.0) plus four new tabs for the real-accounts model: Users,
// Invites, Signup requests, Broadcast. Tab state is plain in-page JS,
// not its own hash route — this is one page with sub-views, not four
// separate ones.

import { api } from "./api.js";
import { escapeHtml, layout, statusBadge, stopDashboardPolling } from "./app.js";

const TABS = ["Overview", "Users", "Invites", "Signup requests", "Broadcast"];
let activeTab = "Overview";

export async function renderAdmin() {
  stopDashboardPolling();

  const tabBar = TABS.map((tab) => `
    <button class="tab-btn ${tab === activeTab ? "active" : ""}" data-tab="${escapeHtml(tab)}">${escapeHtml(tab)}</button>
  `).join("");

  layout("#/admin", `
    <h2>Admin</h2>
    <div class="tab-bar">${tabBar}</div>
    <div id="adminError"></div>
    <div id="adminBody">Loading…</div>
  `);

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      renderAdmin();
    });
  });

  const renderers = {
    Overview: renderOverviewTab,
    Users: renderUsersTab,
    Invites: renderInvitesTab,
    "Signup requests": renderSignupRequestsTab,
    Broadcast: renderBroadcastTab,
  };

  await renderers[activeTab]();
}

function showError(message) {
  const errorEl = document.getElementById("adminError");
  if (errorEl) errorEl.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

async function renderOverviewTab() {
  const bodyEl = document.getElementById("adminBody");
  const errorEl = document.getElementById("adminError");

  try {
    const [status, metrics, logs] = await Promise.all([
      api.getSystemStatus(),
      api.getMetrics(),
      api.getSystemLogs({ lines: 100 }),
    ]);

    errorEl.innerHTML = "";

    const updateBanner = status.checked && status.updateAvailable
      ? `<div class="error" style="color: var(--warn); border-color: var(--warn); background: rgba(210,153,34,0.1);">
           A newer version is available: v${escapeHtml(status.latestVersion)} (running v${escapeHtml(status.version)})
         </div>`
      : "";

    const statusRows = Object.entries(metrics.buildsByStatus || {})
      .map(([s, count]) => `<tr><td>${statusBadge(s)}</td><td>${count}</td></tr>`)
      .join("") || `<tr><td colspan="2" class="muted">No builds yet.</td></tr>`;

    const logLines = logs.entries
      .map((e) => `${e.ts ?? ""} [${(e.level ?? "info").toUpperCase()}] ${e.source ?? ""}: ${e.msg ?? ""}`)
      .join("\n");

    bodyEl.innerHTML = `
      ${updateBanner}
      <div class="card">
        <h3>Version</h3>
        <p>Running: <strong>v${escapeHtml(status.version)}</strong>
          ${status.checked ? `· Latest: v${escapeHtml(status.latestVersion)}` : `· <span class="muted">(couldn't check for updates — GITHUB_REPO not set or unreachable)</span>`}
        </p>
        <p class="muted">Last boot: ${status.lastBootAt ? escapeHtml(new Date(status.lastBootAt).toLocaleString()) : "unknown"}</p>
        <div class="row">
          <input id="targetRef" placeholder="Target tag (blank = latest)" style="max-width: 220px;" />
          <button class="primary" id="updateBtn">Update now</button>
        </div>
        <p class="muted">
          Runs the real <code>scripts/update.sh</code> (uncommitted-changes guard,
          pre-update snapshot, health-check poll) in a fresh sibling container.
          Only works for Docker Compose deployments with
          <code>HOST_PROJECT_DIR</code>/<code>API_IMAGE</code> set.
        </p>
      </div>

      <div class="card">
        <h3>Backups</h3>
        <button id="backupBtn">Back up now</button>
        <p class="muted">
          Snapshots the database (consistent, safe against a live database)
          and <code>.env</code> to <code>backups/</code> on the server —
          the same thing <code>scripts/update.sh</code> already does before
          every update. This only protects you if the backup also leaves
          the host; see docs/deployment.md.
        </p>
        <div id="backupResult"></div>
      </div>

      <div class="card">
        <h3>Queue</h3>
        <p>Active build: ${status.activeBuild ? statusBadge("building") : `<span class="muted">none</span>`}
           · Queued: ${status.queuedBuilds} · Total builds across every account: ${status.totalBuildsAllUsers}</p>
        <table>
          <thead><tr><th>Status</th><th>Count</th></tr></thead>
          <tbody>${statusRows}</tbody>
        </table>
        <p class="muted">Your average build duration: ${metrics.averageDurationMs ? `${(metrics.averageDurationMs / 1000).toFixed(1)}s` : "—"} (${metrics.durationSampleCount} sample(s))</p>
      </div>

      <div class="card">
        <div class="spaced">
          <h3>API log (last 100 lines)</h3>
          <button id="refreshLogsBtn">Refresh</button>
        </div>
        <pre class="logs">${escapeHtml(logLines || "(no log entries yet)")}</pre>
      </div>
    `;

    document.getElementById("refreshLogsBtn").addEventListener("click", renderOverviewTab);

    document.getElementById("backupBtn").addEventListener("click", async (event) => {
      const btn = event.currentTarget;
      const resultEl = document.getElementById("backupResult");

      btn.disabled = true;
      resultEl.innerHTML = "";

      try {
        const result = await api.triggerBackup();
        resultEl.innerHTML = `<p class="muted">Backup written: ${escapeHtml(result.archivePath)}</p>`;
      } catch (error) {
        resultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("updateBtn").addEventListener("click", async () => {
      const targetRef = document.getElementById("targetRef").value.trim();
      const confirmed = window.confirm(
        targetRef
          ? `Trigger a real update to ${targetRef}? This redeploys the live service.`
          : "Trigger a real update to the latest commit? This redeploys the live service.",
      );

      if (!confirmed) return;

      try {
        const result = await api.triggerUpdate(targetRef || undefined);
        errorEl.innerHTML = `<div class="card">Update triggered (${escapeHtml(result.targetRef)}). The service will restart shortly — this page may briefly lose connection.</div>`;
      } catch (error) {
        errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    });
  } catch (error) {
    bodyEl.innerHTML = "";
    showError(error.message);
  }
}

async function renderUsersTab() {
  const bodyEl = document.getElementById("adminBody");

  async function load() {
    try {
      const { users } = await api.listUsers();

      bodyEl.innerHTML = `
        <div class="card">
          <table>
            <thead><tr><th>Username</th><th>Role</th><th>2FA</th><th>Status</th><th>Last login</th><th></th></tr></thead>
            <tbody>
              ${users.map((u) => `
                <tr>
                  <td>${escapeHtml(u.username)}</td>
                  <td>${escapeHtml(u.role)}</td>
                  <td class="muted">${u.totpEnabled ? "enrolled" : "not enrolled"}</td>
                  <td>${u.enabled ? "enabled" : "disabled"}</td>
                  <td class="muted">${u.lastLoginAt ? escapeHtml(new Date(u.lastLoginAt).toLocaleString()) : "never"}</td>
                  <td>
                    <button data-toggle-role="${u.id}" data-current-role="${u.role}">${u.role === "admin" ? "Demote" : "Promote"}</button>
                    <button data-toggle-enabled="${u.id}" data-currently-enabled="${u.enabled}">${u.enabled ? "Disable" : "Enable"}</button>
                    <button data-reset-password="${u.id}">Reset password</button>
                    <button data-reset-2fa="${u.id}">Reset 2FA</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;

      bodyEl.querySelectorAll("[data-toggle-role]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const newRole = btn.dataset.currentRole === "admin" ? "user" : "admin";
          try {
            await api.updateUser(btn.dataset.toggleRole, { role: newRole });
            await load();
          } catch (error) {
            showError(error.message);
          }
        });
      });

      bodyEl.querySelectorAll("[data-toggle-enabled]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const newEnabled = btn.dataset.currentlyEnabled !== "true";
          try {
            await api.updateUser(btn.dataset.toggleEnabled, { enabled: newEnabled });
            await load();
          } catch (error) {
            showError(error.message);
          }
        });
      });

      bodyEl.querySelectorAll("[data-reset-password]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const { link } = await api.resetUserPassword(btn.dataset.resetPassword);
            window.prompt("Password reset link (copy and send to the user):", link ?? "(no WEB_UI_ORIGIN configured — build the link manually)");
          } catch (error) {
            showError(error.message);
          }
        });
      });

      bodyEl.querySelectorAll("[data-reset-2fa]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!window.confirm("Reset this user's two-factor enrollment? They'll need to re-enroll on next login.")) return;
          try {
            await api.resetUserTotp(btn.dataset.reset2fa);
            await load();
          } catch (error) {
            showError(error.message);
          }
        });
      });
    } catch (error) {
      showError(error.message);
    }
  }

  await load();
}

async function renderInvitesTab() {
  const bodyEl = document.getElementById("adminBody");

  bodyEl.innerHTML = `
    <div class="card">
      <h3>Invite someone</h3>
      <div class="row">
        <select id="inviteRole">
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <input id="inviteUsername" placeholder="Suggested username (optional)" />
        <button class="primary" id="createInviteBtn">Create invite</button>
      </div>
      <div id="inviteResult"></div>
    </div>
    <div class="card">
      <h3>Pending &amp; past invites</h3>
      <div id="invitesList">Loading…</div>
    </div>
  `;

  async function loadList() {
    const { invites } = await api.listAdminInvites();
    const listEl = document.getElementById("invitesList");
    if (!listEl) return;

    listEl.innerHTML = invites.length === 0
      ? `<p class="muted">No invites yet.</p>`
      : `<table>
          <thead><tr><th>Purpose</th><th>Role</th><th>Username</th><th>Status</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            ${invites.map((i) => {
              const status = i.usedAt ? "used" : (new Date(i.expiresAt) < new Date() ? "expired" : "pending");
              return `
                <tr>
                  <td>${escapeHtml(i.purpose)}</td>
                  <td class="muted">${escapeHtml(i.role ?? "—")}</td>
                  <td class="muted">${escapeHtml(i.suggestedUsername ?? "—")}</td>
                  <td>${status}</td>
                  <td class="muted">${escapeHtml(new Date(i.expiresAt).toLocaleString())}</td>
                  <td>${status === "pending" ? `<button data-revoke-invite="${i.id}">Revoke</button>` : ""}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>`;

    listEl.querySelectorAll("[data-revoke-invite]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.revokeAdminInvite(btn.dataset.revokeInvite);
          await loadList();
        } catch (error) {
          showError(error.message);
        }
      });
    });
  }

  document.getElementById("createInviteBtn").addEventListener("click", async () => {
    const resultEl = document.getElementById("inviteResult");
    resultEl.innerHTML = "";

    try {
      const { link } = await api.createAdminInvite({
        role: document.getElementById("inviteRole").value,
        suggestedUsername: document.getElementById("inviteUsername").value.trim() || undefined,
      });

      resultEl.innerHTML = link
        ? `<p class="muted">Invite link (copy and send it): <code>${escapeHtml(link)}</code></p>`
        : `<p class="muted">Invite created, but no WEB_UI_ORIGIN is configured to build a link — check the invite token via the API directly.</p>`;

      await loadList();
    } catch (error) {
      resultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });

  await loadList();
}

async function renderSignupRequestsTab() {
  const bodyEl = document.getElementById("adminBody");

  async function load() {
    try {
      const { signupRequests } = await api.listSignupRequests();
      const pending = signupRequests.filter((r) => r.status === "pending");
      const decided = signupRequests.filter((r) => r.status !== "pending");

      bodyEl.innerHTML = `
        <div class="card">
          <h3>Pending requests</h3>
          ${pending.length === 0 ? `<p class="muted">Nothing pending.</p>` : `
            <table>
              <thead><tr><th>Username</th><th>Email</th><th>Message</th><th>Requested</th><th></th></tr></thead>
              <tbody>
                ${pending.map((r) => `
                  <tr>
                    <td>${escapeHtml(r.requestedUsername)}</td>
                    <td class="muted">${escapeHtml(r.email ?? "—")}</td>
                    <td class="muted">${escapeHtml(r.message ?? "—")}</td>
                    <td class="muted">${escapeHtml(new Date(r.createdAt).toLocaleString())}</td>
                    <td>
                      <select data-approve-role="${r.id}">
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                      <button data-approve="${r.id}">Approve</button>
                      <button data-reject="${r.id}">Reject</button>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>
        <div class="card">
          <h3>Decided</h3>
          ${decided.length === 0 ? `<p class="muted">None yet.</p>` : `
            <table>
              <thead><tr><th>Username</th><th>Status</th><th>Decided</th></tr></thead>
              <tbody>
                ${decided.map((r) => `
                  <tr><td>${escapeHtml(r.requestedUsername)}</td><td>${escapeHtml(r.status)}</td>
                  <td class="muted">${r.decidedAt ? escapeHtml(new Date(r.decidedAt).toLocaleString()) : "—"}</td></tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>
      `;

      bodyEl.querySelectorAll("[data-approve]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const role = bodyEl.querySelector(`[data-approve-role="${btn.dataset.approve}"]`).value;
          try {
            const { link } = await api.approveSignupRequest(btn.dataset.approve, role);
            window.prompt("Invite link (copy and send to the requester):", link ?? "(no WEB_UI_ORIGIN configured)");
            await load();
          } catch (error) {
            showError(error.message);
          }
        });
      });

      bodyEl.querySelectorAll("[data-reject]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await api.rejectSignupRequest(btn.dataset.reject);
            await load();
          } catch (error) {
            showError(error.message);
          }
        });
      });
    } catch (error) {
      showError(error.message);
    }
  }

  await load();
}

async function renderBroadcastTab() {
  const bodyEl = document.getElementById("adminBody");

  bodyEl.innerHTML = `
    <div class="card">
      <h3>Send a notification to everyone</h3>
      <p class="muted">
        The one deliberate exception to per-account isolation — use this
        for things like "restarting the server for an update shortly."
      </p>
      <div class="field">
        <label for="broadcastMessage">Message</label>
        <textarea id="broadcastMessage" rows="3"></textarea>
      </div>
      <button class="primary" id="broadcastBtn">Send to all users</button>
      <div id="broadcastResult"></div>
    </div>
  `;

  document.getElementById("broadcastBtn").addEventListener("click", async () => {
    const resultEl = document.getElementById("broadcastResult");
    resultEl.innerHTML = "";

    try {
      await api.sendBroadcast(document.getElementById("broadcastMessage").value.trim());
      document.getElementById("broadcastMessage").value = "";
      resultEl.innerHTML = `<p class="muted">Sent.</p>`;
    } catch (error) {
      resultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}
