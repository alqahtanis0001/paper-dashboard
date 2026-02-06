# Render Web Service Environment Requirements

Set these in Render → Environment Variables (copy/paste values exactly, or rotate as you wish):

- `NODE_ENV` = `production`
- `SESSION_SECRET` = `b8f1e2c6a3d94f1b8c9a7e4d2f0c6b3a`
- `USER_PASSKEY` = `user-pass-123`
- `ADMIN_PASSKEY` = `admin-pass-456`
- `DATABASE_URL` = Render DB URL (external or internal)
- (Optional) `NEXT_TELEMETRY_DISABLED` = `1`

Recommended for best Render performance and reliability:
- `RENDER_INTERNAL_DATABASE_URL` = Render Internal Database URL

Optional runtime behavior flags:
- `RENDER_USE_EXTERNAL_DATABASE` = `1` (only if you want to force using external URL on Render)
- `SESSION_COOKIE_SECURE` = `true|false` (override cookie security auto-detection)
- `ALLOW_LOCAL_GEO_LOOKUP` = `1` (allow IP geo lookup while developing locally)

Build/Start commands on Render:
- Build: `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
- Start: `npm run start -- -p $PORT`

If a prior deploy attempt left Prisma in a failed migration state (`P3009`), run this once in a Render shell (same `DATABASE_URL`):

- `npx prisma migrate resolve --rolled-back 20260205160000_full_upgrade`

## Runtime Detection (New)

The app now auto-detects local vs Render and adapts:
- Runtime target (`render`, `local`, or `other`)
- Storage profile (internal/external/local postgres)
- Cookie secure mode (secure on Render by default, relaxed locally)
- Render DB URL adaptation:
  - If Render runtime sees an external Render host (`*.region-postgres.render.com`), it rewrites to internal host (`dpg-...`) for runtime queries.
  - It also sets `sslmode` automatically (`disable` for internal host, `require` for external host when needed).

Validate in Admin after login:
- `GET /api/admin/runtime`
- Or use the **Runtime & Storage Profile** panel in `/admin`.
