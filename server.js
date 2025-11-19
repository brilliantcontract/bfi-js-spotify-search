import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HEADERS_FILE = path.join(DATA_DIR, "headers.json");
const URLS_FILE = path.join(DATA_DIR, "urls.txt");
const KEY_FILE = path.join(DATA_DIR, "key.txt");
const COOKIES_FILE = path.join(__dirname, "cookies.json");

const DB_CONFIG = {
  host: process.env.DB_HOST || "3.140.167.34",
  port: Number.parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || "redash",
  password: process.env.DB_PASSWORD || "te83NECug38ueP",
  database: process.env.DB_NAME || "scrapers",
};

const FETCH_QUERIES_SQL =
  "select query from instagram.not_scraped_queries_vw limit 1000";
const MARK_QUERY_AS_EMPTY_SQL =
  "update instagram.queries set is_empty = true where query = $1";
const INSERT_SEARCH_SQL =
  "insert into instagram.searches(caption_text, full_name, hashtag, is_verified, profile_id, profile_pic_url, username) values ($1, $2, $3, $4, $5, $6, $7)";

const DEFAULT_CONFIG = {
  baseUrl: "https://www.instagram.com/api/v1/fbsearch/web/top_serp/",
  search_session_id: "",
  cookie: "",
  headers: {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0",
    "x-requested-with": "XMLHttpRequest",
  },
};

function normaliseCookieValue(value) {
  if (typeof value !== "string") {
    return "";
  }

  let result = value.trim();

  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }

  return result.replace(/\\054/g, ",");
}

async function loadCookieJar() {
  try {
    const raw = await fs.readFile(COOKIES_FILE, "utf-8");
    const cookies = JSON.parse(raw);

    if (!Array.isArray(cookies)) {
      return "";
    }

    const parts = cookies
      .map((cookie) => {
        if (!cookie || typeof cookie.name !== "string") {
          return null;
        }

        const value = normaliseCookieValue(cookie.value);

        if (value === "") {
          return null;
        }

        return `${cookie.name}=${value}`;
      })
      .filter(Boolean);

    return parts.join("; ");
  } catch (error) {
    return "";
  }
}

let cachedSearchSessionIdFromKeyFile = null;

async function loadSearchSessionIdFromKeyFile() {
  if (cachedSearchSessionIdFromKeyFile !== null) {
    return cachedSearchSessionIdFromKeyFile;
  }

  try {
    const raw = await fs.readFile(KEY_FILE, "utf-8");
    const trimmed = typeof raw === "string" ? raw.trim() : "";

    cachedSearchSessionIdFromKeyFile = trimmed;
  } catch (error) {
    cachedSearchSessionIdFromKeyFile = "";
  }

  return cachedSearchSessionIdFromKeyFile;
}

async function resolveDefaultSearchSessionId() {
  if (
    typeof DEFAULT_CONFIG.search_session_id === "string" &&
    DEFAULT_CONFIG.search_session_id.trim() !== ""
  ) {
    return DEFAULT_CONFIG.search_session_id.trim();
  }

  const fromKeyFile = await loadSearchSessionIdFromKeyFile();

  if (typeof fromKeyFile === "string" && fromKeyFile !== "") {
    DEFAULT_CONFIG.search_session_id = fromKeyFile;
    return fromKeyFile;
  }

  return "";
}

async function loadConfig() {
  let parsed = {};

  try {
    const raw = await fs.readFile(HEADERS_FILE, "utf-8");
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `Unable to read ${HEADERS_FILE}. Using default request settings.`
    );
  }

  const defaultSearchSessionId = await resolveDefaultSearchSessionId();

  const config = {
    baseUrl:
      typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() !== ""
        ? parsed.baseUrl.trim()
        : DEFAULT_CONFIG.baseUrl,
    search_session_id:
      typeof parsed.search_session_id === "string" &&
      parsed.search_session_id.trim() !== ""
        ? parsed.search_session_id.trim()
        : defaultSearchSessionId,
    cookie:
      typeof parsed.cookie === "string" && parsed.cookie.trim() !== ""
        ? parsed.cookie.trim()
        : DEFAULT_CONFIG.cookie,
    headers: {},
  };

  let headerSource = parsed.headers;

  if (
    !headerSource ||
    typeof headerSource !== "object" ||
    Array.isArray(headerSource)
  ) {
    const { baseUrl, search_session_id, cookie, ...rest } = parsed;
    headerSource = rest;
  }

  config.headers = { ...DEFAULT_CONFIG.headers };

  for (const [key, value] of Object.entries(headerSource || {})) {
    if (typeof value === "string" && value.trim() !== "") {
      config.headers[key] = value.trim();
    }
  }

  if (config.headers.cookie) {
    config.cookie = config.headers.cookie;
    delete config.headers.cookie;
  }

  if (!config.cookie) {
    config.cookie = await loadCookieJar();
  }

  return config;
}

