# Get Cornholed: Infrastructure State

Ops section, prepared 2026-11-23 (America/Denver). Values and secrets are never recorded here, only names and pointers.

## Vercel

- Connector status: connected.
- Team: Austin Gibbs' projects, slug austin-gibbs-projects, team ID team_l4yx5F6WNSfuSRvISRpWYcIb.
- Project: get-cornholed, CREATED and empty, project ID prj_RvYcyvxEDmsO9ezHHapoH12wQuDh.
- Deployments: none yet. Domains: none yet. Environment variables: none yet (verified empty).
- Production address once Wes deploys: get-cornholed.vercel.app.
- Watch item for deploy verification: the new project carries Vercel SSO protection set to all_except_custom_domains by default. Confirm the public spectator link opens without a Vercel login during the live verification pass; if it prompts for one, turn off deployment protection for the project (Settings, Deployment Protection) or attach a custom domain.

## Storage (Upstash Redis): ACTION NEEDED FROM AUSTIN

State: NOT provisioned. The Vercel connector can create Blob stores only; it has no tool that creates a Redis or KV store, and its integration tools are read only. An Upstash integration already exists on the team from other work, with its own database, but there is no connector path to create a new Upstash database or connect one to get-cornholed. This one step has to happen in the Vercel dashboard, signed in as Austin.

Exact steps for Austin:

1. Go to vercel.com and open the team "Austin Gibbs' projects".
2. Open the project "get-cornholed".
3. Click the "Storage" tab in the project menu.
4. Click "Create Database" (if it says "Connect Database" first, choose "Create New").
5. In the Marketplace list, choose "Upstash Redis".
6. Accept the Upstash terms, keep the free plan, name the database get-cornholed-redis, keep the default region, and create it.
7. When asked which project to connect, select "get-cornholed" and the Production environment (add Preview too if offered). Vercel writes the environment variables into the project automatically. No values need to be copied by hand.
8. Tell Maive it is done. The next deployment picks the variables up; no code change is needed.

Environment variable names the app reads (names only):

- KV_REST_API_URL and KV_REST_API_TOKEN: the pair the Upstash integration injects when the database is created through the Vercel Storage tab.
- UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN: accepted as an alternate pair if the database is ever created at upstash.com and connected by hand instead.

## GitHub

- Searched Austin's account (austin-gibbs) for "cornhole" and for "get-cornholed" on 2026-11-23: no matching repository exists yet. Wes has not created one as of this check.
- Recommended repo name when it is created: austin-gibbs/get-cornholed, matching the app name and the Vercel project. This ops pass did not create it, to avoid racing the build.
