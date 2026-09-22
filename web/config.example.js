// Copy this to web/config.js (gitignored — a per-deployment file, same
// idea as .env) and set API_BASE_URL to your API's public origin
// (scheme + host, no trailing slash — see docs/caddy-setup.md), e.g.
// "https://builds-api.example.com". Leave empty for a same-origin
// deployment (the web UI and API served from the same host/port).
//
// scripts/setup.mjs writes web/config.js for you automatically (reusing
// the PUBLIC_BASE_URL you already give it) when you choose to deploy the
// web UI — this file only matters if you're setting it up by hand.
//
// This used to be something each person typed in at sign-in alongside
// their API key. It isn't anymore: real accounts sign in with just a
// username/password/TOTP code, and the API's location is a deployment
// fact, not a personal credential.
export const API_BASE_URL = "";