function splitUrlsFileContent(raw) {
  const lines = raw.split(/\r?\n/);
  const entries = [];
  let buffer = "";

  lines.forEach((line) => {
    const hasContinuation = /\\\s*$/.test(line);
    const withoutContinuation = hasContinuation
      ? line.replace(/\\\s*$/, "")
      : line;

    if (!buffer && withoutContinuation.trim() === "") {
      return;
    }

    buffer += withoutContinuation;

    if (hasContinuation) {
      buffer += " ";
      return;
    }

    const entry = buffer.trim();

    if (entry !== "") {
      entries.push(entry);
    }

    buffer = "";
  });

  if (buffer.trim() !== "") {
    entries.push(buffer.trim());
  }

  return entries;
}

function parseUrlsEntry(entry) {
  const trimmed = entry.trim();

  if (trimmed === "") {
    return null;
  }

  if (/^#\s/.test(trimmed) || /^\/\//.test(trimmed)) {
    return null;
  }

  if (/^curl\s+/i.test(trimmed)) {
    return { type: "curl", value: trimmed };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { type: "url", value: trimmed };
  }

  const tag = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (tag === "") {
    return null;
  }

  return { type: "hashtag", value: tag };
}

async function loadRequestTargets(pool) {
  try {
    const { rows } = await pool.query(FETCH_QUERIES_SQL);
    const targets = [];

    rows.forEach((row) => {
      if (!row || typeof row.query !== "string") {
        return;
      }

      const trimmedQuery = row.query.trim();

      if (trimmedQuery === "") {
        return;
      }

      const entry = parseUrlsEntry(trimmedQuery);

      if (entry) {
        entry.sourceQuery = trimmedQuery;
        targets.push(entry);
      }
    });

    return targets;
  } catch (error) {
    const wrapped = new Error(
      `Unable to load request targets from database: ${error.message}`
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseCurlCommand(command) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      if (inSingle) {
        current += char;
        continue;
      }

      const next = command[index + 1];

      if (
        !inDouble ||
        next === '"' ||
        next === "\\" ||
        next === "$" ||
        next === "`" ||
        next === "\n"
      ) {
        escapeNext = true;
      } else {
        current += char;
      }

      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }

      continue;
    }

    current += char;
  }

  if (inSingle || inDouble) {
    throw new Error("Unterminated quote in curl command");
  }

  if (current !== "") {
    tokens.push(current);
  }

  if (!tokens.length) {
    throw new Error("Empty curl command");
  }

  if (tokens[0].toLowerCase() !== "curl") {
    throw new Error('Command must start with "curl"');
  }

  return tokens.slice(1);
}

