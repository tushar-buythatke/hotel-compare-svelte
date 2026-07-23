/**
 * bridge.js — how the page talks to the extension.
 *
 *  PROD ('ext'):   dispatch HOTEL_EXTENSION_REQUEST  ->  hotel-bridge.js -> service worker
 *                  listen   HOTEL_EXTENSION_RESPONSE  (per-request) and HOTEL_EXTENSION_STREAM (push)
 *
 *  DEV  ('devws', ?dev=1):  open a WebSocket straight to the backend (ws://127.0.0.1:4448) so we can
 *                  exercise resolve / live / search locally WITHOUT the extension. Partner fetches
 *                  (which need cookies/CORS) are faked from sample raw bodies in /public/samples/<pos>.txt,
 *                  and suggestions come from a tiny static list. Lets us demo the grid off a local DB.
 */

const params = new URLSearchParams(location.search);
// MODE: 'sky' (?sky=1) → the Python Skyscanner backend; 'devws' (?dev=1) → local WS backend;
// 'ext' (default) → the BuyHatke extension bridge.
export const MODE = params.get("sky") ? "sky" : params.get("dev") ? "devws" : "ext";
const DEV_WS = params.get("ws") || "ws://127.0.0.1:4448";
const SKY_BASE = params.get("skyurl") || "http://127.0.0.1:4460";

const EXT_TIMEOUT = 90000;
const log = (...a) => console.log("%c[web]", "color:#4f8cff", ...a);
log(`bridge init — MODE=${MODE}${MODE === "devws" ? " (" + DEV_WS + ")" : ""}`);

// detect the extension bridge. The READY event fires at document_start (before this module loads), so we
// primarily check the race-free DOM flag the bridge set; the event is a backup.
const bridgeFlag = () => { try { return document.documentElement.getAttribute("data-hotel-bridge") === "1"; } catch (e) { return false; } };
let bridgeReady = bridgeFlag();
if (bridgeReady) log("✅ extension bridge detected (DOM flag)");
window.addEventListener("HOTEL_BRIDGE_READY", (e) => { bridgeReady = true; log("✅ HOTEL_BRIDGE_READY", e.detail); });
if (MODE === "ext") setTimeout(() => {
  if (bridgeFlag()) { if (!bridgeReady) { bridgeReady = true; log("✅ extension bridge detected (DOM flag, late)"); } }
  else console.warn("%c[web]", "color:#d29922", "⚠️ extension bridge NOT detected. Reload the extension (rebuild needed after manifest changes), or use ?dev=1 to hit the backend directly.");
}, 1500);

/* ───────────────────────── PROD: extension bridge ───────────────────────── */

const extPending = new Map();
if (MODE === "ext") {
	window.addEventListener("HOTEL_EXTENSION_RESPONSE", (e) => {
		const { requestId, response, error } = (e && e.detail) || {};
		const p = extPending.get(requestId);
		if (!p) return;
		extPending.delete(requestId);
		error ? p.reject(new Error(error)) : p.resolve(response);
	});
}

