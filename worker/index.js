// Beria site Worker.
// Serves the static site from ./beria, plus one small API:
//   GET /api/status  ->  { online, players, maxPlayers, name, checkedAt,
//                          lastSeenOnline, uptime24h, samples24h, history24h }
//
// It asks Steam whether the Beria server is listed. With a Steam Web API key
// (secret STEAM_API_KEY) it also gets the player count; without one it can
// still tell online from offline. Live results are cached for 60 seconds so
// visitors never hit Steam directly.
//
// Every 5 minutes a scheduled check saves a sample to the HISTORY KV store,
// which powers "last seen online" and the 24-hour uptime bar.

const SERVER_IP = "142.181.47.14";
const SERVER_PORTS = [15636, 15637]; // game port and query port
const ENSHROUDED_APPID = 1203620;
const CACHE_SECONDS = 60;
const KEEP_HOURS = 24;
const BUCKETS = 48; // 30-minute slots in the 24-hour bar

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") return status(request, env, ctx);
    if (url.pathname === "/api/game") return game(request, ctx);
    return env.ASSETS.fetch(request);
  },

  // Cron trigger (see wrangler.jsonc): record one sample.
  async scheduled(event, env, ctx) {
    if (!env.HISTORY) return;
    let live;
    try { live = await lookup(env); } catch { return; } // Steam didn't answer; don't record a guess
    ctx.waitUntil(record(env, live, event.scheduledTime || Date.now()));
  },
};

// ---------- live status ----------