function extractHashtagFromTarget(target) {
  if (!target || typeof target !== "object") {
    return null;
  }

  if (target.type === "hashtag") {
    return target.value;
  }

  if (target.type === "url") {
    try {
      const parsed = new URL(target.value);
      const query = parsed.searchParams.get("query");

      if (typeof query === "string" && query.trim() !== "") {
        return query.startsWith("#") ? query.slice(1) : query;
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  if (target.type === "curl") {
    try {
      const args = parseCurlCommand(target.value);
      const urlArg = args.find((item) => /^https?:\/\//i.test(item));

      if (!urlArg) {
        return null;
      }

      const parsed = new URL(urlArg);
      const query = parsed.searchParams.get("query");

      if (typeof query === "string" && query.trim() !== "") {
        return query.startsWith("#") ? query.slice(1) : query;
      }
    } catch (error) {
      return null;
    }
  }

  return null;
}

function createHeadersForTarget(config, target) {
  const headers = { ...config.headers };
  const hashtag = extractHashtagFromTarget(target);

  if (hashtag) {
    const refererTemplate =
      headers.referer || "https://www.instagram.com/explore/search/keyword/";

    try {
      const refererUrl = refererTemplate.includes("://")
        ? new URL(refererTemplate)
        : new URL(refererTemplate, "https://www.instagram.com");

      refererUrl.searchParams.set("q", `#${hashtag}`);
      headers.referer = refererUrl.toString();
    } catch (error) {
      headers.referer = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(
        `#${hashtag}`
      )}`;
    }
  }

  return headers;
}

function formatTargetLabel(target) {
  const hashtag = extractHashtagFromTarget(target);

  if (hashtag) {
    return `#${hashtag}`;
  }

  if (!target || typeof target !== "object") {
    return "unknown target";
  }

  if (target.type === "url") {
    return target.value;
  }

  if (target.type === "curl") {
    try {
      const args = parseCurlCommand(target.value);
      const urlArg = args.find((item) => /^https?:\/\//i.test(item));

      if (urlArg) {
        return urlArg;
      }
    } catch (error) {
      // Ignore parsing errors when formatting labels.
    }

    const compact = target.value.replace(/\s+/g, " ").trim();
    return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  }

  return String(target.value);
}

function buildRequestUrl(target, config) {
  if (target.type === "hashtag") {
    const url = new URL(config.baseUrl || DEFAULT_CONFIG.baseUrl);
    url.searchParams.set("enable_metadata", "true");
    url.searchParams.set("query", `#${target.value}`);

    if (config.search_session_id) {
      url.searchParams.set("search_session_id", config.search_session_id);
    }

    return url.toString();
  }

  if (target.type === "url") {
    if (!config.search_session_id) {
      return target.value;
    }

    try {
      const url = new URL(target.value);

      if (!url.searchParams.has("search_session_id")) {
        url.searchParams.set("search_session_id", config.search_session_id);
        return url.toString();
      }
    } catch (error) {
      return target.value;
    }

    return target.value;
  }

  throw new Error(
    `Unable to build request URL for target type "${target.type}".`
  );
}

function formatShellArgument(argument) {
  if (/^[A-Za-z0-9._~:/?@&=+\-%,]+$/.test(argument)) {
    return argument;
  }

  return `'${argument.replace(/'/g, "'\\''")}'`;
}

function formatCurlCommand(args) {
  const parts = ["curl"];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-b" || arg === "--cookie") {
      parts.push(arg);

      if (index + 1 < args.length) {
        parts.push("'[hidden]'");
        index += 1;
      }

      continue;
    }

    parts.push(formatShellArgument(arg));
  }

  return parts.join(" ");
}

function buildCurlArguments(requestUrl, config, target) {
  const args = ["--ssl-no-revoke", "-s", "--compressed", requestUrl];

  if (config.cookie) {
    args.push("-b", config.cookie);
  }

  Object.entries(createHeadersForTarget(config, target)).forEach(
    ([key, value]) => {
      if (typeof value === "string" && value.trim() !== "") {
        args.push("-H", `${key}: ${value}`);
      }
    }
  );

  return args;
}

function execCurlCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`curl exited with code ${code}`);
        error.stderr = stderr;
        error.stdout = stdout;
        error.exitCode = code;
        error.args = Array.isArray(args) ? [...args] : [];
        reject(error);
      }
    });
  });
}

function isSslHandshakeError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (error.exitCode === 35) {
    return true;
  }

  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const message = typeof error.message === "string" ? error.message : "";
  const combined = `${message}\n${stderr}`.toLowerCase();

  return combined.includes("ssl") || combined.includes("handshake");
}

function buildSslFallbackArgs(args) {
  const original = Array.isArray(args) ? args : [];

  if (!original.includes("--http1.1")) {
    return { args: ["--http1.1", ...original], reason: "http1.1" };
  }

  const hasTlsOption = original.some((arg) => /^--tls/i.test(arg));

  if (!hasTlsOption) {
    return { args: ["--tlsv1.2", ...original], reason: "tlsv1.2" };
  }

  return null;
}

async function execCurl(args) {
  const attempts = [];
  let currentArgs = Array.isArray(args) ? [...args] : [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await execCurlCommand(currentArgs);
    } catch (error) {
      attempts.push({
        args: Array.isArray(currentArgs) ? [...currentArgs] : [],
        error,
      });

      const fallback = isSslHandshakeError(error)
        ? buildSslFallbackArgs(currentArgs)
        : null;

      if (!fallback) {
        error.attempts = attempts;
        throw error;
      }

      const { args: nextArgs, reason } = fallback;

      console.warn(
        `Retrying curl request with fallback ${
          reason === "http1.1" ? "HTTP/1.1" : "TLS 1.2"
        } settings due to SSL error.`
      );

      currentArgs = nextArgs;
    }
  }

  const lastAttempt = attempts[attempts.length - 1];

  if (lastAttempt && lastAttempt.error) {
    lastAttempt.error.attempts = attempts;
    throw lastAttempt.error;
  }

  throw new Error("Unable to execute curl request.");
}

