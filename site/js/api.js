import { config } from "./config.js";

// Hex SHA-256 of a request body. CloudFront signs requests to the Lambda functions (origin access
// control), and Lambda only accepts a signed POST when the client sends the body's hash in
// x-amz-content-sha256.
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const getJson = (path) => fetch(`${config.apiBase}${path}`);

export async function postJson(path, data) {
  const body = JSON.stringify(data);
  return fetch(`${config.apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-amz-content-sha256": await sha256Hex(body) },
    body,
  });
}