async function status(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/status", request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let body;
  try {
    body = await lookup(env);
  } catch (err) {
    body = { online: null, error: "Steam didn't answer" };
  }
  body.checkedAt = new Date().toISOString();
  try { Object.assign(body, await historySummary(env, body)); } catch { /* history is optional */ }

  const res = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
  if (body.online !== null) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function lookup(env) {
  let body = env.STEAM_API_KEY ? await withKey(env.STEAM_API_KEY) : null;
  // If the detailed lookup can't find Beria, double-check with the simple one
  // so a lookup quirk never shows the server as offline when it's up.
  if (!body || !body.online) {
    const simple = await withoutKey();
    if (!body || simple.online) body = simple;
  }
  return body;
}

function portOf(addr) {
  const p = Number(String(addr || "").split(":")[1]);
  return Number.isFinite(p) ? p : null;
}

function pickBeria(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return null;
  return (
    servers.find((s) => SERVER_PORTS.includes(s.gameport) || SERVER_PORTS.includes(portOf(s.addr))) ||
    null
  );
}

// Full details: name and player count. Needs a Steam Web API key.
// Steam only lists Beria when the filter includes Enshrouded's app ID.
async function withKey(key) {
  const api = new URL("https://api.steampowered.com/IGameServersService/GetServerList/v1/");
  api.searchParams.set("key", key);
  api.searchParams.set("filter", `\\appid\\${ENSHROUDED_APPID}\\gameaddr\\${SERVER_IP}`);
  api.searchParams.set("limit", "20");
  const r = await fetch(api, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  const data = await r.json();
  const s = pickBeria(data?.response?.servers);
  if (!s) return { online: false };
  return {
    online: true,
    // Steam leaves out zero values, so a missing count means nobody is on
    players: s.players ?? 0,
    maxPlayers: s.max_players ?? null,
    name: s.name ?? null,
  };
}

// Online/offline only. Works with no key.
async function withoutKey() {
  const api = new URL("https://api.steampowered.com/ISteamApps/GetServersAtAddress/v1/");
  api.searchParams.set("addr", SERVER_IP);
  api.searchParams.set("format", "json");
  const r = await fetch(api, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  const data = await r.json();
  if (!data?.response?.success) throw new Error("Steam lookup failed");
  return { online: Boolean(pickBeria(data.response.servers)), players: null, maxPlayers: null };
}

// ---------- history ----------
// One KV value: { samples: [[timeMs, 1|0, players|null], ...], lastOnline: ISO string }

async function readHistory(env) {
  if (!env.HISTORY) return null;
  return (await env.HISTORY.get("history", "json")) || { samples: [], lastOnline: null };
}

async function record(env, live, now) {
  const h = await readHistory(env);
  const cutoff = now - KEEP_HOURS * 3600e3;
  h.samples = h.samples.filter((s) => s[0] >= cutoff);
  h.samples.push([now, live.online ? 1 : 0, live.players ?? null]);
  if (live.online) h.lastOnline = new Date(now).toISOString();
  await env.HISTORY.put("history", JSON.stringify(h));
}

async function historySummary(env, live) {
  const h = await readHistory(env);
  if (!h) return {};
  const now = Date.now();
  const start = now - KEEP_HOURS * 3600e3;
  const size = (KEEP_HOURS * 3600e3) / BUCKETS;
  const up = new Array(BUCKETS).fill(0);
  const seen = new Array(BUCKETS).fill(0);
  let online = 0, total = 0;
  for (const [t, on] of h.samples) {
    if (t < start) continue;
    const i = Math.min(BUCKETS - 1, Math.floor((t - start) / size));
    seen[i]++; up[i] += on; total++; online += on;
  }
  // Each slot: 1 = up the whole time, 0 = down, 0.5 = some of each, null = no data yet
  const history24h = seen.map((n, i) => (n === 0 ? null : up[i] === n ? 1 : up[i] === 0 ? 0 : 0.5));
  return {
    lastSeenOnline: live.online ? new Date(now).toISOString() : h.lastOnline,
    uptime24h: total ? Math.round((online / total) * 1000) / 10 : null,
    samples24h: total,
    history24h,
  };
}

// ---------- Enshrouded news and global player count (no key needed) ----------
//   GET /api/game  ->  { playingNow, news: [{ title, url, date }],
//                        builds: { game: {id, updated}, server: {id, updated} } }
// Cached for 30 minutes: this changes slowly.

const GAME_CACHE_SECONDS = 1800;
const DEDICATED_SERVER_APPID = 2278520;

// Latest public build numbers. Steam only gives these to publishers, so this
// uses steamcmd.net, an unofficial mirror of Steam's app info. It shows the
// newest build available, not necessarily the one Beria is running.
async function latestBuild(appid) {
  const r = await fetch(`https://api.steamcmd.net/v1/info/${appid}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`steamcmd.net ${r.status}`);
  const data = await r.json();
  const pub = data?.data?.[appid]?.depots?.branches?.public;
  if (!pub?.buildid) throw new Error("no build id");
  return { id: String(pub.buildid), updated: pub.timeupdated ? new Date(Number(pub.timeupdated) * 1000).toISOString() : null };
}

async function game(request, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/game", request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [playingNow, news, game, server] = await Promise.all([
    playerCount().catch(() => null),
    officialNews().catch(() => null),
    latestBuild(ENSHROUDED_APPID).catch(() => null),
    latestBuild(DEDICATED_SERVER_APPID).catch(() => null),
  ]);
  const body = { playingNow, news, builds: { game, server }, checkedAt: new Date().toISOString() };
  const res = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${GAME_CACHE_SECONDS}`,
    },
  });
  // Only keep a complete answer; retry sooner if Steam didn't answer
  if (playingNow !== null && news !== null) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function playerCount() {
  const api = new URL("https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/");
  api.searchParams.set("appid", String(ENSHROUDED_APPID));
  const r = await fetch(api, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  const data = await r.json();
  if (data?.response?.result !== 1) throw new Error("no count");
  return data.response.player_count;
}

// Keen Games' official announcements (patch notes, updates) from Steam
async function officialNews() {
  const api = new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/");
  api.searchParams.set("appid", String(ENSHROUDED_APPID));
  api.searchParams.set("count", "5");
  api.searchParams.set("maxlength", "1");
  api.searchParams.set("feeds", "steam_community_announcements");
  api.searchParams.set("format", "json");
  const r = await fetch(api, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  const data = await r.json();
  return (data?.appnews?.newsitems || []).slice(0, 5).map((n) => ({
    title: n.title,
    // Link to the normal Steam news page rather than Steam's image-server address
    url: n.gid ? `https://store.steampowered.com/news/app/${ENSHROUDED_APPID}/view/${n.gid}` : n.url,
    date: new Date(n.date * 1000).toISOString(),
  }));
}
