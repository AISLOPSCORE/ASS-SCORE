import { defineRailway, github, project, service, volume } from "railway/iac";

// Migrated from railway.json (Config as Code) via `railway config migrate`
// on 2026-10-09. Cutover applied 2026-10-10: `railway config apply --yes`
// (plan 0 add / 2 change / 0 destroy → live; re-plan then showed only
// restart-policy drift). railway.json DELETED at cutover (CaC retired; IaC
// is now the single source of truth).
//
// DIFFS from the raw migrate output (each is deliberate; see
// /home/team/shared/railway-iac-2026-10-09.md for the full comparison):
//  1. Service name: migrate emitted "aislopscanner" (the local repo folder
//     name). The production service is named "ass-score" — the config MUST
//     use the real service name so plan/apply target the existing service
//     instead of planning a new one. Verified via `railway service list`:
//     service 9763901d-6c2d-4e03-9af4-780cafba15ba = "ass-score".
//  2. `source: github(...)`: reproduces the live repo linkage
//     (BurnettInc/ASS-SCORE, branch main — verified via `railway config
//     pull --json`).
//  3. `build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" }`:
//     reproduces railway.json's build block exactly (the migrate tool left
//     these as comments because the IaC DSL reference does not document the
//     object form; the SDK type BuildConfig does accept builder
//     "NIXPACKS" | "DOCKERFILE" | "RAILPACK" | ... + dockerfilePath).
//     Applied live at cutover; pull --json confirms builder DOCKERFILE.
//  4. restartPolicyType/restartPolicyMaxRetries: REMOVED at cutover —
//     Railway's service model does NOT persist these (live `railway config
//     pull --json` shows no restartPolicy field in deploy; plan kept asking
//     null → ON_FAILURE/10 forever, apply reported success but the value
//     never stuck). Railway's documented default IS ON_FAILURE/10, so the
//     declared fields changed no behavior — dropping them makes `config
//     plan` converge to 0 to change.
//  5. `volume()` + `volumeMounts`: reproduces the load-bearing
//     ass-score-volume mount at /data (5 GB, sfo) — the SQLite persistence
//     volume. Verified live: RAILWAY_VOLUME_NAME=ass-score-volume,
//     RAILWAY_VOLUME_MOUNT_PATH=/data, sizeMB 5000, region sfo.
//  6. `variables: { managed: false }` (migrate --variables unmanaged):
//     env vars stay owned by the Railway dashboard — this migration does
//     NOT declare or manage variables (DB_PATH=/data/ass-score.db etc. are
//     untouched; they continue to bind to the mounted volume at /data).
export const partial = "aislopscanner";

export default defineRailway(() => {
  const data = volume("ass-score-volume", {
    region: "sfo",
    sizeMB: 5000,
  });

  const assScore = service("ass-score", {
    source: github("BurnettInc/ASS-SCORE", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 100,
    volumeMounts: {
      "/data": data,
    },
  });

  return project("ass-score", {
    variables: { managed: false },
    resources: [assScore, data],
  });
});