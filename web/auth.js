// Account lifecycle screens: sign-in (+ TOTP), invite-based signup (+
// enrollment), password reset, requesting access, and the signed-in
// profile page. Split out of app.js to keep any one file from
// ballooning — same plain-ES-modules, no-bundler approach as every
// other file in web/.

import { api, getCurrentUser, setSession } from "./api.js";
import { escapeHtml, layout, renderRoute } from "./app.js";

const root = document.getElementById("app");

function standalone(bodyHtml, { maxWidth = 420 } = {}) {
  root.innerHTML = `<main style="max-width: ${maxWidth}px; margin: 60px auto;">${bodyHtml}</main>`;
}

function parseHashQuery(hash) {
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return {};
  return Object.fromEntries(new URLSearchParams(hash.slice(queryIndex + 1)));
}

// Shown exactly once, right after enrollment completes — recovery codes
// are never retrievable again after this. Used by both the invite-signup
// enrollment step and (with different copy) nowhere else yet, since
// profile-triggered regeneration has its own inline display in
// renderProfile.
function renderRecoveryCodesStep(codes, onContinue) {
  standalone(`
    <div class="card">
      <h2>Save your recovery codes</h2>
      <p class="muted">
        Each code works once, as a substitute for a TOTP code if you ever
        lose access to your authenticator app. They're shown only this
        one time — save them somewhere real (a password manager) before
        continuing.
      </p>
      <pre class="logs">${codes.map(escapeHtml).join("\n")}</pre>
      <button class="primary" id="continueBtn">I've saved these — continue</button>
    </div>
  `, { maxWidth: 480 });

  document.getElementById("continueBtn").addEventListener("click", onContinue);
}

