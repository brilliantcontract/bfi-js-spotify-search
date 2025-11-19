import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HEADERS_FILE = path.join(DATA_DIR, "headers.json");

const API_URL = "https://api-partner.spotify.com/pathfinder/v2/query";

const DB_CONFIG = {
  host: process.env.DB_HOST || "3.140.167.34",
  port: Number.parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || "redash",
  password: process.env.DB_PASSWORD || "te83NECug38ueP",
  database: process.env.DB_NAME || "scrapers",
};

const FETCH_QUERIES_SQL = "select query from spotify.not_scraped_queries_vw";
const INSERT_SEARCH_SQL =
  "insert into spotify.searches(author_name, profile_title, query, url) values ($1, $2, $3, $4)";

const DEFAULT_HEADERS = {
  accept: "application/json",
  "accept-language": "en",
  "app-platform": "WebPlayer",
  authorization: process.env.SPOTIFY_AUTHORIZATION
    ? `Bearer ${process.env.SPOTIFY_AUTHORIZATION}`
    : "",
  "client-token": process.env.SPOTIFY_CLIENT_TOKEN || "",
  "content-type": "application/json;charset=UTF-8",
  origin: "https://open.spotify.com",
  referer: "https://open.spotify.com/",
  "spotify-app-version": "1.2.78.109.g7c0fa141",
  "user-agent":
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadHeaderOverrides() {
  try {
    const raw = await fs.readFile(HEADERS_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch (error) {
    return {};
  }
}

function buildRequestHeaders(overrides) {
  const headers = { ...DEFAULT_HEADERS };

  Object.entries(overrides || {}).forEach(([key, value]) => {
    if (typeof value === "string" && value.trim() !== "") {
      headers[key.toLowerCase()] = value.trim();
    }
  });

  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== "")
  );
}

function buildRequestBody(query) {
  return {
    variables: {
      includePreReleases: false,
      numberOfTopResults: 20,
      searchTerm: query,
      offset: 0,
      limit: 30,
      includeAudiobooks: true,
      includeAuthors: false,
    },
    operationName: "searchPodcasts",
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: "f4d1e6ff2422dd998e26ba696e853e4372811843361e91105f736d128d3d64e0",
      },
    },
  };
}

function buildUrlFromUri(uri) {
  if (typeof uri !== "string") {
    return null;
  }

  const parts = uri.split(":");

  if (parts.length < 3 || parts[0] !== "spotify") {
    return null;
  }

  const type = parts[1];
  const id = parts.slice(2).join(":");

  if (!type || !id) {
    return null;
  }

  return `https://open.spotify.com/${type}/${id}`;
}

function parseProfiles(responseJson, query) {
  const items = responseJson?.data?.searchPodcasts?.items;

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const authorName =
        typeof item?.publisher?.name === "string" ? item.publisher.name : "";
      const profileTitle = typeof item?.name === "string" ? item.name : "";
      const uri = typeof item?.uri === "string" ? item.uri : "";
      const url = buildUrlFromUri(uri);

      if (!url) {
        return null;
      }

      return { authorName, profileTitle, query, url };
    })
    .filter(Boolean);
}

async function fetchSearchResults(headers, query) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(query)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Request failed with status ${response.status}: ${text.slice(0, 200)}`
    );
  }

  return response.json();
}

async function loadQueries(pool) {
  const { rows } = await pool.query(FETCH_QUERIES_SQL);

  return rows
    .map((row) => (row && typeof row.query === "string" ? row.query.trim() : ""))
    .filter((value) => value !== "");
}

async function saveProfiles(pool, profiles) {
  if (!profiles.length) {
    return 0;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const profile of profiles) {
      await client.query(INSERT_SEARCH_SQL, [
        profile.authorName,
        profile.profileTitle,
        profile.query,
        profile.url,
      ]);
    }

    await client.query("COMMIT");
    return profiles.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function scrapeQueries() {
  await ensureDataDir();

  const headerOverrides = await loadHeaderOverrides();
  const headers = buildRequestHeaders(headerOverrides);

  if (!headers.authorization || !headers["client-token"]) {
    console.warn(
      "Warning: authorization or client-token header is missing. Requests may fail."
    );
  }

  const pool = new Pool(DB_CONFIG);

  try {
    const queries = await loadQueries(pool);

    if (!queries.length) {
      console.warn("No queries found to process.");
      return;
    }

    console.log(`Processing ${queries.length} quer${queries.length === 1 ? "y" : "ies"}.`);

    for (const query of queries) {
      try {
        const responseJson = await fetchSearchResults(headers, query);
        const profiles = parseProfiles(responseJson, query);

        if (!profiles.length) {
          console.warn(`No profiles returned for query: ${query}`);
          continue;
        }

        const inserted = await saveProfiles(pool, profiles);
        console.log(`Saved ${inserted} profile${inserted === 1 ? "" : "s"} for query "${query}".`);
      } catch (error) {
        console.error(`Failed to process query "${query}": ${error.message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

async function previewQuery(query) {
  if (!query || typeof query !== "string") {
    console.error("Please provide a search term after the 'preview' command.");
    process.exitCode = 1;
    return;
  }

  await ensureDataDir();

  const headerOverrides = await loadHeaderOverrides();
  const headers = buildRequestHeaders(headerOverrides);

  if (!headers.authorization || !headers["client-token"]) {
    console.warn(
      "Warning: authorization or client-token header is missing. Requests may fail."
    );
  }

  try {
    const responseJson = await fetchSearchResults(headers, query);
    const profiles = parseProfiles(responseJson, query);

    if (!profiles.length) {
      console.warn(`No profiles returned for query: ${query}`);
      return;
    }

    console.log(`Found ${profiles.length} profile${profiles.length === 1 ? "" : "s"} for query "${query}":`);
    profiles.forEach((profile, index) => {
      console.log(
        `${index + 1}. ${profile.authorName || "(no author)"} — ${
          profile.profileTitle || "(no title)"
        } -> ${profile.url}`
      );
    });
  } catch (error) {
    console.error(`Failed to preview query "${query}": ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const [command = "scrape", arg] = process.argv.slice(2);

  if (command === "preview") {
    await previewQuery(arg);
    return;
  }

  if (command !== "scrape") {
    console.warn(`Unknown command '${command}'. Falling back to 'scrape'.`);
  }

  await scrapeQueries();
}

main().catch((error) => {
  console.error("Fatal error while running scraper:", error);
  process.exitCode = 1;
});
