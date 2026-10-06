import { request } from "./client.ts";
import type { Entity } from "./types.ts";

export async function authenticatePasskey(reauthenticate = false) {
  if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON)
    throw new Error(
      "Passkey sign-in requires a current browser with WebAuthn support.",
    );
  const challenge = await request<Entity>(
    "/v1/auth/passkeys/authentication/options",
    { method: "POST", body: { reauthenticate } },
  );
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(
    challenge.data.options as PublicKeyCredentialRequestOptionsJSON,
  );
  const credential = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey sign-in was cancelled.");
  return request<Entity>("/v1/auth/passkeys/authentication/verify", {
    method: "POST",
    body: { token: challenge.data.token, response: credential.toJSON() },
  });
}
