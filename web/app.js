import { api, clearApiKey, getApiKey, getBaseUrl, setApiKey, setBaseUrl } from "./api.js";

const root = document.getElementById("app");
let dashboardTimer = null;

function stopDashboardPolling() {
  if (dashboardTimer) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function layout(activeRoute, bodyHtml) {
  const links = [
    ["#/", "Dashboard"],
    ["#/submit", "Submit build"],
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
    <main>${bodyHtml}</main>
  `;

  document.getElementById("signOut").addEventListener("click", () => {
    stopDashboardPolling();
    clearApiKey();
    renderRoute();
  });
}

function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

async function renderSignIn() {
  root.innerHTML = `
    <main style="max-width: 420px; margin: 80px auto;">
      <div class="card">
        <h2>Sign in</h2>
        <p class="muted">
          Paste an API key created with <code>scripts/create-api-key.mjs</code>.
          It's kept only in this tab's session storage — never sent anywhere
          but this server, and cleared when you sign out or close the tab.
        </p>
        <div id="signInError"></div>
        <div class="field">
          <label for="baseUrl">API base URL</label>
          <input id="baseUrl" value="${escapeHtml(getBaseUrl())}" />
        </div>
        <div class="field">
          <label for="apiKey">API key</label>
          <input id="apiKey" type="password" placeholder="abs_..." />
        </div>
        <button class="primary" id="signInBtn">Sign in</button>
      </div>
    </main>
  `;

  document.getElementById("signInBtn").addEventListener("click", async () => {
    const baseUrl = document.getElementById("baseUrl").value.trim();
    const key = document.getElementById("apiKey").value.trim();
    const errorEl = document.getElementById("signInError");
    errorEl.innerHTML = "";

    if (!key) {
      errorEl.innerHTML = `<div class="error">API key is required.</div>`;
      return;
    }

    setBaseUrl(baseUrl || window.location.origin);
    setApiKey(key);

    try {
      await api.listBuilds({ limit: 1 });
      renderRoute();
    } catch (error) {
      clearApiKey();
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
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
      if (error.message.includes("Unauthorized")) renderRoute();
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

function renderRoute() {
  if (!getApiKey()) {
    stopDashboardPolling();
    renderSignIn();
    return;
  }

  const hash = window.location.hash || "#/";
  const buildMatch = hash.match(/^#\/builds\/(.+)$/);

  if (hash === "#/submit") {
    renderSubmit();
  } else if (buildMatch) {
    renderBuildDetail(decodeURIComponent(buildMatch[1]));
  } else {
    renderDashboard();
  }
}

window.addEventListener("hashchange", renderRoute);
renderRoute();
