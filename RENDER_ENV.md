# Render Web Service Environment Requirements

Set these in Render → Environment Variables (copy/paste values exactly, or rotate as you wish):

- `NODE_ENV` = `production`
- `SESSION_SECRET` = `b8f1e2c6a3d94f1b8c9a7e4d2f0c6b3a`
- `USER_PASSKEY` = `user-pass-123`
- `ADMIN_PASSKEY` = `admin-pass-456`
- `DATABASE_URL` = `postgres://paper_user:paper_pass_789@your-render-host:5432/paper_trading`
- (Optional) `NEXT_TELEMETRY_DISABLED` = `1`

Build/Start commands on Render:
- Build: `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
- Start: `npm run start -- -p $PORT`

If a prior deploy attempt left Prisma in a failed migration state (`P3009`), run this once in a Render shell (same `DATABASE_URL`):

- `npx prisma migrate resolve --rolled-back 20260205160000_full_upgrade`
