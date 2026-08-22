# Deploying SmartRecap without AWS

The original deployment used Amplify for the frontend and EC2 for the backend,
paid for with hackathon credits. This guide replaces both with free hosting you
can keep: **Vercel** for the React frontend, **Render** for the FastAPI backend.

Nothing in the app is being rewritten to make this work. The backend already
falls back to non-AWS paths when its AWS settings are empty, and the OCR
toolchain it cannot fit on a small host is already imported lazily. This guide
is mostly configuration.

Budget about **45 minutes** the first time.

---

## Why Vercel rather than Netlify

Either will host this. Vercel is the suggestion because:

- The build is a plain Vite SPA. Vercel detects it with no configuration, and
  `vercel.json` in this repo pins the settings anyway.
- Environment variables are baked into the bundle at build time (see the warning
  in Part 2). Vercel's UI makes "change a variable, redeploy" one click, which
  is the operation you will do most while getting this working.
- Every deploy keeps a permanent preview URL, so a bad change is one click to
  roll back.

If you already have a Netlify account, use Netlify — replace `vercel.json` with
a `netlify.toml` carrying the same SPA rewrite. Nothing else differs.

---

## Before you start

You need:

| | |
|---|---|
| A GitHub account | with this repository pushed to it. Render and Vercel both deploy from GitHub, not from GitLab, unless you connect GitLab explicitly — both support it, the screens just differ slightly |
| A Render account | <https://render.com> — sign up with GitHub |
| A Vercel account | <https://vercel.com> — sign up with GitHub |
| Your Google OAuth client id | the one already in `.env.local`, from <https://console.cloud.google.com/apis/credentials> |
| One AI provider key | OpenRouter is the easiest: <https://openrouter.ai/keys> has free models. Gemini also works |

**Order matters.** The backend goes first, because the frontend needs its URL.
Then you come back to the backend to tell it the frontend's URL. There is no way
around that loop — each service needs the other's address.

---

## Part 1 — the backend on Render

### 1.1 Create the service

1. Render dashboard → **New +** → **Web Service**.
2. Connect your repository.
3. Fill in the form:

| Field | Value |
|---|---|
| Name | `smartrecap-api` |
| Language | `Python 3` |
| Root Directory | `backend` |
| Build Command | `pip install -r requirements-deploy.txt` |
| Start Command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Instance Type | `Free` |

> If Render offers to read `render.yaml` (a "Blueprint"), you can use that
> instead and skip this table — the file carries the same settings.

