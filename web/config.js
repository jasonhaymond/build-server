// Edit this once per deployment to point at your API's public origin
// (scheme + host, no trailing slash — see docs/caddy-setup.md), e.g.
// "https://builds-api.example.com". Leave empty for a same-origin
// deployment (the web UI and API served from the same host/port).
//
// This used to be something each person typed in at sign-in alongside
// their API key. It isn't anymore: real accounts sign in with just a
// username/password/TOTP code, and the API's location is a deployment
// fact, not a personal credential — set it here once, for everyone.
export const API_BASE_URL = "";
