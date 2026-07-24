// Drives one comparison: resolve -> fan out (detail for mapped, search->detail for unmapped) -> stream.
// Callbacks fire as each partner lands so the UI updates live, then onDone after finish.
import { MODE, resolve, liveFetch, searchFetch, finish, skyCompare, skyscanner } from "./bridge.js";

const PROVIDER = { 1288: "mmt", 1294: "goibibo", 1289: "cleartrip", 2255: "easemytrip", 2361: "agoda", 6871: "booking_com" };

export async function runCompare(target, query, { onResolved, onPartner, onDone, onError, onSkyscanner } = {}) {
	const requestId = `search_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const log = (...a) => console.log("%c[orchestrate]", "color:#2ea043", ...a);
	log("runCompare start", { target, requestId });

	// ── Skyscanner mode: one create+poll returns every agent at once (no per-partner fan-out). ──
	if (MODE === "sky") {
		try {
			const r = await skyCompare(target, query);
			log("← skyCompare", r && r.status, "partners:", (r.partners || []).length, "grid:", (r.grid || []).length);
			onResolved && onResolved({
				canonical: r.canonical,
				plan: (r.partners || []).map((p) => ({ pos: p.provider, provider: p.provider, ids: {} })),
			});
			(r.partners || []).forEach((p, i) => onPartner && onPartner({
				pos: p.provider, provider: p.provider, status: "success",
				partner: { min_price: p.min_price, min_stay_total: p.min_stay_total, currency: p.currency, approx: p.approx, deep_link: p.deep_link, rooms: [] },
				grid: i === 0 ? (r.grid || []) : undefined,   // grid is the full set; attach once
			}));
		} catch (e) { log("skyCompare failed", e.message); onError && onError(e); }
		onDone && onDone();
		return;
	}

	let plan;
	try {
		const r = await resolve(target, requestId);
		plan = (r && r.plan) || [];
		// EMT (2255) came from the listing with its hotel id → pre-resolve it (skip its cold search).
		if (target.emt_hotel_id) {
			plan = plan.filter((p) => String(p.pos) !== "2255");
			// EMT detail (GetHotelDescriptionV1) needs the supplier hid + city + name; durl is its deep link.
			plan.unshift({ pos: 2255, step: "detail", ids: { hotel_id: String(target.emt_hotel_id), secondary_id: target.emt_secondary_id || "", city: target.city || "", name: target.name || "", durl: target.emt_durl || "", currency: "INR" } });
		}
		log(`← resolve: ${plan.length} partners`, plan.map((p) => `${p.pos}:${p.step}`).join(" "));
		onResolved && onResolved({ hotel_map_id: r && r.hotel_map_id, canonical: r && r.canonical, plan });
	} catch (e) { log("resolve failed", e.message); onError && onError(e); return; }

	const tasks = plan.map(async (p) => {
		const provider = PROVIDER[p.pos] || `pos_${p.pos}`;
		try {
			let ids = p.ids;
			if (p.step === "search") {
				log(`[${provider}] cold search…`);
				const m = await searchFetch({ pos: p.pos, target, query, requestId });   // cold path
				if (!m || !m.matched) { log(`[${provider}] no search match`); onPartner && onPartner({ pos: p.pos, provider, status: "unmatched" }); return; }
				ids = m.matched.ids;
				log(`[${provider}] matched`, ids);
			}
			log(`[${provider}] liveFetch…`);
			const res = await liveFetch({ pos: p.pos, ids, query, requestId });
			if (res && res.status === "success") {
				log(`[${provider}] ✅ min=${res.partner && res.partner.min_price} rooms=${res.partner && res.partner.rooms.length} grid=${res.grid && res.grid.length}`);
				onPartner && onPartner({ pos: p.pos, provider, status: "success", partner: res.partner, grid: res.grid, hotel: res.hotel, ids });
			} else {
				log(`[${provider}] empty`, res && res.status);
				onPartner && onPartner({ pos: p.pos, provider, status: "empty" });
			}
		} catch (e) {
			log(`[${provider}] error`, e.message);
			onPartner && onPartner({ pos: p.pos, provider, status: "error", error: e.message });
		}
	});

	await Promise.allSettled(tasks);
	let finalHotel;
	try { const done = await finish(requestId); finalHotel = done && done.hotel; } catch {}

	// LAST PASS — Skyscanner agents (best-effort; a failure never affects the compare above).
	try {
		const sky = await skyscanner(target, query, requestId);
		if (sky && Array.isArray(sky.partners) && sky.partners.length) {
			log(`← skyscanner: ${sky.partners.length} agents`);
			onSkyscanner && onSkyscanner(sky.partners);
		}
	} catch (e) { log("skyscanner pass failed", e.message); }

	log("runCompare done");
	onDone && onDone(finalHotel);
}