**`requirements-deploy.txt`, not `requirements.txt`.** The full file installs
torch, torchvision, paddlepaddle, paddleocr, pix2text and two OpenCV builds:
several gigabytes. A free instance has 512 MB of RAM and will fail to build it.
The deploy file is the same API with that toolchain left out — see
[what you give up](#what-you-give-up) below.

### 1.2 Set the environment variables

Still in the create form, or afterwards under **Environment**. Add these:

```
PYTHON_VERSION      3.11.9
JWT_SECRET          <click "Generate" — Render will make one>
GOOGLE_CLIENT_ID    <your Google OAuth client id>
OPENROUTER_API_KEY  <your OpenRouter key>
S3_BUCKET           <leave empty>
TABLE_NAME          <leave empty>
MAX_FILE_MB         25
CORS_ORIGINS        http://localhost:5173
```

Three of those deserve an explanation:

- **`PYTHON_VERSION` is load-bearing, not tidiness.** `numpy==2.0.2` and
  `Pillow==11.3.0` publish prebuilt wheels for Python 3.11. On a newer
  interpreter pip tries to compile them from source and the build fails.
- **`JWT_SECRET` must be set.** Left unset it defaults to a fresh random value
  every time the process starts — which on a free instance that sleeps means
  everyone is silently signed out several times a day.
- **`CORS_ORIGINS` is a placeholder for now.** You will replace it in Part 3
  once Vercel has given you a domain. Leaving localhost in it is harmless and
  useful — it lets you point a local frontend at the deployed API.

### 1.3 Deploy and check

Click **Create Web Service**. The first build takes 3–6 minutes.

When it says *Live*, Render shows the service URL at the top of the page,
just under the service name. It is built from the name **you** chose, so it is
almost certainly not the one written in this guide. Open your URL with
`/api/health` on the end:

```
https://<your-service-name>.onrender.com/api/health
```

You want:

```json
{ "status": "ok", "ai_configured": true, "demo_mode": false, "extractors": [...] }
```

- `ai_configured: false` means no provider key was picked up. Recaps still
  generate, but as a plain extractive summary rather than written prose.
- A long pause before it responds is expected — see [free tier](#the-free-tier-trade-offs).

**Copy the service URL.** You need it next.

---

## Part 2 — the frontend on Vercel

### 2.1 Import the project

1. Vercel dashboard → **Add New** → **Project**.
2. Import the same repository.
3. Vercel will detect Vite. Leave Framework, Build Command and Output Directory
   as detected — `vercel.json` already pins them.

### 2.2 Set the environment variables

Before deploying, open **Environment Variables** and add:

```
VITE_API_BASE_URL     https://<your-service-name>.onrender.com/api
VITE_GOOGLE_CLIENT_ID <the same Google client id as the backend>
```

> **The `/api` on the end is required.** The frontend appends paths like
> `/auth/guest` to whatever this is set to, and every route on the backend lives
> under `/api`. Without it, requests land on `/auth/guest` instead of
> `/api/auth/guest` and every call returns **Not Found** — the site loads, the
> backend is healthy, and nothing works.

> **Paste your own Render URL here, not the placeholder.** Copy it from the top
> of the Render service page. If you paste a hostname that does not exist, the
> site loads perfectly and then every action fails with "The SmartRecap API is
> not responding" — which looks like the backend is down when it is actually
> fine and simply being called at the wrong address.

> **These are baked into the JavaScript at build time, not read at runtime.**
> Vite replaces `import.meta.env.VITE_*` with literal strings during the build.
> Changing one in the dashboard does nothing until you **Redeploy**. This
> catches everyone once; when a change appears to have no effect, this is why.

No trailing slash after `/api`. The frontend strips one if present, but the
habit will bite you elsewhere.

To sanity-check the value before you deploy, open it in a browser with `/health`
on the end. `https://<your-service>.onrender.com/api/health` should return JSON.
If it 404s, the value is wrong.

### 2.3 Deploy

Click **Deploy**. Two to three minutes.

The build copies a 13 MB Pyodide runtime into the output and ships a 17 MB 3D
model, so the finished site is around 36 MB. That is well inside Vercel's
limits, but it is why the first visit takes a moment.

**Copy the deployment URL** — something like
`https://smartrecap.vercel.app`.

---

## Part 3 — connect the two

Three things still point at the wrong place.

### 3.1 Tell the backend about the frontend

Vercel gives a project several URLs. Use the **production domain** from
Project → Settings → Domains — the short, stable one. The long URL with a random
string in it (`smartrecap-qp7flphw6-...`) belongs to one individual deployment
and changes every time you deploy, so anything you configure against it breaks
on your next push.

Render → your service → **Environment** → edit `CORS_ORIGINS`:

```
https://<your-project>.vercel.app,http://localhost:5173
```

Comma-separated, no spaces, **no trailing slashes**, and the scheme (`https://`)
is required. The backend splits this string on commas and hands the result to
the CORS middleware; an origin that does not match exactly is rejected, and the
browser will report it as a CORS error rather than a configuration one.

Save. Render redeploys automatically.

### 3.2 Tell Google about the frontend

Google Cloud Console → **APIs & Services** → **Credentials** → your OAuth 2.0
Client ID → **Authorised JavaScript origins** → **Add URI**:

```
https://smartrecap.vercel.app
```

Keep `http://localhost:5173` in the list so local development still works.

Google rejects an unregistered origin inside its own popup, and the app never
sees the failure — no callback fires, so there is nothing to catch and nothing
to explain. If sign-in opens a popup that shows an error page in a language you
did not choose, this is the setting.

### 3.3 Redeploy the frontend if you changed its variables

If you set `VITE_API_BASE_URL` after the first deploy rather than before,
Vercel → **Deployments** → latest → **⋯** → **Redeploy**.

---

## Part 4 — test it

Work down this list. Each step tests one connection, so when something fails you
know which.

| # | Do this | Expect |
|---|---|---|
| 1 | Open `<render-url>/api/health` | JSON with `"status": "ok"` |
| 2 | Open your Vercel URL | The landing page, styled, with the 3D mascot |
| 3 | Open DevTools → Network, reload | No red entries. A request to `<render-url>/api/...` returning 200 |
| 4 | Click **Continue as a guest** | You land on the library |
| 5 | Upload a **text** PDF | Progress screen runs to completion, recap opens |
| 6 | Check a citation | Each recap point links back to a page |
| 7 | Generate a quiz | Questions appear |
| 8 | Sign in with Google | Account chooser popup, then your library |
| 9 | Visit `<vercel-url>/app/binders` directly | The page loads, not a 404 |

Step 9 checks the SPA rewrite in `vercel.json`. Without it, refreshing on any
route other than `/` returns a 404, because there is no file at that path — the
rewrite tells Vercel to serve `index.html` and let React Router take over.

Step 5 must be a PDF with **selectable text**. A scanned page or a photo will
extract nothing on this deployment — see below.

---

## What you give up

Three real limitations. None of them break the demo, but you should know them
before you show the site to someone.

### The free tier trade-offs

**The backend sleeps.** Render's free instances spin down after about 15 minutes
with no traffic. The next request wakes it, which takes roughly **50 seconds**.
The frontend is on Vercel and stays instant, so what a visitor sees is a site
that loads immediately and then appears to hang on its first action.

If you are demonstrating live, open the API health URL a minute beforehand to
wake it.

**Data lives in memory.** With `TABLE_NAME` empty there is no database: uploads,
recaps and quizzes are held in the process. When the instance sleeps or
redeploys, **the library empties**. Accounts go with it.

For a showcase where you upload a file and walk someone through it, that is
fine. If you want work to persist, the smallest change is to point `TABLE_NAME`
at a DynamoDB table on your own AWS account — DynamoDB's free tier is 25 GB and
is not part of the hackathon credits, so it costs nothing at this scale. That
also needs `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in Render's
environment.

### No OCR

`requirements-deploy.txt` leaves out the OCR toolchain, so a scanned PDF or a
photo of handwritten notes has no text to extract and produces an empty recap.

Text PDFs, PowerPoint, Word, plain text and Markdown all work exactly as they do
locally — that is every path in the demo.

Adding OCR back means a paid instance with enough memory to hold torch and
paddle, and a build that takes 20–40 minutes.

### Cold builds are slow the first time

Render caches dependencies between deploys, so the first build is the slow one.
Later deploys take a minute or two.

---

## When something is wrong

| What you see | What it usually is |
|---|---|
| Build fails on Render, `numpy` or `Pillow` compiling from source | `PYTHON_VERSION` is not `3.11.9`. Those versions only ship prebuilt wheels for 3.11 |
| Build fails, out of memory, mentions torch or paddle | The Build Command is pointing at `requirements.txt` instead of `requirements-deploy.txt` |
| Frontend loads, every API call fails, console says CORS | `CORS_ORIGINS` does not exactly match the Vercel origin. Check for a trailing slash, a missing `https://`, or `www.` |
| API calls go to `yoursite.vercel.app/api/...` instead of Render | `VITE_API_BASE_URL` was not set at build time. Set it, then **Redeploy** |
| Everyone signed out after a while | `JWT_SECRET` is unset, so it changes on each restart |
| Google popup shows an error page | The Vercel origin is not in **Authorised JavaScript origins** |
| Refreshing `/app/anything` gives 404 | `vercel.json` is missing or its rewrite was removed |
| First request takes ~50 s | The instance was asleep. Expected on the free plan |
| Every action fails with **Not Found** | `VITE_API_BASE_URL` is missing the `/api` suffix. It must end `.onrender.com/api` |
| Recap generates but reads like a list of sentences | No provider key reached the backend. `/api/health` will show `ai_configured: false` |
| Every recap is the same sample about geometric progressions | `DEMO_MODE` is `true` on Render. Set it to `false` |
| Sharing the link shows a Vercel login page | Deployment Protection is on. Vercel → Project → Settings → Deployment Protection |

---

## Files this guide relies on

| File | What it does |
|---|---|
| `render.yaml` | The backend service definition, so the settings live in the repo rather than only in a dashboard |
| `vercel.json` | Build settings, the SPA rewrite, and long cache headers for the model and Pyodide |
| `backend/requirements-deploy.txt` | The dependency set that fits a small host — same pins as `requirements.txt`, without the OCR toolchain |

The AWS guides — `docs/EC2-DEPLOYMENT.md` and `docs/AWS-DEPLOYMENT.md` — are
still accurate for the original architecture, and are worth keeping for the
report even though nothing is deployed there any more.
