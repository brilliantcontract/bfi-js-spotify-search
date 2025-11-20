# Spotify Podcast Search Scraper

A Node.js script that fetches podcast search results from Spotify's Pathfinder API and saves them to Postgres.

## Prerequisites
- Node.js 20+
- Access to a Postgres database matching the connection details configured in `server.js` or environment variables
- Valid Spotify request headers (Bearer token and client token)

## Providing Spotify headers
The scraper requires two headers for every request:
- `authorization` (a Bearer token)
- `client-token`

You can supply these in one of two ways:

### 1) Environment variables
Create a `.env` file (or export the variables directly) with:

```
SPOTIFY_AUTHORIZATION=YOUR_SPOTIFY_BEARER_TOKEN
SPOTIFY_CLIENT_TOKEN=YOUR_SPOTIFY_CLIENT_TOKEN
```

`SPOTIFY_AUTHORIZATION` can be either the raw token or the full `Bearer <token>` string; the script will normalize it.

### 2) `data/headers.json`
Create `data/headers.json` with the required values:

```
{
  "authorization": "Bearer YOUR_SPOTIFY_BEARER_TOKEN",
  "client-token": "YOUR_SPOTIFY_CLIENT_TOKEN"
}
```

If both the environment variables and `data/headers.json` provide a value, the file takes precedence.

## Running the scraper
Install dependencies and start the script:

```
npm install
node server.js
```

If either header is missing, the script will stop and print a descriptive error so you can add the required credentials.
