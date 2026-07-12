"use strict";

const crypto = require("node:crypto");

const pending = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when AGENTBAR_AUTH_PROVIDER=oidc`);
  return value;
}

function verifier() {
  return crypto.randomBytes(48).toString("base64url");
}

function challenge(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

async function discovery() {
  const issuer = required("AGENTBAR_OIDC_ISSUER").replace(/\/$/, "");
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("OIDC discovery failed");
  return response.json();
}

async function begin(redirectUri) {
  const metadata = await discovery();
  const state = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = verifier();
  pending.set(state, { codeVerifier, metadata, expiresAt: Date.now() + 10 * 60 * 1000 });
  const parameters = new URLSearchParams({
    client_id: required("AGENTBAR_OIDC_CLIENT_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: process.env.AGENTBAR_OIDC_SCOPE || "openid profile email",
    state,
    code_challenge: challenge(codeVerifier),
    code_challenge_method: "S256"
  });
  return `${metadata.authorization_endpoint}?${parameters}`;
}

async function finish({ state, code, redirectUri }) {
  const flow = pending.get(state);
  pending.delete(state);
  if (!flow || flow.expiresAt < Date.now()) throw new Error("OIDC state expired");
  const parameters = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: required("AGENTBAR_OIDC_CLIENT_ID"),
    code_verifier: flow.codeVerifier
  });
  const secret = process.env.AGENTBAR_OIDC_CLIENT_SECRET;
  if (secret) parameters.set("client_secret", secret);
  const tokenResponse = await fetch(flow.metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) throw new Error("OIDC token exchange failed");
  const profileResponse = await fetch(flow.metadata.userinfo_endpoint, {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  const profile = await profileResponse.json();
  if (!profileResponse.ok || !profile.sub) throw new Error("OIDC userinfo request failed");
  return {
    id: `${required("AGENTBAR_OIDC_ISSUER")}#${profile.sub}`,
    name: String(profile.name || profile.preferred_username || profile.email || "Player").slice(0, 32),
    email: String(profile.email || "").slice(0, 160),
    image: String(profile.picture || "").slice(0, 500)
  };
}

module.exports = { begin, finish };
