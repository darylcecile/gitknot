# Recovery

Recovery combines D1 authority, native Git/ref backups, private R2 object bytes/manifests, and the protected vault key set. Search/feed projections are rebuilt. A D1 restore alone is not a repository restore, and a queue drain is not evidence that every source event was delivered.

## Backups and receipts

### Repository archive

```sh
npm run backup -- --repo r_fixture
npm run backup -- --repo r_fixture --execute --wait --download .gitknot/backups/r_fixture.gitknot.tar
```

The first command prints a plan. `--execute` uses `GITKNOT_OPERATOR_TOKEN` against the selected `--base-url`, starts the real `/v1/repos/:id/backups` operation, and records its idempotency key before submission. A completed operation must return an archive ID. Download verification checks USTAR headers and every declared part's SHA-256/size, then uses native `git bundle verify`, imports into a fresh temporary bare repository, runs `git fsck --full --strict`, and compares the complete ref inventory. The independently retained receipt records the portable tar's hash; the API's private-manifest ETag is a different digest.

```sh
npm run restore -- --verify-file .gitknot/backups/r_fixture.gitknot.tar --sha256 <receipt-sha256>
```

This is an entirely local verification. It does not extract arbitrary tar paths into the filesystem, run repository code/hooks, change GitKnot state, or contact Cloudflare. Preserve the receipt in a separately controlled location so recomputing a corrupted archive's manifest cannot replace provenance.

### Authoritative D1 snapshots

```sh
npm run backup -- --database all --mode production
npm run backup -- --database all --mode production --execute --upload --out /private/backup-run
```

This exports owned core shards and the directory when this cell owns it, excludes `SEARCH_DB`, records actual D1 consistency bookmarks, downloads full SQL, and hashes it. Shared identity/directory references are backed up through their owning cells. The current cf beta has no generated D1 import/export command, so `infra/recovery/d1.ts` uses the official polling REST endpoints for those two operations. Other resource work uses cf. Tokens are supplied explicitly through operator environment variables; none of these operations run during setup/build/CI.

Native D1 export blocks queries and must be polled continuously. Schedule it in a measured maintenance envelope, not at an assumed zero-impact frequency. SQL snapshots contain private identity/credential/ciphertext records and are not ordinary customer exports. `--upload` writes 64 MiB chunks through cf to `BACKUPS` under `scheduled/<date>/<snapshot-id>/`, below the cf R2 endpoint's 300 MB request maximum; the final manifest is committed after all chunks. The backup policy retains those keys for 35 days and locks them for 30 days. Use a separately controlled `GITKNOT_<MODE>_BACKUP_API_TOKEN` for backup-bucket access.

Set backup cadence from measured export/restore duration and the product RPO. Repository archive operations use fenced, verified snapshots; the whole-cell D1 bookmark must be reconciled with the chosen repository/R2 recovery points. Keep both receipts and operation journals for that reconciliation. Repository archives under `archives/` have application-managed references/retention; scheduled SQL backup bucket locks protect the separate `scheduled/` prefix.

## Restore into a fresh cell

1. Stop new paid work in the affected slice, preserve publication fences, and record active runtimes/reservations. Keep revocation and cleanup reachable. Choose an actual verified recovery point and protect the original copies.
2. Plan a **new cell and new execution-cell name**, with a new directory partition if replacing the directory. Select the current `IDENTITY_CELL_ID`; restore identity authority into a fresh identity home only when that authority itself is being recovered. `GITKNOT_<MODE>_RECOVERY_MODE=true` builds private API/Git Workers, disables automatic background triggers, and pauses new execution. The remote hosted cleanup endpoint/reaper remains reachable for already issued grants. Only `INGRESS_CELL_ID` ordinarily attaches product domains. Do not reuse an existing target database or overwrite the source account's resources.
3. Resolve/provision that cell separately. Native D1 SQL import needs a fresh, unmigrated D1 database. Keep source and destination state files separate and check every account/database ID.
4. Restore authoritative SQL using its retained manifest. If only R2 remains, `--download-to` reconstructs the file from declared parts, verifying every part and the final hash before import:

   ```sh
   npm run restore -- --mode production --database d1.core-001 --snapshot /private/backup-run/core-snapshot.json
   npm run restore -- --mode production --database d1.core-001 --snapshot /private/backup-run/core-snapshot.json --download-to /private/recovery/core.sql --execute
   ```

   The adapter requires recovery mode, rejects the source database or an adopted shared authority as a target, refuses nonempty destinations, verifies the source hash and provider import bookmark, runs integrity/foreign-key checks, and fences restored repositories/routes. Initial single-database credentials can be revoked directly; an enrolled distributed identity authority instead returns `identity_authority_reconciliation_required` and keeps revocation pending until the acknowledged authority protocol is recovered. It never bypasses the new primary triggers or fabricates placement acknowledgements. This import receipt does not open routing or claim cross-store recovery. Files above the provider's 5 GiB import ceiling require a separately validated split-import process; measure this before setting a shard's growth threshold.

   Import progress is journaled in `.gitknot/recovery/d1/`. A saved bookmark resumes polling the original import. If the ingestion response was lost before a bookmark could be saved, the adapter stops rather than repeating SQL; inspect the actual provider import and pass `--resume-bookmark <actual-bookmark>`. Completed receipts are replayable for the same verified snapshot/target.