function renderEnrollmentStep(enrollmentToken, { title, onEnrolled }) {
  standalone(`<p class="muted">Preparing two-factor setup…</p>`);

  api.enrollStart(enrollmentToken).then(({ secret, qrCodeDataUrl }) => {
    standalone(`
      <div class="card">
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">
          Scan this with an authenticator app (Google Authenticator, Authy,
          1Password, etc.), or enter the code manually if you can't scan.
          Two-factor authentication is required for every account here —
          there's no way to skip this step.
        </p>
        <p style="text-align:center;"><img src="${qrCodeDataUrl}" alt="TOTP QR code" width="200" height="200" /></p>
        <p class="muted" style="text-align:center; word-break: break-all;">
          Manual entry code: <code>${escapeHtml(secret)}</code>
        </p>
        <div id="enrollError"></div>
        <div class="field">
          <label for="enrollCode">6-digit code from your app</label>
          <input id="enrollCode" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
        </div>
        <button class="primary" id="enrollConfirmBtn">Confirm</button>
      </div>
    `, { maxWidth: 480 });

    document.getElementById("enrollConfirmBtn").addEventListener("click", async () => {
      const code = document.getElementById("enrollCode").value.trim();
      const errorEl = document.getElementById("enrollError");
      errorEl.innerHTML = "";

      try {
        const result = await api.enrollConfirm(enrollmentToken, code);
        onEnrolled(result);
      } catch (error) {
        errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    });
  }).catch((error) => {
    standalone(`<div class="error">${escapeHtml(error.message)}</div>`);
  });
}

function finishSignIn(result) {
  setSession(result.user, result.csrfToken);
  renderRecoveryCodesStepIfAny(result, () => {
    window.location.hash = "#/";
    renderRoute();
  });
}

function renderRecoveryCodesStepIfAny(result, onContinue) {
  if (result.recoveryCodes) {
    renderRecoveryCodesStep(result.recoveryCodes, onContinue);
  } else {
    onContinue();
  }
}

export function renderSignIn() {
  standalone(`
    <div class="card">
      <h2>Sign in</h2>
      <div id="signInError"></div>
      <div class="field">
        <label for="username">Username</label>
        <input id="username" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" />
      </div>
      <button class="primary" id="signInBtn">Sign in</button>
      <p class="muted" style="margin-top: 12px;">
        <a class="row-link" href="#/request-access">Need an account?</a>
        · <a class="row-link" href="#/help">Need help?</a>
      </p>
    </div>
  `);

  async function submitPassword() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const errorEl = document.getElementById("signInError");
    errorEl.innerHTML = "";

    if (!username || !password) {
      errorEl.innerHTML = `<div class="error">Username and password are required.</div>`;
      return;
    }

    try {
      const result = await api.login(username, password);

      if (result.needsEnrollment) {
        renderEnrollmentStep(result.enrollmentToken, {
          title: "Set up two-factor authentication",
          onEnrolled: finishSignIn,
        });
        return;
      }

      renderMfaStep(result.mfaToken);
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById("signInBtn").addEventListener("click", submitPassword);
  document.getElementById("password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPassword();
  });
}

function renderMfaStep(mfaToken) {
  standalone(`
    <div class="card">
      <h2>Two-factor code</h2>
      <p class="muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
      <div id="mfaError"></div>
      <div class="field">
        <label for="mfaCode">Code</label>
        <input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
      </div>
      <button class="primary" id="mfaBtn">Verify</button>
      <p class="muted" style="margin-top: 12px;"><a class="row-link" href="#/signin" id="backToSignIn">&larr; Back to sign in</a></p>
    </div>
  `);

  document.getElementById("backToSignIn").addEventListener("click", (e) => {
    e.preventDefault();
    window.location.hash = "#/signin";
    renderRoute();
  });

  async function submitCode() {
    const code = document.getElementById("mfaCode").value.trim();
    const errorEl = document.getElementById("mfaError");
    errorEl.innerHTML = "";

    try {
      const result = await api.verifyMfa(mfaToken, code);
      finishSignIn(result);
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById("mfaBtn").addEventListener("click", submitCode);
  document.getElementById("mfaCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCode();
  });
}

export async function renderSignup(hash) {
  const { token } = parseHashQuery(hash);

  if (!token) {
    standalone(`<div class="error">Missing invite token.</div>`);
    return;
  }

  standalone(`<p class="muted">Checking your invite…</p>`);

  let invite;

  try {
    invite = await api.getInvite(token);
  } catch (error) {
    standalone(`<div class="error">${escapeHtml(error.message)}</div>`);
    return;
  }

  if (invite.purpose !== "signup") {
    standalone(`<div class="error">This link isn't a signup invite.</div>`);
    return;
  }

  standalone(`
    <div class="card">
      <h2>Create your account</h2>
      <p class="muted">Role: <strong>${escapeHtml(invite.role)}</strong></p>
      <div id="signupError"></div>
      ${invite.suggestedUsername
        ? `<p class="muted">Username: <strong>${escapeHtml(invite.suggestedUsername)}</strong></p>`
        : `<div class="field"><label for="username">Username</label><input id="username" autocomplete="username" /></div>`}
      <div class="field">
        <label for="password">Password (at least 12 characters)</label>
        <input id="password" type="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label for="passwordConfirm">Confirm password</label>
        <input id="passwordConfirm" type="password" autocomplete="new-password" />
      </div>
      <button class="primary" id="signupBtn">Create account</button>
    </div>
  `, { maxWidth: 480 });

  document.getElementById("signupBtn").addEventListener("click", async () => {
    const password = document.getElementById("password").value;
    const passwordConfirm = document.getElementById("passwordConfirm").value;
    const usernameField = document.getElementById("username");
    const errorEl = document.getElementById("signupError");
    errorEl.innerHTML = "";

    if (password !== passwordConfirm) {
      errorEl.innerHTML = `<div class="error">Passwords don't match.</div>`;
      return;
    }

    try {
      const result = await api.completeInvite(token, {
        password,
        ...(usernameField ? { username: usernameField.value.trim() } : {}),
      });

      renderEnrollmentStep(result.enrollmentToken, {
        title: "Set up two-factor authentication",
        onEnrolled: finishSignIn,
      });
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

export async function renderPasswordReset(hash) {
  const { token } = parseHashQuery(hash);

  if (!token) {
    standalone(`<div class="error">Missing reset token.</div>`);
    return;
  }

  standalone(`<p class="muted">Checking your link…</p>`);

  try {
    const invite = await api.getInvite(token);

    if (invite.purpose !== "password_reset") {
      standalone(`<div class="error">This link isn't a password reset.</div>`);
      return;
    }
  } catch (error) {
    standalone(`<div class="error">${escapeHtml(error.message)}</div>`);
    return;
  }

  standalone(`
    <div class="card">
      <h2>Set a new password</h2>
      <div id="resetError"></div>
      <div class="field">
        <label for="password">New password (at least 12 characters)</label>
        <input id="password" type="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label for="passwordConfirm">Confirm password</label>
        <input id="passwordConfirm" type="password" autocomplete="new-password" />
      </div>
      <button class="primary" id="resetBtn">Set new password</button>
    </div>
  `);

  document.getElementById("resetBtn").addEventListener("click", async () => {
    const password = document.getElementById("password").value;
    const passwordConfirm = document.getElementById("passwordConfirm").value;
    const errorEl = document.getElementById("resetError");
    errorEl.innerHTML = "";

    if (password !== passwordConfirm) {
      errorEl.innerHTML = `<div class="error">Passwords don't match.</div>`;
      return;
    }

    try {
      await api.completeInvite(token, { password });
      standalone(`
        <div class="card">
          <h2>Password updated</h2>
          <p>You can now <a class="row-link" href="#/signin">sign in</a> with your new password.</p>
        </div>
      `);
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

export async function renderRequestAccess() {
  standalone(`<p class="muted">Loading…</p>`, { maxWidth: 480 });

  let challenge;

  try {
    challenge = await api.getRequestAccessChallenge();
  } catch (error) {
    standalone(`<div class="error">${escapeHtml(error.message)}</div>`);
    return;
  }

  standalone(`
    <div class="card">
      <h2>Request access</h2>
      <p class="muted">
        An admin will review your request and, if approved, send you an
        invite link separately.
      </p>
      <div id="requestError"></div>
      <div class="field">
        <label for="reqUsername">Desired username</label>
        <input id="reqUsername" autocomplete="username" />
      </div>
      <div class="field">
        <label for="reqEmail">Email (optional, so an admin can reach you)</label>
        <input id="reqEmail" type="email" autocomplete="email" />
      </div>
      <div class="field">
        <label for="reqMessage">Message (optional)</label>
        <textarea id="reqMessage" rows="3"></textarea>
      </div>
      <div class="field" style="position: absolute; left: -9999px;" aria-hidden="true">
        <label for="reqWebsite">Leave this field blank</label>
        <input id="reqWebsite" tabindex="-1" autocomplete="off" />
      </div>
      <div class="field">
        <label for="reqAnswer">${escapeHtml(challenge.question)} = ?</label>
        <input id="reqAnswer" inputmode="numeric" />
      </div>
      <button class="primary" id="requestBtn">Submit request</button>
      <p class="muted" style="margin-top: 12px;"><a class="row-link" href="#/signin">&larr; Back to sign in</a></p>
    </div>
  `, { maxWidth: 480 });

  document.getElementById("requestBtn").addEventListener("click", async () => {
    const errorEl = document.getElementById("requestError");
    errorEl.innerHTML = "";

    try {
      const result = await api.submitRequestAccess({
        username: document.getElementById("reqUsername").value.trim(),
        email: document.getElementById("reqEmail").value.trim(),
        message: document.getElementById("reqMessage").value.trim(),
        honeypot: document.getElementById("reqWebsite").value,
        challengeId: challenge.challengeId,
        answer: document.getElementById("reqAnswer").value,
      });

      standalone(`<div class="card"><p>${escapeHtml(result.message)}</p></div>`, { maxWidth: 480 });
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

export async function renderProfile() {
  layout("#/profile", `
    <h2>Profile</h2>
    <div class="card">
      <p><strong>${escapeHtml(getCurrentUser()?.username ?? "")}</strong> · ${escapeHtml(getCurrentUser()?.role ?? "")}</p>
    </div>

    <div class="card">
      <h3>Change password</h3>
      <div id="pwError"></div>
      <div class="field">
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" type="password" autocomplete="current-password" />
      </div>
      <div class="field">
        <label for="newPassword">New password (at least 12 characters)</label>
        <input id="newPassword" type="password" autocomplete="new-password" />
      </div>
      <button class="primary" id="pwBtn">Change password</button>
    </div>

    <div class="card">
      <h3>Two-factor authentication</h3>
      <p class="muted">Enrolled and required for every sign-in. Lost your authenticator? Ask an admin to reset it.</p>
      <p class="muted">Regenerating recovery codes invalidates any codes issued before.</p>
      <div id="recoveryError"></div>
      <div class="field">
        <label for="recoveryPassword">Current password</label>
        <input id="recoveryPassword" type="password" autocomplete="current-password" />
      </div>
      <button id="recoveryBtn">Regenerate recovery codes</button>
      <div id="recoveryResult"></div>
    </div>

    <div class="card">
      <div class="spaced">
        <h3>My API keys</h3>
        <button id="newKeyBtn">Create new key</button>
      </div>
      <p class="muted">Scoped to your own builds only — never anyone else's, and never system/admin actions.</p>
      <div id="keysError"></div>
      <div id="newKeyResult"></div>
      <label class="row" style="margin-bottom: 12px;">
        <input type="checkbox" id="showArchivedKeys" style="width: auto;" />
        Show revoked keys
      </label>
      <div id="keysBody">Loading…</div>
    </div>
  `);

  document.getElementById("pwBtn").addEventListener("click", async () => {
    const errorEl = document.getElementById("pwError");
    errorEl.innerHTML = "";

    try {
      await api.changePassword(
        document.getElementById("currentPassword").value,
        document.getElementById("newPassword").value,
      );
      document.getElementById("currentPassword").value = "";
      document.getElementById("newPassword").value = "";
      errorEl.innerHTML = `<p class="muted">Password changed.</p>`;
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });

  document.getElementById("recoveryBtn").addEventListener("click", async () => {
    const errorEl = document.getElementById("recoveryError");
    const resultEl = document.getElementById("recoveryResult");
    errorEl.innerHTML = "";
    resultEl.innerHTML = "";

    try {
      const { recoveryCodes } = await api.regenerateRecoveryCodes(document.getElementById("recoveryPassword").value);
      document.getElementById("recoveryPassword").value = "";
      resultEl.innerHTML = `
        <p class="muted">New codes (shown once — save them now):</p>
        <pre class="logs">${recoveryCodes.map(escapeHtml).join("\n")}</pre>
      `;
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });

  let loadedKeys = [];

  function renderKeysTable() {
    const bodyEl = document.getElementById("keysBody");
    if (!bodyEl) return;

    const showArchived = document.getElementById("showArchivedKeys")?.checked ?? false;
    const visibleKeys = showArchived ? loadedKeys : loadedKeys.filter((k) => k.enabled);
    const archivedCount = loadedKeys.length - loadedKeys.filter((k) => k.enabled).length;

    if (visibleKeys.length === 0) {
      bodyEl.innerHTML = loadedKeys.length === 0
        ? `<p class="muted">No API keys yet.</p>`
        : `<p class="muted">No active keys. ${archivedCount} revoked key(s) hidden — check "Show revoked keys" above.</p>`;
      return;
    }

    bodyEl.innerHTML = `<table>
        <thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${visibleKeys.map((k) => `
            <tr>
              <td>${escapeHtml(k.name)}</td>
              <td class="muted">${k.scopes ? escapeHtml(k.scopes.join(", ")) : "full access"}</td>
              <td class="muted">${escapeHtml(new Date(k.createdAt).toLocaleDateString())}</td>
              <td>${k.enabled ? "active" : "revoked"}</td>
              <td>${k.enabled
                ? `<button data-revoke="${k.id}">Revoke</button>`
                : `<button class="danger" data-delete="${k.id}">Delete</button>`}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>`;

    bodyEl.querySelectorAll("[data-revoke]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("Revoke this API key? Anything using it will stop working immediately.")) return;
        try {
          await api.revokeMyApiKey(btn.dataset.revoke);
          await loadKeys();
        } catch (error) {
          document.getElementById("keysError").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
        }
      });
    });

    bodyEl.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("Permanently delete this revoked key? This can't be undone.")) return;
        try {
          await api.deleteMyApiKey(btn.dataset.delete);
          await loadKeys();
        } catch (error) {
          document.getElementById("keysError").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
        }
      });
    });
  }

  async function loadKeys() {
    try {
      const { apiKeys } = await api.listMyApiKeys();
      loadedKeys = apiKeys;
      renderKeysTable();
    } catch (error) {
      const errorEl = document.getElementById("keysError");
      if (errorEl) errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById("showArchivedKeys").addEventListener("change", renderKeysTable);

  document.getElementById("newKeyBtn").addEventListener("click", async () => {
    const name = window.prompt("Name for this key (e.g. \"my-laptop-ci\"):");
    if (!name) return;

    const errorEl = document.getElementById("keysError");
    errorEl.innerHTML = "";

    try {
      const result = await api.createMyApiKey(name);

      // A native alert()/prompt() can't be selected/copied in most
      // browsers — shown inline instead, same pattern as recovery codes.
      document.getElementById("newKeyResult").innerHTML = `
        <div class="card">
          <p class="muted">Save this key now — it won't be shown again:</p>
          <pre class="logs">${escapeHtml(result.key)}</pre>
          <button id="copyNewKeyBtn">Copy to clipboard</button>
          <span id="copyNewKeyStatus" class="muted"></span>
        </div>
      `;

      document.getElementById("copyNewKeyBtn").addEventListener("click", async () => {
        const statusEl = document.getElementById("copyNewKeyStatus");

        try {
          await navigator.clipboard.writeText(result.key);
          statusEl.textContent = "Copied.";
        } catch {
          statusEl.textContent = "Couldn't copy automatically — select the text above and copy it manually.";
        }
      });

      await loadKeys();
    } catch (error) {
      errorEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });

  await loadKeys();
}