function callExt(action, payload = {}) {
	const requestId = `${action}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	log(`→ callExt ${action}`, payload);
	return new Promise((resolve, reject) => {
		extPending.set(requestId, {
			resolve: (r) => { log(`← ${action} resolved`, r); resolve(r); },
			reject: (e) => { console.warn("%c[web]", "color:#d29922", `← ${action} rejected: ${e.message}`); reject(e); },
		});
		window.dispatchEvent(new CustomEvent("HOTEL_EXTENSION_REQUEST", { detail: { requestId, action, payload } }));
		setTimeout(() => { if (extPending.delete(requestId)) reject(new Error("extension timeout / not installed")); }, EXT_TIMEOUT);
	});
}

// optional server-push stream (live partner results)
export function onStream(cb) {
	if (MODE === "ext") window.addEventListener("HOTEL_EXTENSION_STREAM", (e) => cb(e && e.detail));
}

/* ───────────────────────── DEV: direct backend WebSocket ───────────────────────── */

let devWs = null, devConnect = null;
const devPending = new Map();   // `${requestId}:${type}:${pos}` -> {resolve,reject}
const DEV_EXT = { extId: "DEV", extAuth: "DEV" };

function devConnectWs() {
	if (devConnect) return devConnect;
	if (devWs && devWs.readyState === WebSocket.OPEN) return Promise.resolve(true);
	devConnect = new Promise((resolve) => {
		devWs = new WebSocket(DEV_WS);
		devWs.onopen = () => { devConnect = null; resolve(true); };
		devWs.onmessage = (ev) => {
			let r; try { r = JSON.parse(ev.data); } catch { return; }
			const key = `${r.requestId}:${r.type}:${r.pos != null ? r.pos : ""}`;
			const p = devPending.get(key);
			if (p) { devPending.delete(key); p.resolve(r); }
		};
		devWs.onclose = () => { devWs = null; devConnect = null; };
		devWs.onerror = () => {};
	});
	return devConnect;
}

function devSend(type, payload, requestId, pos = "") {
	log(`→ devSend ${type}${pos !== "" ? " pos=" + pos : ""}`);
	return new Promise(async (resolve, reject) => {
		const key = `${requestId}:${type}:${pos}`;
		devPending.set(key, { resolve: (r) => { log(`← ${type}${pos !== "" ? " pos=" + pos : ""}`, r && r.status), resolve(r); }, reject });
		const ok = await devConnectWs();
		if (!ok || !devWs || devWs.readyState !== WebSocket.OPEN) { devPending.delete(key); return reject(new Error("dev ws not connected — is server.js running on " + DEV_WS + " ?")); }
		devWs.send(JSON.stringify({ type, requestId, ...DEV_EXT, ...payload }));
		setTimeout(() => { if (devPending.delete(key)) reject(new Error("dev ws timeout")); }, EXT_TIMEOUT);
	});
}

async function devSampleRaw(pos) {
	try { const r = await fetch(`/samples/${pos}.txt`); return r.ok ? await r.text() : ""; } catch { return ""; }
}

const DEV_SUGGEST = [
	{ name: "Taj Lands End", city: "Mumbai", type: "hotel", lat: 19.0431, lng: 72.823, source: "dev" },
	{ name: "La Marvella", city: "Bangalore", type: "hotel", lat: 12.9279, lng: 77.627, source: "dev" },
	{ name: "Bangalore", city: "Bangalore", type: "city", source: "dev" },
];

/* ───────────────────────── unified API used by the UI ───────────────────────── */

export async function suggest(q, source = "emt") {
	if (MODE === "sky") {
		if (!q || q.length < 2) return [];
		const r = await fetch(`${SKY_BASE}/suggest?q=${encodeURIComponent(q)}`).then((x) => x.json()).catch(() => ({}));
		return r.suggestions || [];
	}
	if (MODE === "ext") return await callExt("hotelSuggest", { q, source });
	q = (q || "").toLowerCase();
	return DEV_SUGGEST.filter((s) => s.name.toLowerCase().includes(q));
}

// Skyscanner one-shot compare (create+poll+content, normalized to {canonical, partners, grid}).
export async function skyCompare(target, query) {
	const p = new URLSearchParams({
		entityId: target.entityId || "", checkin: query.checkin, checkout: query.checkout,
		adults: query.adults, rooms: query.rooms, children: query.children || 0,
	});
	return await fetch(`${SKY_BASE}/compare?${p}`).then((x) => x.json());
}

export async function resolve(target, requestId) {
	if (MODE === "ext") return await callExt("hotelResolve", { target, requestId });
	return await devSend("hotelResolve", { target }, requestId);
}

// static reference (meal-plan glossary) from the backend — the info tab renders whatever the server sends,
// so the glossary always tracks the backend's current meal buckets. Returns { mealGlossary: [...] } or null.
export async function fetchMeta(requestId = `meta_${Date.now()}`) {
	if (MODE === "sky") return null;   // no socket in sky mode; UI keeps its default meal glossary
	if (MODE === "ext") return await callExt("hotelMeta", { requestId });
	return await devSend("hotelMeta", {}, requestId);
}

// ── Hotel price alerts — go to paAPIs via the extension SW (cookies/ext_id not needed by the API, but the
// SW holds ext_id/auth_val). In dev-ws mode there's no SW, so POST paAPIs directly (dev-only). ──
const PAAPI = "https://api.buyhatke.com/paapi";
export async function setHotelAlert(alert) {
	if (MODE === "ext") return await callExt("setHotelAlert", { alert });
	// dev: direct POST (no ext identity — for local testing of the API only)
	const body = new URLSearchParams({ platform: "0" });
	for (const [k, v] of Object.entries(alert || {})) if (v != null && v !== "") body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
	return await fetch(`${PAAPI}/hotel/setAlert`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }).then((r) => r.json()).catch(() => ({ status: 0 }));
}
export async function removeHotelAlert(entry_id) {
	if (MODE === "ext") return await callExt("removeHotelAlert", { entry_id });
	return await fetch(`${PAAPI}/hotel/removeAlert`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ platform: "0", entry_id: String(entry_id) }) }).then((r) => r.json()).catch(() => ({ status: 0 }));
}

// fetch one partner's live detail -> backend parse -> {partner, grid}
export async function liveFetch({ pos, ids, query, requestId }) {
	if (MODE === "ext") return await callExt("hotelLiveFetch", { pos, ids, query, requestId });
	const data = await devSampleRaw(pos);                 // dev: feed bundled sample raw
	return await devSend("hotelLive", { pos, data, url: "", adults: query?.adults || 2, nights: query?.nights || 1 }, requestId, pos);
}

// cold path: fetch partner search -> backend match -> matched ids
export async function searchFetch({ pos, target, query, requestId }) {
	if (MODE === "ext") return await callExt("hotelSearchFetch", { pos, target, query, requestId });
	const data = await devSampleRaw(`${pos}_search`);
	return await devSend("hotelSearch", { pos, data, url: "", target }, requestId, pos);
}

export async function finish(requestId) {
	if (MODE === "ext") return await callExt("hotelLiveFinish", { requestId });
	return await devSend("finish", {}, requestId);
}

// Last pass: Skyscanner agents (Expedia / Trip.com / … + affiliate deeplinks) for the same hotel.
export async function skyscanner(target, query, requestId) {
	const payload = {
		name: target.name, lat: target.lat ?? null, lng: target.lng ?? null,
		checkin: query.checkin, checkout: query.checkout,
		adults: query.adults, children: query.children, rooms: query.rooms,
	};
	if (MODE === "ext") return await callExt("hotelSkyscanner", { ...payload, requestId });
	return await devSend("hotelSkyscanner", payload, requestId);
}

// City → hotel LISTING via EMT search (images + prices + ratings + EMT hotel id). The SW runs the
// credentialed EMT call directly and returns normalized cards. Returns { hotels: [...] }.
export async function listHotels({ city, params, name, page, filters, lat, lng, countryCode }) {
	const requestId = `list_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
	const f = filters || {};
	const payload = { city, name: name || "", checkin: params.checkin, checkout: params.checkout,
		rooms: params.rooms, adults: params.adults, children: params.children, childAge: params.child_age, page: page || 1,
		stars: f.stars || [], taRating: f.taRating || [], amenities: f.amenities || [], props: f.props || [],
		minPrice: f.minPrice ?? null, maxPrice: f.maxPrice ?? null, sort: f.sort || "popular", requestId,
		// From the picked suggestion, when EMT's own autosuggest resolved one — the only real disambiguator
		// for a city name that collides across countries (e.g. "dublin": Ireland/US/Australia/Sierra Leone
		// all match with identical relevance; a bare string alone can't tell them apart).
		lat: lat != null ? +lat : null, lng: lng != null ? +lng : null, countryCode: countryCode || null };
	if (MODE === "ext") return await callExt("hotelListFetch", payload);
	return await devSend("hotelList", payload, requestId);
}
