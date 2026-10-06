# Integrations and delivery

Integrations use the same current-state role, grant, credential-scope, and organization-policy authorization as API clients. Installations and webhook subscriptions are repository/account scoped and explicitly revocable. Every outbound delivery rechecks current access before releasing a payload.

Principals, credential ancestry, installations and account policy are read from `identityBinding(env)`. A retained source delivery is only a location hint: claims and delivery effects resolve the current repository placement. Dedicated delivery queues carry `{delivery_id,cell_id,shard_id}`.

## Required private boundaries

- `SECRETS` owns webhook secret encryption and signing. The operations plane needs create/rotate and sign functionality; keys are never decrypted in the API/background worker. Standard Webhooks HMAC keys are 32 random bytes, presented once as `whsec_` plus base64. The sign operation returns `webhook-signature` over the exact `event_id.timestamp.body`, including a bounded retiring-key overlap.
  Current client contract: `POST /internal/webhooks/keys` scope `webhooks.manage`, input `{webhook_id,key_id,principal,overlap_seconds}` → `{key_id,secret_ref,secret}`; `POST /internal/webhooks/sign` scope `webhooks.sign`, input `{delivery_id,event_id,timestamp,body}` → `{signature}`. The broker reads persisted `webhooks`, `webhook_keys` (only key references), `webhook_deliveries` and current policy before signing. API activation is a separate If-Match edit after key creation. Signing uses the broker-specific client ID/key, never the general internal key.
  Issuance uses external, sensitive request recovery. `webhook_key_operations` commits one key ID before contacting the broker. Lost-response recovery reads that key's existing issuance metadata and attaches it through the shared guarded mutation contract; it never mints a second key or reconstructs a one-time secret. A configuration/key rotation race during delivery defers the same event/delivery for reload and re-signing. Actual loss of audience, credential or subscription authority cancels delivery.
- `WEBHOOK_EGRESS` is a dedicated private transport. `POST /internal/webhooks/validate` validates HTTPS endpoints; `POST /internal/webhooks/send` accepts the target URL, exact signed body and permitted headers. Its native HTTPS request pins a validated public DNS result and uses the original hostname for SNI/certificate verification. Redirects are never followed. It rejects private, loopback, metadata, special-use and mapped addresses, validates every resolved address, bounds response bytes, and has an absolute timeout.
- Background/internal calls authenticate the caller, method, exact path and body, and freshness. Public actor headers are never authority.

Cloudflare Email Sending is used directly through `EMAIL.send` with sender `notifications@mail.gitknot.com` (identity mail uses `security@mail.gitknot.com`). Recipient addresses, challenge state, invitations, inbox references and authorization are resolved immediately before send. Digest bodies are rebuilt from current authorized resources. Provider acceptance is recorded as acceptance rather than a claim of inbox delivery; provider status events supply later delivery/bounce/complaint state.

Verification, password-recovery, email-change and invitation templates are prepared **inside the API Worker** by `registerInternalMailRoutes(app)` (`apps/api/src/modules/internal-mail.ts`). Its private `app.post('/internal/mail/prepare-identity')` handler requires the exact `mail.prepare-identity` signed internal scope and durable nonce protection. Its request accepts only `{delivery_id,lease_token,shard_id?}`; recipient, template, action ID and token source are read from committed records. A final guarded audit transaction verifies the lease, action/invitation revision, expiry, recipient and current policy before releasing the transient message. It is not registered in OpenAPI. Background calls it over `API` immediately before sending and stores neither the response nor its token-bearing links. Identity master/TOTP keys remain API-only.

## Sources (checked 4 October 2026)

- [Standard Webhooks 1.0](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
- [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Email headers](https://developers.cloudflare.com/email-service/reference/headers/)
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

Replay creation is repository-routed at `/v1/repos/:repoId/events/replay`; the legacy `/v1/events/replay` alias is normalized before fingerprinting and forwarding. Progress uses `/v1/operations/:id/replay`. The replay's source range remains pinned to its captured database and rowid boundary.
