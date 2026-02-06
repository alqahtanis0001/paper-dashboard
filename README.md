This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) with your browser (or VS Code port forwarding) to see the result.

For Render deployment, keep using the existing production start command (`npm run start -- -p $PORT`) so no additional deployment changes are required.

## Runtime Profiles

The app auto-detects where it is running:
- `render`: optimized for Render web service + managed Postgres
- `local`: developer-friendly local profile
- `other`: generic production fallback

Storage behavior is adapted automatically through runtime detection:
- Prisma datasource URL selection and Render host normalization
- Secure cookie defaults (enabled on Render, relaxed locally)
- Geo lookup behavior (Render-first, local opt-in)
- Engine activation only when database is configured

Admin runtime diagnostics:
- `/api/admin/runtime` (requires admin session)
- `/admin` includes a **Runtime & Storage Profile** panel

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
