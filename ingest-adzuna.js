// ============================================================
//  JOBRA AI: Adzuna ingestion (US + Canada, tech/software/cyber)
//  Pulls fresh listings, normalizes them, upserts into Supabase,
//  and prunes stale rows so the DB stays inside the free tier.
//
//  Run locally:   node ingest-adzuna.mjs
//  Or hourly via GitHub Actions (see .github/workflows/ingest.yml)
//
//  Required env vars:
//    SUPABASE_URL                 (Project URL)
//    SUPABASE_SERVICE_ROLE_KEY    (Settings → API → service_role key, keep SECRET)
//    ADZUNA_APP_ID                (https://developer.adzuna.com, free)
//    ADZUNA_APP_KEY
// ============================================================

import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADZUNA_APP_ID,
  ADZUNA_APP_KEY,
} = process.env;

for (const [k, v] of Object.entries({
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY,
})) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// --- What we search for, per country -----------------------------
const COUNTRIES = ["us", "ca"];
const QUERIES = [
  "software engineer",
  "software developer",
  "frontend developer",
  "backend engineer",
  "full stack developer",
  "devops engineer",
  "site reliability engineer",
  "cloud engineer",
  "cybersecurity",
  "information security",
  "security engineer",
  "penetration tester",
  "data engineer",
  "machine learning engineer",
];
const PAGES_PER_QUERY = 2;        // 50 results/page → ~100 per query
const RESULTS_PER_PAGE = 50;
const MAX_DAYS_OLD = 14;          // only reasonably fresh postings

// --- Classification helpers --------------------------------------
function classifyCategory(text = "") {
  const t = text.toLowerCase();
  if (/(cyber|infosec|information security|security engineer|penetration|pentest|soc analyst|threat|appsec)/.test(t)) return "cybersecurity";
  if (/(devops|sre|site reliability|platform engineer|infrastructure|cloud engineer|kubernetes)/.test(t)) return "devops";
  if (/(data engineer|machine learning|ml engineer|data scientist|ai engineer|analytics engineer)/.test(t)) return "data";
  if (/(software|developer|engineer|programmer|frontend|backend|full.?stack|mobile|ios|android)/.test(t)) return "software";
  return "it";
}
function classifySeniority(title = "") {
  const t = title.toLowerCase();
  if (/\b(intern|internship|co-?op)\b/.test(t)) return "intern";
  if (/\b(junior|jr\.?|entry|graduate|new grad|associate)\b/.test(t)) return "junior";
  if (/\b(principal|staff|lead|architect|head of|director)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|sr )\b/.test(t)) return "senior";
  return "mid";
}
function detectRemote(text = "") {
  return /\b(remote|work from home|wfh|distributed|anywhere)\b/i.test(text);
}

async function fetchAdzuna(country, query, page) {
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
  url.searchParams.set("app_id", ADZUNA_APP_ID);
  url.searchParams.set("app_key", ADZUNA_APP_KEY);
  url.searchParams.set("results_per_page", String(RESULTS_PER_PAGE));
  url.searchParams.set("what", query);
  url.searchParams.set("category", "it-jobs");
  url.searchParams.set("max_days_old", String(MAX_DAYS_OLD));
  url.searchParams.set("sort_by", "date");
  url.searchParams.set("content-type", "application/json");

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Adzuna ${country}/${query} p${page} → HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

function normalize(r, country) {
  const title = r.title || "";
  const desc = r.description || "";
  const loc = r.location?.display_name || "";
  const blob = `${title} ${loc} ${desc}`;
  return {
    id: `adzuna:${r.id}`,
    source: "adzuna",
    title: title.replace(/<\/?[^>]+>/g, "").trim(),
    company: r.company?.display_name || null,
    location: loc || null,
    country: country === "us" ? "US" : "CA",
    is_remote: detectRemote(blob),
    category: classifyCategory(`${title} ${desc}`),
    seniority: classifySeniority(title),
    salary_min: r.salary_min ?? null,
    salary_max: r.salary_max ?? null,
    currency: country === "us" ? "USD" : "CAD",
    url: r.redirect_url || null,
    description: desc.replace(/<\/?[^>]+>/g, "").slice(0, 1200) || null,
    posted_at: r.created || null,
    last_seen: new Date().toISOString(),
    // first_seen intentionally omitted → kept for existing rows, defaulted for new
  };
}

async function run() {
  const byId = new Map();

  for (const country of COUNTRIES) {
    for (const query of QUERIES) {
      for (let page = 1; page <= PAGES_PER_QUERY; page++) {
        const results = await fetchAdzuna(country, query, page);
        for (const r of results) {
          const job = normalize(r, country);
          if (job.title) byId.set(job.id, job);
        }
        await new Promise((res) => setTimeout(res, 300)); // be polite
      }
    }
    console.log(`Fetched ${country.toUpperCase()}, running total ${byId.size} unique jobs`);
  }

  const rows = [...byId.values()];
  console.log(`Upserting ${rows.length} jobs…`);

  // Upsert in batches of 500
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from("jobs").upsert(batch, { onConflict: "id" });
    if (error) console.error("Upsert error:", error.message);
  }

  // Prune: drop anything older than 21 days OR not seen in the last 7 days,
  // keeping the table small enough for the Supabase free tier.
  const old = new Date(Date.now() - 21 * 864e5).toISOString();
  const unseen = new Date(Date.now() - 7 * 864e5).toISOString();
  await supabase.from("jobs").delete().lt("posted_at", old);
  await supabase.from("jobs").delete().lt("last_seen", unseen);

  const { count } = await supabase
    .from("jobs")
    .select("*", { count: "exact", head: true });
  console.log(`Done. jobs table now holds ~${count ?? "?"} rows.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