5. Recover the separately protected KEK ring into the **private broker only**. Retain old key versions needed to unwrap selected ciphertext. Exercise an authorized canary secret without placing plaintext in a receipt/log/checkpoint. Key backup and ciphertext backup must correspond.
   Restore the mode's original `IDENTITY_KEYS_JSON` to every target API cell, including versions referenced by live, unresolved or restored requests and identity records. Preserve each request's `request_hash`, `fingerprint_version`, and `fingerprint_key_id`; recovery must not re-key a pending operation or reuse an old key ID with new material.
6. Restore repositories into **new native/Artifacts storage names** through the lifecycle publication gate, with the selected archive's full Git bundle, collaboration rows, LFS and other object bytes. Reverify Git object/ref integrity and object hashes; reconcile the D1/journal boundary rather than assuming the latest database row matches an older Git backup.
7. Rebuild search from authoritative rows, invalidate stale grants/runner enrollments/job credentials, reconcile surviving runtime holds against actual teardown, and replay source events idempotently. Reconcile mail/webhook authorization before delivery.
   Restore the identity home's monotonic authority history and recover every enrolled placement through the acknowledged fence protocol in [routing](routing.md) before access-changing transactions or reopening. Repository snapshots must exclude `account_authority_*` and `resource_locators`; source copies of those tables are not destination authority. A lost acknowledgement keeps the relevant authority closed.
8. Advance the routing epoch only through the fenced move/recovery operation after all verification receipts exist. Prove old-epoch writes fail. Open ingress/admission in a later reviewed configuration only when these checks and a restore drill pass.

To request the implemented retained-repository restore operation after authority/key recovery:

```sh
npm run restore -- --repo r_fixture --archive-id archive_op_fixture --revision 12
npm run restore -- --repo r_fixture --archive-id archive_op_fixture --revision 12 --execute --wait
```

Supply the current strong revision and correct API origin. The request passes `{archive_id}` to `/v1/repos/:id/restore`; actual fencing, native restore verification, catalog changes and credential revocation belong to `OperationWorkflow`. The CLI never edits canonical refs or turns an HTTP 202 into a completed restore.

## Shard/cell movement and route epochs

Configure bounded peer cells through `GITKNOT_<MODE>_PEERS_FILE`, for example `[{"cell_id":"cell-002"}]`. The config supplies both `CELL_BINDINGS_JSON` and `CELL_BACKGROUND_BINDINGS_JSON`. Same-account metadata cells share the deliberately selected `DIRECTORY_CELL_ID` and current `IDENTITY_DB`; staging/production never share their resource names. The destination reads current membership/policy from the identity home rather than using copied identity tables to authorize work. Shared authority references are adoption-only; a metadata-cell plan cannot create an empty substitute identity primary.

```sh
npm run restore -- --move --repo r_fixture --target-cell cell-002 --target-shard core-001 --expected-epoch 3
npm run restore -- --move --repo r_fixture --target-cell cell-002 --target-shard core-001 --expected-epoch 3 --execute --wait
```

The local command reaches the private background service through the signed loopback router. For remote maintenance, supply an actual authenticated operator gateway with `--background-origin` and `GITKNOT_INTERNAL_SERVICE_KEY`, or import Worker-safe `requestShardMove(BACKGROUND, key, input)` from `infra/recovery/service.ts` in an operator Worker. The CLI checks the current source route, starts the implemented durable move, and verifies destination cell/shard, active state, cleared operation owner, and **exactly one** epoch increment after completion. Monitoring also requires an authorized product token; provider directory inspection requires the explicit operator provider token.

The durable move copies and hashes rows, copies object bytes, fences writes for the final snapshot, restores/verifies Git in a cross-cell destination, and performs an expected-epoch directory CAS. The original copy is retained for 30 days. Do not manually decrement an epoch to roll back: move again with a new epoch after reconciliation.

Before moving request records, the destination must have `091_request_fingerprints.sql` and its API must receive the same retained identity key map as the source. Copy the fingerprint version, key ID and hash verbatim with the request, including pending requests that have no completed event receipt. Retain those keys for any source snapshot or backup that can still be restored.

For a lost submission response, inspect the saved `submitting` receipt and the authoritative operation list. The private move endpoint currently generates its own operation ID; do not blindly replay an uncertain POST. Resume monitoring with `--operation-id` after identifying the original operation. A lost publisher/ref acceptance similarly leaves the repository fence intact until canonical marker/refs establish the outcome.

## Recovery proof and objectives

Keep an evidence record containing source/D1 bookmarks, archive/part/tar hashes, image/SDK/config revisions, source/destination IDs and epochs, verification receipts, credential/key-recovery results, replay/cleanup outcomes, and all start/end timestamps. Compute RPO from the actual recovered point and RTO from a successful complete drill. Test interruption before/during/after publication, import, epoch switch, and runtime destruction. Separate cells/accounts reduce blast radius; Cloudflare remains a shared provider failure domain.

References: [D1 export/import behavior](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [R2 object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [Git publication contract](git.md), [vault key recovery](secrets.md), [durable lifecycle](lifecycle.md).