function normaliseUserRecord(user, extraFields = {}) {
  if (!user || typeof user !== "object") {
    return null;
  }

  const record = {
    id:
      user.id !== undefined
        ? user.id
        : user.pk !== undefined
        ? user.pk
        : user.pk_id !== undefined
        ? user.pk_id
        : null,
    full_name: typeof user.full_name === "string" ? user.full_name : "",
    username: typeof user.username === "string" ? user.username : "",
    is_verified: Boolean(user.is_verified),
    profile_pic_url:
      typeof user.profile_pic_url === "string" ? user.profile_pic_url : "",
  };

  if (
    extraFields &&
    typeof extraFields === "object" &&
    !Array.isArray(extraFields)
  ) {
    Object.entries(extraFields).forEach(([key, value]) => {
      record[key] = value;
    });
  }

  return record;
}

function extractUsersFromMediaGrid(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const mediaGrid = payload.media_grid;

  if (!mediaGrid || typeof mediaGrid !== "object") {
    return [];
  }

  const sections = Array.isArray(mediaGrid.sections) ? mediaGrid.sections : [];

  if (!sections.length) {
    return [];
  }

  const mediaItems = [];

  const collectMediaItems = (value) => {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(collectMediaItems);
      return;
    }

    if (value && typeof value === "object") {
      if (value.media && typeof value.media === "object") {
        mediaItems.push(value.media);
      }

      Object.keys(value).forEach((key) => {
        if (key === "media") {
          return;
        }

        const child = value[key];

        if (child && (typeof child === "object" || Array.isArray(child))) {
          collectMediaItems(child);
        }
      });
    }
  };

  sections.forEach((section) => {
    if (!section || typeof section !== "object") {
      return;
    }

    const layoutContent = section.layout_content;

    if (layoutContent && typeof layoutContent === "object") {
      if (layoutContent.medias !== undefined) {
        collectMediaItems(layoutContent.medias);
      } else {
        collectMediaItems(layoutContent);
      }
    }
  });

  const seenKeys = new Set();
  const results = [];

  mediaItems.forEach((media) => {
    if (!media || typeof media !== "object") {
      return;
    }

    const caption = media.caption;

    if (!caption || typeof caption !== "object") {
      return;
    }

    const captionUser =
      caption.user && typeof caption.user === "object" ? caption.user : null;

    if (!captionUser) {
      return;
    }

    const captionText = typeof caption.text === "string" ? caption.text : "";
    const mediaId =
      media.id !== undefined
        ? media.id
        : media.pk !== undefined
        ? media.pk
        : media.pk_id !== undefined
        ? media.pk_id
        : null;
    const normalised = normaliseUserRecord(captionUser, {
      caption_text: captionText,
    });

    if (!normalised) {
      return;
    }

    const dedupeKey =
      (mediaId !== null && `media:${mediaId}`) ||
      (normalised.username && `${normalised.username}:${captionText}`) ||
      (normalised.id !== null && `id:${normalised.id}:${captionText}`);

    if (dedupeKey) {
      if (seenKeys.has(dedupeKey)) {
        return;
      }

      seenKeys.add(dedupeKey);
    }

    results.push(normalised);
  });

  return results;
}

function extractUsersFromLegacyPayload(payload) {
  const rawUsers = Array.isArray(payload.users) ? payload.users : [];

  return rawUsers
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      if (item.user && typeof item.user === "object") {
        return normaliseUserRecord(item.user);
      }

      return normaliseUserRecord(item);
    })
    .filter(Boolean);
}

function extractUsers(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const mediaGridUsers = extractUsersFromMediaGrid(payload);

  if (mediaGridUsers.length) {
    return mediaGridUsers;
  }

  return extractUsersFromLegacyPayload(payload);
}

