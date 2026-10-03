# Trip Splitter

A simple app to plan group trips: add a trip, add people, write the itinerary, record expenses, and see **who paid, who owes, and who should pay whom**. Data lives in your own Supabase database, so you can open it from any phone or laptop.

You need two free accounts: **Supabase** (the database) and **GitHub** (hosts the website). Setup takes about 10 minutes.

## What is in this folder

| File | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The website itself |
| `config.js` | Where your Supabase address and key go |
| `supabase/schema.sql` | Creates the database tables and rules |

---

## Step 1: Create the database (Supabase)

1. Go to https://supabase.com and sign in. Click **New project**. Choose any name and a database password (save it somewhere), pick the region closest to you (for India, Mumbai), and click **Create**. Wait about 2 minutes.
2. In the left menu open **SQL Editor** and click **New query**.
3. Open `supabase/schema.sql` from this folder, copy everything, paste it into the editor, and click **Run**. You should see "Success. No rows returned".
4. Go to **Project Settings** then **API** (or click the **Connect** button at the top). Copy two things:
   - **Project URL**, which looks like `https://abcdxyz.supabase.co`
   - **anon / publishable key**, a long text. Do **not** use the `secret` or `service_role` key.

## Step 2: Add your Supabase details

Open `config.js` and paste the two values between the quotes:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://abcdxyz.supabase.co",
  SUPABASE_KEY: "your-anon-or-publishable-key"
};
```

The anon/publishable key is designed to be public, so it is fine to keep it in GitHub. (If you skip this step, the app will ask for the two values the first time it opens and remember them on that device only.)

## Step 3: Put it on GitHub and publish

1. On https://github.com click **New repository**. Name it `trip-splitter`, keep it **Public** (free Pages hosting needs this on a free account), and click **Create**.
2. Click **uploading an existing file**, drag in **all files from this folder** (`index.html`, `app.js`, `style.css`, `config.js`, `.nojekyll`, `README.md` and the `supabase` folder), and click **Commit changes**.
3. Go to **Settings**, then **Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch **main**, folder **/ (root)**, and click **Save**.
4. After 1 to 2 minutes your site is live at `https://YOUR-USERNAME.github.io/trip-splitter/`.

## Using it

1. Open your site, create a trip, type the names of everyone going.
2. Tap **Share link** and send it on WhatsApp. Everyone who opens the link sees and edits the same trip.
3. Add expenses: what, how much, who paid, and tick who shares it. The split is equal among the ticked people.
4. The **Balances** tab shows who gets money and who owes, and the fewest payments needed. After someone pays, tap **Mark as paid**.

## How safe is it?

- The database tables are locked. Nobody can browse or list trips.
- Each trip has a long random secret inside its link. **Anyone who has the link can view and edit that trip**, so share it only with your group. Anyone who does not have the link cannot find it.
- There are no logins. If you need passwords and per-person accounts later, that can be added.
- The free Supabase plan pauses a project after about a week of no use. Opening the Supabase dashboard and clicking **Restore** brings it back, and your data stays.

## Known limits

- Splits are equal only (no custom percentages or exact amounts yet).
- One currency per trip.
- The page checks for changes from others every 15 seconds, not instantly.
