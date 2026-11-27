// ArcGIS Online OAuth 2.0 sign-in with PKCE, no SDK, token kept in sessionStorage only.
(function () {
  "use strict";
  const KEY = "migrator.session";
  const cfg = () => window.MIGRATOR_CONFIG || {};
  const redirectUri = () => location.origin + location.pathname;

  function b64url(bytes) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function store(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function load(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

  async function signIn() {
    const c = cfg();
    if (!c.clientId) throw new Error("חסר clientId בקובץ config.js");
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    store("migrator.pkce", JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({ client_id: c.clientId, response_type: "code", redirect_uri: redirectUri(), code_challenge: challenge, code_challenge_method: "S256", state, expiration: "120" });
    location.href = `${c.portal}/sharing/rest/oauth2/authorize?${q}`;
  }

  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.get("code")) return null;
    const saved = JSON.parse(load("migrator.pkce") || "{}");
    history.replaceState(null, "", redirectUri());
    if (!saved.verifier || saved.state !== p.get("state")) throw new Error("תהליך ההתחברות לא תקין, נסה שוב");
    const c = cfg();
    const body = new URLSearchParams({ client_id: c.clientId, grant_type: "authorization_code", code: p.get("code"), redirect_uri: redirectUri(), code_verifier: saved.verifier, f: "json" });
    const r = await fetch(`${c.portal}/sharing/rest/oauth2/token`, { method: "POST", body });
    const j = await r.json();
    if (j.error) throw new Error(j.error_description || j.error.message || "token error");
    store("migrator.pkce", null);
    const self = await fetch(`${c.portal}/sharing/rest/community/self?f=json&token=${encodeURIComponent(j.access_token)}`).then((x) => x.json());
    const s = { portal: c.portal, token: j.access_token, username: j.username || self.username, fullName: self.fullName, expires: Date.now() + (j.expires_in || 1800) * 1000 };
    store(KEY, JSON.stringify(s));
    return s;
  }

  function current() {
    const s = JSON.parse(load(KEY) || "null");
    return s && s.expires > Date.now() + 60000 ? s : null;
  }
  function signOut() { store(KEY, null); }

  window.Auth = { signIn, handleRedirect, current, signOut };
})();