async function fetchUsers(target, config) {
  let stdout = "";
  let args = [];

  if (target.type === "curl") {
    try {
      args = parseCurlCommand(target.value);
    } catch (error) {
      const parseError = new Error(
        `Unable to parse curl command: ${error.message}`
      );
      parseError.details = target.value;
      throw parseError;
    }

    ({ stdout } = await execCurl(args));
  } else {
    const requestUrl = buildRequestUrl(target, config);
    args = buildCurlArguments(requestUrl, config, target);
    ({ stdout } = await execCurl(args));
  }

  if (!stdout || stdout.trim() === "") {
    throw new Error("Empty response received from curl request");
  }

  let payload;

  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    const snippet = stdout.length > 200 ? `${stdout.slice(0, 200)}...` : stdout;
    const parseError = new Error(
      `Unable to parse JSON response: ${error.message}`
    );
    parseError.details = snippet;
    throw parseError;
  }

  return extractUsers(payload);
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let stringValue;

  if (typeof value === "object") {
    try {
      stringValue = JSON.stringify(value);
    } catch (error) {
      stringValue = String(value);
    }
  } else {
    stringValue = String(value);
  }

  if (/["\r\n,]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function determineDynamicColumns(users, baseColumnSet) {
  const dynamicColumns = [];

  if (!Array.isArray(users)) {
    return dynamicColumns;
  }

  const seen = new Set();

  users.forEach((user) => {
    if (!user || typeof user !== "object") {
      return;
    }

    Object.keys(user).forEach((key) => {
      if (baseColumnSet.has(key) || seen.has(key)) {
        return;
      }

      seen.add(key);
      dynamicColumns.push(key);
    });
  });

  return dynamicColumns;
}

async function saveResultsToDatabase(pool, results) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("A valid database pool must be provided to save results.");
  }

  if (!Array.isArray(results) || results.length === 0) {
    console.log("No results to save to database.");
    return;
  }

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query("BEGIN");

    for (const { target, users } of results) {
      const sourceQuery =
        target && typeof target === "object" && typeof target.sourceQuery === "string"
          ? target.sourceQuery
          : null;

      if (!Array.isArray(users) || users.length === 0) {
        if (sourceQuery) {
          await client.query(MARK_QUERY_AS_EMPTY_SQL, [sourceQuery]);
        }
        continue;
      }

      const hashtagValue = extractHashtagFromTarget(target);
      const hashtag = hashtagValue ? `#${hashtagValue}` : null;

      for (const user of users) {
        if (!user || typeof user !== "object") {
          continue;
        }

        const captionText =
          user.caption_text !== undefined && user.caption_text !== null
            ? user.caption_text
            : null;
        const fullName =
          typeof user.full_name === "string" ? user.full_name : null;
        const isVerified = Boolean(user.is_verified);
        const profileId =
          user.id !== undefined && user.id !== null && user.id !== ""
            ? String(user.id)
            : null;
        const profilePicUrl =
          typeof user.profile_pic_url === "string" &&
          user.profile_pic_url !== ""
            ? user.profile_pic_url
            : null;
        const username =
          typeof user.username === "string" ? user.username : null;

        await client.query(INSERT_SEARCH_SQL, [
          captionText,
          fullName,
          hashtag,
          isVerified,
          profileId,
          profilePicUrl,
          username,
        ]);

        inserted += 1;
      }
    }

    await client.query("COMMIT");
    console.log(
      `Saved ${inserted} row${inserted === 1 ? "" : "s"} to database.`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    const wrapped = new Error(
      `Unable to save results to database: ${error.message}`
    );
    wrapped.cause = error;
    throw wrapped;
  } finally {
    client.release();
  }
}

async function main() {
  let pool;

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });

    pool = new Pool(DB_CONFIG);

    const [config, targets] = await Promise.all([
      loadConfig(),
      loadRequestTargets(pool),
    ]);

    if (!targets.length) {
      console.warn("No requests found in database.");
      return;
    }

    console.log(`Total requests to process: ${targets.length}`);

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const label = formatTargetLabel(target);
      const aggregatedResults = [];
      console.log(`Fetching (${index + 1}/${targets.length}): ${label}`);

      try {
        const users = await fetchUsers(target, config);

        if (!users.length) {
          console.warn(`No users returned for ${label}.`);
        }

        aggregatedResults.push({ target, users });
      } catch (error) {
        console.error(`Failed to fetch data for ${label}: ${error.message}`);

        if (error.stderr) {
          console.error(error.stderr.trim());
        }

        if (error.details) {
          console.error(error.details);
        }
      }

      await saveResultsToDatabase(pool, aggregatedResults);
    }
  } catch (error) {
    console.error("Fatal error while running scraper:", error);
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch (closeError) {
        console.warn(
          "Unable to close database pool cleanly:",
          closeError.message
        );
      }
    }
  }
}

main();
