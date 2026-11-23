// Beria site Worker.
// Serves the static site from ./beria, plus one small API:
//   GET /api/status  ->  { online, players, maxPlayers, name, checkedAt }
//
// It asks Steam whether the Beria server is listed. With a Steam Web API key
// (secret STEAM_API_KEY) it also gets the player count; without one it can
// still tell online from offline. Results are cached for 60 seconds so
// visitors never hit Steam directly.

const SERVER_IP = "142.181.47.14";
const SERVER_PORTS = [15636, 15637]; // game port and query port
const CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") return status(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

async function status(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/status", request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let body;
  try {
    body = env.STEAM_API_KEY ? await withKey(env.STEAM_API_KEY) : await withoutKey();
  } catch (err) {
    body = { online: null, error: "Steam didn't answer" };
  }
  body.checkedAt = new Date().toISOString();

  const res = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
  if (body.online !== null) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
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
async function withKey(key) {
  const api = new URL("https://api.steampowered.com/IGameServersService/GetServerList/v1/");
  api.searchParams.set("key", key);
  api.searchParams.set("filter", `\\gameaddr\\${SERVER_IP}`);
  api.searchParams.set("limit", "20");
  const r = await fetch(api, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  const data = await r.json();
  const s = pickBeria(data?.response?.servers);
  if (!s) return { online: false };
  return {
    online: true,
    players: s.players ?? null,
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
