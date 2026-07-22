<script>
  import { onMount } from "svelte";
  import { suggest, listHotels, fetchMeta, setHotelAlert, MODE } from "./lib/bridge.js";
  import { runCompare } from "./lib/orchestrate.js";
  import RoomCard from "./lib/RoomCard.svelte";
  import FilterBar from "./lib/FilterBar.svelte";

  const log = (...a) => console.log("%c[app]", "color:#d29922", ...a);
  const PROVIDERS = { 1288: "MakeMyTrip", 1294: "Goibibo", 1289: "Cleartrip", 2255: "EaseMyTrip", 2361: "Agoda", 6871: "Booking.com" };
  const provName = (p) => ({ mmt: "MakeMyTrip", goibibo: "Goibibo", cleartrip: "Cleartrip", easemytrip: "EaseMyTrip", agoda: "Agoda", booking_com: "Booking.com" }[p] || p);
  const PARTNER_LIST = ["MakeMyTrip", "Goibibo", "Cleartrip", "EaseMyTrip", "Agoda", "Booking.com"];

  // ── search box + autosuggest ──
  let query = "", suggestions = [], showSuggest = false, suggestTimer, suggestSeq = 0;
  let source = "emt";           // typeahead engine: emt | mmt | cleartrip (diagnostic toggle)

  // ── stay form ──
  const isoDay = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  let ci = isoDay(1), co = isoDay(2), rooms = 1, adults = 2, children = 0, childAge = "";
  $: nights = Math.max(1, Math.round((new Date(co) - new Date(ci)) / 864e5) || 1);
  $: queryParams = { checkin: ci, checkout: co, rooms: +rooms, adults: +adults, children: +children, child_age: childAge, nights };

  // Quick-pick cities on the homepage → straight into that city's listing.
  const POPULAR_CITIES = ["Bengaluru", "New Delhi", "Mumbai", "Goa", "Jaipur", "Hyderabad", "Chennai", "Kolkata"];

  // ── view + results state ──
  let view = "search";          // search | listing | compare
  let listing = [], listingTitle = "", listingLoading = false, listingSource = null;
  let listingPage = 1, listingHasMore = false, listingLoadingMore = false;
  let selected = null, canonical = null, grid = [];
  let status = "idle";          // idle | resolving | streaming | done
  let partners = {}, planCount = 0, doneCount = 0, runSeq = 0;
  let skyPartners = [];         // Skyscanner last-pass agents (Expedia / Trip.com / … + affiliate deeplinks)
  let planById = {};                          // pos → native ids from resolve (alert payload source)
  let alertMsg = "";                          // transient "alert set ✓" feedback
  const POS_BY_PROV = { mmt: 1288, goibibo: 1294, cleartrip: 1289, easemytrip: 2255, agoda: 2361, booking_com: 6871 };

  // Set a price alert for a specific partner room+meal at the current dates. `prov` = provider key, `c` = the
  // grid cell (room row) with room_id/meal/total, `row` = the room group (name). Gathers everything paAPIs needs.
  async function setAlert(prov, c, row) {
    const pos = POS_BY_PROV[prov]; if (!pos || !c) return;
    const ids = planById[pos] || {};
    const alert = {
      pos, hotel_id: ids.hotel_id || ids.chain_id || "", native_ids: ids,
      room_id: c.room_id || c.room_type || row.room_name, room_name: row.room_name || c.room_type, meal: c.meal,
      checkin: ci, checkout: co, adults, children, rooms, currency: c.currency || "INR",
      cur_price: c.total ?? c.price,
      hotel_name: (canonical && canonical.hotel_name) || (selected && selected.name) || "",
      city: (canonical && canonical.city) || (selected && selected.city) || "",
      image: (canonical && canonical.image) || (selected && selected.image) || "",
      deep_link: c.deep_link || "", hotel_map_id: (canonical && canonical.hotel_map_id) || "",
    };
    try {
      const r = await setHotelAlert(alert);
      alertMsg = r && (r.status === 1 || r.code === 200) ? `Alert set — we'll ping you if ${row.room_name} on ${provName(prov)} drops.` : `Couldn't set alert${r && r.msg ? ": " + r.msg : ""}.`;
    } catch (e) { alertMsg = "Couldn't set alert."; }
    setTimeout(() => (alertMsg = ""), 4000);
  }

  // meal-plan glossary — what each normalized label means + the partner terms that map to it. This is the
  // FALLBACK; on mount we refresh it from the backend over the socket (fetchMeta) so it always tracks the
  // server's current meal buckets. Backend sends terms as arrays → joined with " · " for display.
  let showMealInfo = false;
  let mealGlossary = [
    { label: "Room Only",      terms: "EP · European Plan · No Meal · Self Catering" },
    { label: "With Breakfast", terms: "CP · BP · Continental/Bermuda Plan · Bed & Breakfast · Free Breakfast" },
    { label: "Half Board",     terms: "MAP · Modified American Plan · Breakfast & Dinner · 2 meals" },
    { label: "Full Board",     terms: "AP · American Plan · All Meals · Breakfast + Lunch + Dinner · 3 meals" },
    { label: "All Inclusive",  terms: "AI · All meals + drinks included" },
  ];

  // ── listing filters (all real EMT HotelSearch params) ──
  let fStars = [], fTa = [], fProps = [], fAmen = [], fSort = "popular", fMin = null, fMax = null;
  const filterObj = () => ({ stars: fStars, taRating: fTa, amenities: fAmen, props: fProps, minPrice: fMin, maxPrice: fMax, sort: fSort });

  function onInput() {
    clearTimeout(suggestTimer);
    const q = query.trim();
    // bump the seq on EVERY keystroke so any in-flight suggest for an older query is ignored when it resolves
    const seq = ++suggestSeq;
    if (q.length < 2) { suggestions = []; showSuggest = false; return; }
    suggestTimer = setTimeout(async () => {
      try {
        const res = await suggest(q, source);
        // drop stale responses: a newer keystroke (or a pick/clear) has happened, or the box no longer holds q
        if (seq !== suggestSeq || query.trim() !== q) return;
        suggestions = res; showSuggest = res.length > 0;
      } catch (e) {
        log("suggest failed", e.message);
        if (seq !== suggestSeq) return;
        suggestions = []; showSuggest = false;
      }
    }, 200);
  }

  function pick(s) {
    // kill any pending/in-flight suggest so a late result can't reopen the dropdown or override the pick
    clearTimeout(suggestTimer); suggestSeq++;
    query = s.name; showSuggest = false; suggestions = [];
    if (s.type !== "hotel") { fStars = []; fTa = []; fProps = []; fAmen = []; fSort = "popular"; fMin = null; fMax = null; loadListing(s); return; }
    resolveAndCompare({ name: s.name, city: s.city, lat: s.lat, lng: s.lng, emt_hotel_id: s.emt_hotel_id, entityId: s.entityId });
  }

  // Resolve a hotel (from autosuggest OR a restored URL) to full ids via EMT search by name, then compare.
  // An autosuggest/URL hotel carries only name (+maybe ecid) — EMT search gives hid + geo + durl.
  async function resolveAndCompare({ name, city, lat, lng, emt_hotel_id, entityId }) {
    query = name;
    view = "compare"; status = "resolving"; selected = { name, city, type: "hotel" };
    canonical = null; partners = {}; grid = []; doneCount = 0; planCount = 0;
    // Skyscanner mode: no EMT resolve step — we already hold the entityId, go straight to compare.
    if (MODE === "sky") { selected = { name, city, lat, lng, type: "hotel", entityId }; startCompare(); return; }
    const wantEc = String(emt_hotel_id || "").replace(/^EMTHOTEL-/i, "").toLowerCase();
    let card = null;
    try {
      const r = await listHotels({ city: city || "", params: queryParams, name });
      const hotels = (r && r.hotels) || [];
      // Find the picked hotel in the listing — by emt id, else by name — to enrich it (hid + durl + image).
      card = hotels.find((h) => wantEc && String(h.emt_hotel_id || "").toLowerCase() === wantEc)
        || hotels.find((h) => (h.name || "").toLowerCase().includes(name.toLowerCase().split(",")[0].trim()))
        || null;
    } catch (e) { log("resolve hotel failed", e.message); }
    if (card) {
      selected = { name: card.name, city: city || card.city || "", lat: card.lat, lng: card.lng, type: "hotel",
        emt_hotel_id: card.emt_hotel_id, emt_secondary_id: card.emt_secondary_id, emt_durl: card.durl,
        image: card.image, address: card.address, rating: card.rating };
      startCompare();
    } else {
      // Couldn't confidently identify the picked hotel in the listing → show the SEARCH RESULTS so the user
      // picks the right one. NEVER guess (a blind hotels[0] fallback silently compared a different property).
      log("hotel not found in listing → showing search results for", city || name);
      loadListing({ name, city, type: "hotel" });
    }
  }

  // city → hotel LISTING via EMT search (real images/prices/ratings + EMT hotel id + filters)
  async function loadListing(s) {
    listingSource = s;
    view = "listing"; listing = []; listingLoading = true; listingTitle = s.city || s.name; listingPage = 1; listingHasMore = false;
    syncHash();
    try {
      const r = await listHotels({ city: s.city || s.name, params: queryParams, name: s.type === "hotel" ? s.name : "", page: 1, filters: filterObj() });
      listing = (r && r.hotels) || [];
      // Optimistic: as long as page 1 returned hotels, probe for more on scroll. loadMore stops the moment a
      // page adds nothing new — so this works whether EMT paginates, caps its page size, or is a small city.
      listingHasMore = listing.length > 0;
    } catch (e) { log("listing failed", e.message); listing = []; }
    listingLoading = false;
  }

  async function loadMore() {
    if (listingLoadingMore || !listingHasMore || !listingSource) return;
    listingLoadingMore = true;
    const next = listingPage + 1, s = listingSource;
    try {
      const r = await listHotels({ city: s.city || s.name, params: queryParams, name: s.type === "hotel" ? s.name : "", page: next, filters: filterObj() });
      const more = (r && r.hotels) || [];
      const seen = new Set(listing.map((h) => h.emt_hotel_id || h.name));
      const added = more.filter((h) => !seen.has(h.emt_hotel_id || h.name));
      listing = [...listing, ...added];
      listingPage = next;
      // Stop when a page brings nothing new (EMT exhausted or repeated the same page). Soft cap as a safety net.
      listingHasMore = added.length > 0 && next < 25;
    } catch (e) { log("loadMore failed", e.message); }
    listingLoadingMore = false;
  }

  // filter change → adopt the values from the event (FilterBar's bind hasn't flushed yet), re-fetch page 1.
  // NOTE: the listing engine is ALWAYS EMT (HotelListIdWiseNew) — these are its native server-side filters.
  // The EMT|MMT toggle only affects the typeahead; MMT has no rich city listing.
  function applyFilters(e) {
    if (e && e.detail) { const d = e.detail; fStars = d.stars; fTa = d.taRating; fProps = d.props; fAmen = d.amenities; fSort = d.sort; fMin = d.minPrice; fMax = d.maxPrice; }
    if (listingSource) loadListing(listingSource);
  }

  function onWindowScroll() {
    if (view !== "listing" || listingLoadingMore || !listingHasMore) return;
    const doc = document.documentElement;
    if (window.innerHeight + window.scrollY >= doc.scrollHeight - 900) loadMore();
  }

  // If client-side filters hide most of a fetched page, the page is too short to scroll → infinite scroll
  // never fires. Auto-pull the next page until we have enough to fill the viewport (or run out).
  $: if (view === "listing" && !listingLoading && !listingLoadingMore && listingHasMore
        && displayedListing.length < 8 && listing.length) loadMore();

  function pickHotel(card) {
    selected = { name: card.name, city: listingTitle, lat: card.lat, lng: card.lng, type: "hotel",
      emt_hotel_id: card.emt_hotel_id, emt_secondary_id: card.emt_secondary_id, emt_durl: card.durl,
      image: card.image, address: card.address, rating: card.rating };
    query = card.name; view = "compare"; startCompare();
  }

  function startCompare() {
    if (!selected) return;
    // Skyscanner mode needs an entityId to compare — a name/city-only trigger (e.g. hash restore) can't
    // resolve one, so bail without wiping the current results or firing an empty /compare (was a 400).
    if (MODE === "sky" && !selected.entityId) return;
    syncHash();
    const s = selected, myRun = ++runSeq;
    canonical = null; partners = {}; grid = []; skyPartners = []; doneCount = 0; planCount = 0; status = "resolving";
    const target = { name: s.name, city: s.city, lat: s.lat != null ? +s.lat : null, lng: s.lng != null ? +s.lng : null,
      emt_hotel_id: s.emt_hotel_id || null, emt_secondary_id: s.emt_secondary_id || null, emt_durl: s.emt_durl || null,
      entityId: s.entityId || null };
    const stale = () => myRun !== runSeq;
    runCompare(target, queryParams, {
      onResolved: ({ canonical: c, plan }) => {
        if (stale()) return;
        canonical = c; planCount = plan.length;
        planById = {}; for (const p of plan) planById[p.pos] = p.ids || {};   // pos → native ids (for alerts)
        for (const p of plan) partners[PROVIDERS[p.pos] || `pos_${p.pos}`] = { status: "pending" };
        partners = partners; status = "streaming";
      },
      onPartner: (r) => {
        if (stale()) return;
        partners[PROVIDERS[r.pos] || provName(r.provider)] = {
          status: r.status, min_price: r.partner ? r.partner.min_price : null,
          min_stay_total: r.partner ? r.partner.min_stay_total : null,
          currency: r.partner ? r.partner.currency : "INR", approx: r.partner ? r.partner.approx : false,
          deepLink: r.partner ? r.partner.deep_link : null,
        };
        partners = partners;
        if (r.grid && r.grid.length) grid = r.grid;
        doneCount += 1;
      },
      onDone: () => { if (stale()) return; status = "done"; },
      onError: () => { if (stale()) return; status = "done"; },
      onSkyscanner: (rows) => { if (stale()) return; skyPartners = rows; },
    });
  }

  function applyStay() {
    if (view === "listing" && listingSource) { syncHash(); loadListing(listingSource); }
    else if (view === "compare" && selected) { syncHash(); startCompare(); }
  }
  function goHome() { selected = null; status = "idle"; view = "search"; listing = []; query = ""; setHash(""); }
  // Compare "back" → always the hotel's CITY listing (the "middle" route). Even for a hotel picked directly
  // from search (no listing loaded yet), this loads the city listing rather than dumping to the home page.
  function backToListing() {
    const city = (selected && selected.city) || listingTitle;
    if (city) loadListing({ city, name: city, type: "city" });
    else goHome();
  }

  // ── dark mode ──
  let dark = false;
  function toggleDark() { dark = !dark; document.documentElement.classList.toggle("dark", dark); try { localStorage.setItem("hc_dark", dark ? "1" : "0"); } catch (e) {} }

  // ── hash routing (SPA, reload-safe) — #/hotels/<city>?ci=..&co=.. and #/hotel/<name>/<city>?... ──
  let restoring = false;
  const stayQS = () => `?${new URLSearchParams({ ci, co, r: rooms, a: adults, c: children, ...(childAge ? { ch: childAge } : {}) })}`;
  function setHash(h) { restoring = true; if (location.hash !== h) location.hash = h; setTimeout(() => (restoring = false), 0); }
  function syncHash() {
    if (MODE === "sky") return;   // no deep-link/hash restore in the Skyscanner eval tool (needs an entityId we can't recover from a name)
    if (view === "listing" && listingSource) setHash(`#/hotels/${encodeURIComponent(listingSource.city || listingSource.name)}${stayQS()}`);
    else if (view === "compare" && selected) setHash(`#/hotel/${encodeURIComponent(selected.name)}/${encodeURIComponent(selected.city || "")}${stayQS()}`);
    else setHash("");
  }
  function readStayQS(qs) {
    const p = new URLSearchParams(qs || "");
    if (p.get("ci")) ci = p.get("ci"); if (p.get("co")) co = p.get("co");
    if (p.get("r")) rooms = +p.get("r"); if (p.get("a")) adults = +p.get("a");
    if (p.get("c")) children = +p.get("c"); if (p.get("ch")) childAge = p.get("ch");
  }
  async function restoreFromHash() {
    const [path, qs] = location.hash.replace(/^#/, "").split("?");
    const parts = path.split("/").filter(Boolean);
    readStayQS(qs);
    if (parts[0] === "hotels" && parts[1]) {
      const city = decodeURIComponent(parts[1]);
      loadListing({ city, name: city, type: "city" });
    } else if (parts[0] === "hotel" && parts[1]) {
      await resolveAndCompare({ name: decodeURIComponent(parts[1]), city: parts[2] ? decodeURIComponent(parts[2]) : "" });
    } else {
      view = "search";
    }
  }
  onMount(() => {
    try { if (localStorage.getItem("hc_dark") === "1") { dark = true; document.documentElement.classList.add("dark"); } } catch (e) {}
    if (location.hash.length > 2) restoreFromHash();
    const onHash = () => { if (!restoring) restoreFromHash(); };
    window.addEventListener("hashchange", onHash);
    // refresh the meal-plan glossary from the backend (socket) — keeps the info tab in sync with mealLabel.
    fetchMeta().then((r) => {
      const g = r && r.mealGlossary;
      if (Array.isArray(g) && g.length) mealGlossary = g.map((m) => ({ label: m.label, terms: Array.isArray(m.terms) ? m.terms.join(" · ") : m.terms }));
    }).catch(() => {});
    return () => window.removeEventListener("hashchange", onHash);
  });

  // ── listing: CLIENT-SIDE enforcement of price/star/sort over the accumulated cards ──
  // EMT's server-side HotelSearch filtering is unreliable from our context (token/auth), so we also apply
  // price + star + sort here on the cards we DO have (every card carries price + star rating). This
  // guarantees the visible results respect the filters regardless of what the API honored. Guest-rating /
  // property / amenities can't be enforced client-side (not on the card) — those stay server-side best-effort.
  $: displayedListing = (() => {
    let out = listing;
    if (fMin != null && fMin !== "") out = out.filter((h) => h.price != null && +h.price >= +fMin);
    if (fMax != null && fMax !== "") out = out.filter((h) => h.price != null && +h.price <= +fMax);
    if (fStars.length) { const s = new Set(fStars.map(Number)); out = out.filter((h) => h.rating != null && s.has(Math.round(+h.rating))); }
    if (fSort === "price_asc") out = [...out].sort((a, b) => (a.price ?? 1e12) - (b.price ?? 1e12));
    else if (fSort === "price_desc") out = [...out].sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
    else if (fSort === "rating") out = [...out].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    return out;
  })();

  // ── compare: per-partner strip (live prices only) ──
  $: merged = PARTNER_LIST.map((who) => {
    const live = partners[who];
    if (live && live.min_price != null) return { who, val: live.min_price, stay: live.min_stay_total ?? (live.min_price * nights), approx: live.approx, src: "live", deepLink: live.deepLink };
    return { who, val: null, stay: null, src: null, status: live ? live.status : null };
  });
  $: best = merged.filter((m) => m.val != null).sort((a, b) => a.val - b.val)[0] || null;

  // ── compare: grid → room CARDS (grouped by room signature, meals within, partners cheapest-first) ──
  const MEAL_ORDER = { "Room Only": 0, "Breakfast": 1, "Half Board": 2, "Full Board": 3, "All Inclusive": 4 };
  const stayOf = (c) => (c && (c.stay_total != null ? c.stay_total : (c.total != null ? c.total * (c.nights || nights) : null)));
  $: roomCards = (() => {
    const bySig = new Map();
    for (const row of grid || []) {
      const key = row.sig || row.room_class;
      if (!bySig.has(key)) bySig.set(key, { sig: key, room_name: row.room_name || row.room_class, room_class: row.room_class, meals: [] });
      const cardObj = bySig.get(key);
      if (row.room_name && row.room_name.length > (cardObj.room_name || "").length) cardObj.room_name = row.room_name;
      const parts = [];
      for (const [prov, c] of Object.entries(row.byPartner || {})) {
        const stay = stayOf(c); if (stay == null) continue;
        parts.push({ who: provName(prov), prov, price: c.total ?? c.price, base: c.price, tax: c.tax, stay, approx: prov === "agoda" || !!c.approx, deepLink: c.deep_link || partners[provName(prov)]?.deepLink });
      }
      if (!parts.length) continue;
      parts.sort((a, b) => a.stay - b.stay);
      cardObj.meals.push({ meal: row.meal, partners: parts, min: parts[0].stay });
    }
    const cards = [...bySig.values()];
    for (const c of cards) { c.meals.sort((a, b) => (MEAL_ORDER[a.meal] ?? 9) - (MEAL_ORDER[b.meal] ?? 9)); c.min = Math.min(...c.meals.map((m) => m.min)); }
    cards.sort((a, b) => a.min - b.min);
    return cards;
  })();

  // The full comparison MATRIX (room × partner), shown below the cards. Same sig|meal grouping, sorted so
  // a room's rows sit together, cheapest-first.
  $: gridProviders = grid.length ? [...new Set(grid.flatMap((row) => Object.keys(row.byPartner)))] : [];
  $: sortedGrid = (() => {
    const rows = (grid || []).map((r) => ({ ...r, _min: Math.min(Infinity, ...Object.values(r.byPartner || {}).map(stayOf).filter((v) => v != null)) }));
    const sigMin = {};
    for (const r of rows) { const k = r.sig || r.room_class; sigMin[k] = Math.min(sigMin[k] ?? Infinity, r._min); }
    return rows.sort((a, b) => {
      const ka = a.sig || a.room_class, kb = b.sig || b.room_class;
      return (sigMin[ka] - sigMin[kb]) || ka.localeCompare(kb) || ((MEAL_ORDER[a.meal] ?? 9) - (MEAL_ORDER[b.meal] ?? 9)) || (a._min - b._min);
    });
  })();

  const inr = (v) => (v == null ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));
  const ICONS = {
    hotel: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15"/><path d="M14 9h6a1 1 0 0 1 1 1v11"/><path d="M2 21h20"/><path d="M6 9h.01M9.5 9h.01M6 12.5h.01M9.5 12.5h.01M6 16h.01M9.5 16h.01M17.5 13h.01M17.5 16.5h.01"/></svg>`,
    city: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V9l6-4v16"/><path d="M9 21V3l6 3v15"/><path d="M15 21v-9l6 3v6"/><path d="M2 21h20"/></svg>`,
    place: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.686-6-10a6 6 0 0 1 12 0c0 4.314-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>`,
  };
  const icon = (t) => ICONS[t] || (["region","area","locality","city"].includes(t) ? ICONS.city : ICONS.place);
</script>

<svelte:window on:scroll={onWindowScroll} />

<header class="topbar">
  <a href="/" class="logo" on:click|preventDefault={goHome}>Hotel<span class="accent">Compare</span></a>
  <span class="tagline">Find the cheapest price. Every time.</span>
  <button class="dark-toggle" on:click={toggleDark} title="Toggle dark mode" aria-label="Toggle dark mode">{dark ? "☀︎" : "☾"}</button>
  <span class="mode">mode: {MODE === "ext" ? "extension" : MODE === "sky" ? "skyscanner" : "dev"}</span>
</header>

<main>
  <!-- ── Sticky stay bar (listing + compare) ── -->
  {#if view !== "search"}
    <div class="stay-bar">
      <div class="sf"><label>Check-in</label><input type="date" bind:value={ci} /></div>
      <div class="sf"><label>Check-out</label><input type="date" bind:value={co} /></div>
      <div class="sf"><label>Rooms</label><select bind:value={rooms}>{#each [1,2,3,4,5] as n}<option value={n}>{n}</option>{/each}</select></div>
      <div class="sf"><label>Adults</label><select bind:value={adults}>{#each [1,2,3,4,5,6] as n}<option value={n}>{n}</option>{/each}</select></div>
      <div class="sf"><label>Children</label><select bind:value={children}>{#each [0,1,2,3,4] as n}<option value={n}>{n}</option>{/each}</select></div>
      {#if +children > 0}<div class="sf"><label>Child ages</label><input type="text" placeholder="5,8" bind:value={childAge} /></div>{/if}
      <span class="sf-nights">{nights} night{nights > 1 ? "s" : ""}</span>
      <button class="btn-primary" on:click={applyStay}>Update</button>
    </div>
  {/if}

  <!-- ── SEARCH ── -->
  {#if view === "search"}
    <section class="hero">
      <h1>Find the <span class="hl">best hotel price</span></h1>
      <p class="hero-sub">One search, live prices across MakeMyTrip, Goibibo, Cleartrip, Agoda, Booking.com &amp; EaseMyTrip.</p>

      <div class="search-panel">
        <div class="source-toggle">
          <button class:on={source === "emt"} on:click={() => { source = "emt"; if (query.length >= 2) onInput(); }}>EaseMyTrip</button>
          <button class:on={source === "mmt"} on:click={() => { source = "mmt"; if (query.length >= 2) onInput(); }}>MakeMyTrip</button>
          <button class:on={source === "cleartrip"} on:click={() => { source = "cleartrip"; if (query.length >= 2) onInput(); }}>Cleartrip</button>
        </div>
        <div class="search-input">
          <span class="search-ic">{@html icon("place")}</span>
          <input type="text" autocomplete="off" placeholder="Search a city or hotel…"
            bind:value={query} on:input={onInput} on:focus={() => (showSuggest = suggestions.length > 0)}
            on:blur={() => setTimeout(() => (showSuggest = false), 150)} />
          {#if showSuggest}
            <div class="dropdown">
              {#each suggestions as s}
                <button class="ac-item" on:click={() => pick(s)}>
                  <span class="ac-ic">{@html icon(s.type)}</span>
                  <span class="ac-text"><span class="ac-name">{s.name}</span>{#if s.subtext || s.city}<span class="ac-sub">{s.subtext || s.city}</span>{/if}</span>
                  {#if s.type}<span class="ac-badge">{s.type}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <div class="city-chips">
          <span class="city-chips-lbl">Popular</span>
          {#each POPULAR_CITIES as c}
            <button type="button" class="city-chip" on:click={() => pick({ name: c, city: c, type: "city" })}>{c}</button>
          {/each}
        </div>
        <div class="stay-row">
          <div class="sf"><label>Check-in</label><input type="date" bind:value={ci} /></div>
          <div class="sf"><label>Check-out</label><input type="date" bind:value={co} /></div>
          <div class="sf"><label>Rooms</label><select bind:value={rooms}>{#each [1,2,3,4,5] as n}<option value={n}>{n}</option>{/each}</select></div>
          <div class="sf"><label>Adults</label><select bind:value={adults}>{#each [1,2,3,4,5,6] as n}<option value={n}>{n}</option>{/each}</select></div>
          <div class="sf"><label>Children</label><select bind:value={children}>{#each [0,1,2,3,4] as n}<option value={n}>{n}</option>{/each}</select></div>
        </div>
      </div>
    </section>
  {/if}

  <!-- ── LISTING ── -->
  {#if view === "listing"}
    <section class="page">
      <button class="back" on:click={goHome}>&larr; New search</button>
      <div class="listhead">
        <h2 class="page-title">Hotels in {listingTitle}</h2>
        <div class="listsearch">
          <span class="search-ic">{@html icon("place")}</span>
          <input type="text" autocomplete="off" placeholder="Search another city or hotel…"
            bind:value={query} on:input={onInput} on:focus={() => (showSuggest = suggestions.length > 0)}
            on:blur={() => setTimeout(() => (showSuggest = false), 150)} />
          {#if showSuggest}
            <div class="dropdown">
              {#each suggestions as s}
                <button class="ac-item" on:click={() => pick(s)}>
                  <span class="ac-ic">{@html icon(s.type)}</span>
                  <span class="ac-text"><span class="ac-name">{s.name}</span>{#if s.subtext || s.city}<span class="ac-sub">{s.subtext || s.city}</span>{/if}</span>
                  {#if s.type}<span class="ac-badge">{s.type}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="listing-layout">
        <FilterBar bind:stars={fStars} bind:taRating={fTa} bind:props={fProps} bind:amenities={fAmen} bind:sort={fSort} bind:minPrice={fMin} bind:maxPrice={fMax} on:change={applyFilters} />
        <div class="listing-main">
          {#if listingLoading}
            <div class="hotel-grid">{#each Array(6) as _}<div class="hotel-skel"></div>{/each}</div>
          {:else if displayedListing.length}
            <div class="hotel-grid">
              {#each displayedListing as h}
                <button class="hotel-card" on:click={() => pickHotel(h)}>
                  <div class="hc-img">{#if h.image}<img src={h.image} alt={h.name} loading="lazy" />{:else}<span class="hc-noimg">{@html icon("hotel")}</span>{/if}</div>
                  <div class="hc-body">
                    <div class="hc-title"><h3>{h.name}</h3>{#if h.rating}<span class="hc-rating">{h.rating}★</span>{/if}</div>
                    {#if h.address}<p class="hc-addr">{h.address}</p>{/if}
                  </div>
                  <div class="hc-price">
                    {#if h.price}<span class="hc-amt">{inr(h.price)}</span><span class="hc-per">from · per night</span>{:else}<span class="hc-compare">Compare →</span>{/if}
                  </div>
                </button>
              {/each}
            </div>
            {#if listingLoadingMore}<div class="loading-more">Loading more…</div>
            {:else if listingHasMore}<button class="load-more" on:click={loadMore}>Show more hotels</button>{/if}
          {:else}
            <div class="empty">
              No hotels on this page match these filters.
              {#if listingHasMore}<button class="load-more" on:click={loadMore}>Load more to keep looking</button>{:else}Try widening them.{/if}
            </div>
          {/if}
        </div>
      </div>
    </section>
  {/if}

  <!-- ── COMPARE ── -->
  {#if view === "compare" && selected}
    <section class="page">
      <button class="back" on:click={backToListing}>&larr; Back to hotels</button>

      <div class="hotel-head">
        {#if selected.image}<img class="hh-img" src={selected.image} alt={selected.name} />{/if}
        <div class="hh-info">
          <h2>{selected.name || canonical?.hotel_name}</h2>
          <p class="hh-addr">{[canonical?.city || selected.city, canonical?.address || selected.address].filter(Boolean).join(" · ")}</p>
          <div class="hh-meta">
            {#if canonical?.star}<span class="hh-stars">{"★".repeat(canonical?.star || 0)}</span>{/if}
            {#if selected.rating}<span class="hh-rev">{selected.rating} ★</span>{/if}
          </div>
        </div>
        {#if best}<div class="hh-best"><span class="hh-best-lbl">Best price</span><span class="hh-best-val">{inr(best.val)}{best.approx ? "~" : ""}</span><span class="hh-best-src">on {provName(best.who)} · /night</span></div>{/if}
      </div>

      <!-- partner strip -->
      <div class="strip-head"><h3>Price Comparison</h3><span class="muted">per night · {nights} night{nights > 1 ? "s" : ""} stay</span></div>
      <div class="strip">
        {#each merged as m}
          <a class="pcard" class:best={best && best.who === m.who} href={m.deepLink || "#"} target={m.deepLink ? "_blank" : null} rel="noopener" class:nolink={!m.deepLink}>
            <div class="pcard-who">{m.who}</div>
            {#if m.val != null}
              <div class="pcard-amt">{inr(m.val)}{#if m.approx}<span class="usd-star" title="Approximate — Agoda prices are converted from USD at the current rate">*</span>{/if}<small>/night</small></div>
              {#if m.stay != null}<div class="pcard-total">{inr(m.stay)} total</div>{/if}
              <div class="pcard-src live">live</div>
            {:else}
              <div class="pcard-amt muted">{m.status === "pending" ? "…" : "—"}</div>
            {/if}
          </a>
        {/each}
      </div>
      <div class="status-line">
        {#if status === "resolving"}Resolving partners…
        {:else if status === "streaming"}Fetching live prices… {doneCount}/{planCount}
        {:else if status === "done"}Done — {doneCount}/{planCount} partners
        {/if}
      </div>

      <!-- Skyscanner last pass -->
      {#if skyPartners.length}
        <div class="strip-head rooms-head"><h3>Also on Skyscanner</h3><span class="muted">per night · incl. taxes · affiliate links</span></div>
        <div class="strip">
          {#each skyPartners as a}
            <a class="pcard" href={a.deep_link || "#"} target={a.deep_link ? "_blank" : null} rel="noopener noreferrer" class:nolink={!a.deep_link}>
              <div class="pcard-who">{#if a.logoUrl}<img src={a.logoUrl} alt="" style="height:16px;vertical-align:-3px;margin-right:5px" />{/if}{a.agent}</div>
              <div class="pcard-amt">{inr(a.total)}<small>/night</small></div>
              {#if a.stay_total != null}<div class="pcard-total">{inr(a.stay_total)} total</div>{/if}
              <div class="pcard-src">via Skyscanner</div>
            </a>
          {/each}
        </div>
      {/if}

      <!-- room cards -->
      {#if roomCards.length}
        <div class="strip-head rooms-head">
          <h3>Same room, every platform</h3>
          <span class="muted">totals for {nights} night{nights > 1 ? "s" : ""} · cheapest highlighted</span>
          <button class="meal-info-btn" on:click={() => (showMealInfo = !showMealInfo)} aria-expanded={showMealInfo} title="What do the meal plans mean?">ⓘ meal plans</button>
        </div>
        {#if showMealInfo}
          <div class="meal-legend">
            <div class="meal-legend-head">Meal plans — how partner terms map to our labels</div>
            {#each mealGlossary as m}
              <div class="meal-legend-row"><span class="ml-label">{m.label}</span><span class="ml-terms">{m.terms}</span></div>
            {/each}
          </div>
        {/if}
        <div class="room-grid">
          {#each roomCards as room (room.sig)}<RoomCard {room} {nights} />{/each}
        </div>

        <!-- full comparison matrix (room × partner) -->
        <div class="strip-head rooms-head"><h3>Full price matrix</h3><span class="muted">totals for {nights} night{nights > 1 ? "s" : ""} · cheapest highlighted · per-night + tax below</span></div>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead><tr><th class="rt-col">Room type</th>{#each gridProviders as p}<th>{provName(p)}</th>{/each}</tr></thead>
            <tbody>
              {#each sortedGrid as row}
                {@const minS = Math.min(Infinity, ...gridProviders.map((p) => stayOf(row.byPartner[p])).filter((v) => v != null))}
                <tr>
                  <td class="rt-col">{row.room_name || row.room_class} <small>· {row.meal}</small></td>
                  {#each gridProviders as p}
                    {@const c = row.byPartner[p]}
                    {@const dl = (c && c.deep_link) || partners[provName(p)]?.deepLink}
                    {@const st = stayOf(c)}
                    <td class="mcell" class:cheapest={st != null && st === minS}>
                      {#if st != null}
                        <span class="mval">{inr(st)}</span>{#if dl}<a class="mgo" href={dl} target="_blank" rel="noopener" title="Book on {provName(p)}">↗</a>{/if}<button class="mbell" title="Set price alert on {provName(p)} · {row.room_name} · {c.meal}" on:click={() => setAlert(p, c, row)}>🔔</button>
                        <div class="mbreak">{#if c.tax}{inr(c.price)} + {inr(c.tax)} tax{:else}{inr(c.total ?? c.price)}{/if} /night{#if (c.nights || nights) > 1} × {c.nights || nights}n{/if}</div>
                      {:else}—{/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

    </section>
  {/if}

  {#if alertMsg}<div class="alert-toast">{alertMsg}</div>{/if}
</main>

{#if view !== "search"}
  <footer class="footer">{MODE === "sky" ? "Powered by Skyscanner Hotels API · live prices across Agoda, Booking.com, Goibibo, Expedia, Yatra, Vio.com" : "Powered by EaseMyTrip · live partner prices via the BuyHatke extension"}</footer>
{/if}

<style>
  :global(body) { margin: 0; background: #f6f4ef; color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 1180px; margin: 0 auto; padding: 24px 20px 60px; }

  .dark-toggle { margin-left: auto; background: #f2f2f2; border: 1px solid #ececec; border-radius: 9px; width: 34px; height: 34px; font-size: 15px; cursor: pointer; color: #444; }
  .dark-toggle:hover { border-color: #f5a623; }
  .topbar .mode { margin-left: 12px; }

  /* ── DARK MODE — overrides on <html.dark>; covers body + all card surfaces, text, inputs, borders ── */
  :global(html.dark body) { background: #0f141b; color: #e6e9ee; }
  :global(html.dark) .topbar { background: #161c25; border-bottom-color: #232b36; }
  :global(html.dark) .logo { color: #e6e9ee; }
  :global(html.dark) .dark-toggle { background: #232b36; border-color: #2c3543; color: #e6e9ee; }
  :global(html.dark) .stay-bar,
  :global(html.dark) .search-panel,
  :global(html.dark) .hotel-card,
  :global(html.dark) .hotel-head,
  :global(html.dark) .pcard,
  :global(html.dark) .matrix-wrap,
  :global(html.dark) .google-offers,
  :global(html.dark) .offer,
  :global(html.dark) :global(.rail),
  :global(html.dark) :global(.room-card),
  :global(html.dark) :global(.filters) { background: #161c25; border-color: #232b36; }
  :global(html.dark) .hero h1,
  :global(html.dark) .page-title,
  :global(html.dark) .hc-title h3,
  :global(html.dark) .hh-info h2,
  :global(html.dark) .strip-head h3,
  :global(html.dark) .pcard-amt,
  :global(html.dark) .hc-amt,
  :global(html.dark) :global(.room-head h4) { color: #e6e9ee; }
  :global(html.dark) .sf input, :global(html.dark) .sf select,
  :global(html.dark) .search-input,
  :global(html.dark) :global(.price-inputs input), :global(html.dark) :global(.sort),
  :global(html.dark) :global(.chip), :global(html.dark) :global(.pstep) { background: #1d2430; border-color: #2c3543; color: #e6e9ee; }
  :global(html.dark) .search-input input { color: #e6e9ee; }
  :global(html.dark) .dropdown { background: #1d2430; border-color: #2c3543; }
  :global(html.dark) .ac-item:hover, :global(html.dark) .pcard:hover { background: #232b36; }
  :global(html.dark) .ac-name, :global(html.dark) :global(.check), :global(html.dark) .offer-who, :global(html.dark) .offer-amt { color: #e6e9ee; }
  :global(html.dark) .source-toggle { background: #232b36; }
  :global(html.dark) .source-toggle button.on { background: #0f141b; }
  :global(html.dark) .hc-img, :global(html.dark) :global(.room-head) { background: #1d2430; }
  :global(html.dark) :global(.room-card .prow:hover) { background: #232b36; }
  :global(html.dark) .matrix thead th { background: #0b1baa00; background: #0d1220; }
  :global(html.dark) .matrix .rt-col, :global(html.dark) .matrix thead .rt-col { background: #161c25; }
  :global(html.dark) .matrix tbody td { border-top-color: #232b36; }
  :global(html.dark) .mcell, :global(html.dark) .matrix .rt-col { color: #e6e9ee; }

  /* topbar */
  .topbar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 16px; background: #fff; border-bottom: 1px solid #ececec; padding: 14px 24px; }
  .logo { font-size: 20px; font-weight: 800; color: #1a1a1a; text-decoration: none; letter-spacing: -.4px; }
  .logo .accent { color: #f5a623; }
  .tagline { color: #8b97a7; font-size: 14px; }
  .mode { margin-left: auto; color: #b8c0cc; font-size: 12px; }

  /* buttons */
  .btn-primary { background: #f5a623; color: #1a1a1a; font-weight: 700; font-size: 14px; border: none; border-radius: 10px; padding: 10px 24px; cursor: pointer; }
  .btn-primary:hover { background: #e69512; }
  .back { background: none; border: none; color: #2f6fed; font-size: 14px; font-weight: 600; cursor: pointer; padding: 4px 0; margin-bottom: 12px; }
  .back:hover { text-decoration: underline; }
  .muted { color: #8b97a7; font-size: 13px; }

  /* sticky stay bar */
  .stay-bar { position: sticky; top: 62px; z-index: 20; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; background: #fff; border: 1px solid #ececec; border-radius: 14px; padding: 12px 16px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,.04); }
  .sf { display: flex; flex-direction: column; gap: 4px; }
  .sf label { font-size: 11px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: #8b97a7; }
  .sf input, .sf select { font-size: 14px; padding: 8px 10px; border: 1px solid #dcdcdc; border-radius: 8px; background: #fafafa; color: #1a1a1a; min-width: 96px; }
  .sf input:focus, .sf select:focus { outline: none; border-color: #f5a623; background: #fff; }
  .sf-nights { align-self: center; color: #666; font-size: 13px; font-weight: 600; }
  .stay-bar .btn-primary { margin-left: auto; }

  /* hero / search */
  .hero { text-align: center; padding: 40px 0 10px; }
  .hero h1 { font-size: 40px; font-weight: 800; letter-spacing: -1px; margin: 0 0 10px; }
  .hero .hl { color: #f5a623; }
  .hero-sub { color: #6b7280; font-size: 16px; margin: 0 0 28px; }
  .search-panel { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #ececec; border-radius: 18px; padding: 20px; box-shadow: 0 8px 30px rgba(0,0,0,.06); }
  .source-toggle { display: inline-flex; background: #f2f2f2; border-radius: 10px; padding: 3px; margin-bottom: 14px; }
  .source-toggle button { border: none; background: none; font-size: 13px; font-weight: 700; color: #8b97a7; padding: 7px 18px; border-radius: 8px; cursor: pointer; }
  .source-toggle button.on { background: #fff; color: #1a1a1a; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .search-input { position: relative; display: flex; align-items: center; gap: 10px; border: 2px solid #ececec; border-radius: 12px; padding: 0 14px; background: #fafafa; }
  .search-input:focus-within { border-color: #f5a623; background: #fff; }
  .search-ic { color: #b8c0cc; display: flex; }
  .search-input input { flex: 1; border: none; background: none; font-size: 16px; padding: 15px 0; outline: none; color: #1a1a1a; }
  .dropdown { position: absolute; top: calc(100% + 6px); left: 0; right: 0; background: #fff; border: 1px solid #ececec; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.12); z-index: 40; overflow: hidden; max-height: 340px; overflow-y: auto; text-align: left; }
  .ac-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 11px 16px; border: none; background: none; cursor: pointer; text-align: left; }
  .ac-item:hover { background: #f7f9ff; }
  .ac-ic { color: #8b97a7; display: flex; }
  .ac-text { display: flex; flex-direction: column; flex: 1; }
  .ac-name { font-size: 14px; font-weight: 600; color: #1a1a1a; }
  .ac-sub { font-size: 12px; color: #9aa4b2; }
  .ac-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #8b97a7; background: #f2f2f2; border-radius: 6px; padding: 2px 7px; }
  .city-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
  .city-chips-lbl { font-size: 12px; font-weight: 600; color: #9a9a9a; text-transform: uppercase; letter-spacing: .04em; margin-right: 2px; }
  .city-chip { border: 1px solid #ececec; background: #fafafa; color: #333; font-size: 13px; font-weight: 600; padding: 6px 14px; border-radius: 999px; cursor: pointer; transition: all .15s; }
  .city-chip:hover { border-color: #f5a623; background: #fff7ec; color: #d17c00; }
  .stay-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 14px; }
  .stay-row .sf input, .stay-row .sf select { min-width: 0; width: 100%; box-sizing: border-box; }

  /* page containers */
  .page-title { font-size: 24px; font-weight: 800; margin: 4px 0 16px; }

  /* listing header: title left, compact search right */
  .listhead { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 16px; }
  .listhead .page-title { margin: 4px 0; }
  .listsearch { position: relative; display: flex; align-items: center; gap: 8px; border: 2px solid #ececec; border-radius: 12px; padding: 0 12px; background: #fafafa; min-width: 320px; flex: 0 1 420px; }
  .listsearch input { flex: 1; border: 0; outline: none; background: transparent; padding: 11px 0; font-size: 15px; color: inherit; }
  :global(html.dark) .listsearch { background: #1d2430; border-color: #2c3543; }
  @media (max-width: 640px) { .listsearch { min-width: 0; width: 100%; flex-basis: 100%; } }

  /* listing two-column */
  .listing-layout { display: grid; grid-template-columns: 260px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 860px) { .listing-layout { grid-template-columns: 1fr; } .listing-layout :global(.rail) { position: static; } }

  /* hotel listing grid */
  .hotel-grid { display: flex; flex-direction: column; gap: 12px; }
  .hotel-card { display: grid; grid-template-columns: 180px 1fr auto; gap: 18px; align-items: center; width: 100%; text-align: left; background: #fff; border: 1px solid #ececec; border-radius: 14px; padding: 12px; cursor: pointer; transition: box-shadow .12s, border-color .12s; }
  .hotel-card:hover { border-color: #f5a623; box-shadow: 0 6px 20px rgba(0,0,0,.07); }
  .hc-img { width: 180px; height: 120px; border-radius: 10px; overflow: hidden; background: #f2f2f2; display: flex; align-items: center; justify-content: center; }
  .hc-img img { width: 100%; height: 100%; object-fit: cover; }
  .hc-noimg { color: #c8ced6; display: flex; }
  .hc-noimg :global(svg) { width: 40px; height: 40px; }
  .hc-body { min-width: 0; }
  .hc-title { display: flex; align-items: center; gap: 10px; }
  .hc-title h3 { margin: 0; font-size: 17px; font-weight: 700; color: #1a1a1a; }
  .hc-rating { background: #1a8917; color: #fff; font-size: 12px; font-weight: 700; border-radius: 6px; padding: 2px 7px; }
  .hc-addr { margin: 6px 0 0; color: #8b97a7; font-size: 13px; }
  .hc-price { text-align: right; padding-right: 8px; white-space: nowrap; }
  .hc-amt { display: block; font-size: 22px; font-weight: 800; color: #1a1a1a; }
  .hc-per { font-size: 11px; color: #9aa4b2; }
  .hc-compare { color: #2f6fed; font-weight: 700; font-size: 14px; }
  .hotel-skel { height: 144px; border-radius: 14px; background: linear-gradient(90deg,#efefef,#f7f7f7,#efefef); background-size: 200% 100%; animation: sh 1.2s infinite; }
  @keyframes sh { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
  .load-more { display: block; margin: 20px auto 0; background: #fff; border: 1px solid #dcdcdc; border-radius: 10px; padding: 11px 30px; font-size: 14px; font-weight: 700; color: #333; cursor: pointer; }
  .load-more:hover { border-color: #f5a623; color: #b3730a; }
  .loading-more, .empty { text-align: center; color: #8b97a7; padding: 24px; }

  /* compare header */
  .hotel-head { display: flex; align-items: center; gap: 18px; background: #fff; border: 1px solid #ececec; border-radius: 16px; padding: 16px; margin-bottom: 20px; }
  .hh-img { width: 120px; height: 90px; border-radius: 12px; object-fit: cover; flex: none; }
  .hh-info { flex: 1; min-width: 0; }
  .hh-info h2 { margin: 0; font-size: 22px; font-weight: 800; }
  .hh-addr { margin: 5px 0; color: #8b97a7; font-size: 13px; }
  .hh-meta { display: flex; gap: 12px; align-items: center; }
  .hh-stars { color: #f5a623; font-size: 13px; }
  .hh-rev { color: #555; font-size: 13px; font-weight: 600; }
  .hh-best { text-align: right; flex: none; padding-left: 16px; border-left: 1px solid #f0f0f0; }
  .hh-best-lbl { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #8b97a7; font-weight: 700; }
  .hh-best-val { display: block; font-size: 28px; font-weight: 800; color: #1a8917; line-height: 1.1; }
  .hh-best-src { font-size: 12px; color: #8b97a7; }

  /* meal-plan glossary */
  .meal-info-btn { margin-left: auto; border: 1px solid #d8dee7; background: #fff; color: #4a5568; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
  .meal-info-btn:hover { border-color: #2f6fed; color: #2f6fed; }
  .meal-legend { border: 1px solid #ececec; border-radius: 12px; background: #fafbfc; padding: 12px 14px; margin: 0 0 14px; }
  .meal-legend-head { font-size: 12px; font-weight: 700; color: #4a5568; margin-bottom: 8px; }
  .meal-legend-row { display: flex; gap: 12px; padding: 5px 0; border-top: 1px solid #eef1f4; font-size: 13px; }
  .meal-legend-row:first-of-type { border-top: 0; }
  .ml-label { flex: 0 0 130px; font-weight: 700; color: #1a1a1a; }
  .ml-terms { color: #7a869a; }
  :global(html.dark) .meal-info-btn { background: #1d2430; border-color: #2c3543; color: #cfd6df; }
  :global(html.dark) .meal-legend { background: #161c25; border-color: #2c3543; }
  :global(html.dark) .meal-legend-head, :global(html.dark) .ml-label { color: #e6e9ee; }
  :global(html.dark) .meal-legend-row { border-top-color: #232b36; }

  /* partner strip */
  .strip-head { display: flex; align-items: baseline; gap: 12px; margin: 4px 0 12px; }
  .strip-head h3 { font-size: 18px; font-weight: 800; margin: 0; }
  .rooms-head { margin-top: 30px; }
  .strip { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
  .pcard { display: block; text-align: center; text-decoration: none; color: inherit; background: #fff; border: 1px solid #ececec; border-radius: 14px; padding: 14px 8px; transition: box-shadow .12s, border-color .12s; }
  .pcard:hover { border-color: #cfd6df; box-shadow: 0 4px 14px rgba(0,0,0,.05); }
  .pcard.best { border-color: #1a8917; background: #f4fbf5; }
  .pcard.nolink { cursor: default; }
  .pcard-who { font-size: 13px; font-weight: 700; color: #555; margin-bottom: 6px; }
  .pcard-amt { font-size: 20px; font-weight: 800; color: #1a1a1a; }
  .pcard-amt small { font-size: 11px; font-weight: 500; color: #9aa4b2; }
  .pcard.best .pcard-amt { color: #1a8917; }
  .pcard-total { font-size: 12px; color: #666; font-weight: 600; margin-top: 2px; }
  .pcard-src { font-size: 10px; color: #b8c0cc; margin-top: 4px; text-transform: uppercase; letter-spacing: .3px; }
  .pcard-src.live { color: #1a8917; }
  .usd-star { color: #e08a00; cursor: help; font-weight: 800; }
  .status-line { color: #8b97a7; font-size: 13px; margin: 12px 2px; }

  /* full price matrix */
  /* fixed layout → columns share the width equally and the table always fits (no horizontal scroll) */
  .matrix-wrap { border: 1px solid #ececec; border-radius: 14px; background: #fff; margin-bottom: 8px; overflow: hidden; }
  .matrix { border-collapse: collapse; width: 100%; table-layout: fixed; }
  .matrix thead th { background: #1a2230; color: #cfd6df; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; text-align: left; padding: 12px 14px; }
  .matrix tbody td { border-top: 1px solid #f2f2f2; padding: 12px 12px; vertical-align: top; }
  .matrix .rt-col { font-size: 14px; font-weight: 600; color: #1a1a1a; width: 22%; background: #fff; }
  .matrix .rt-col small { color: #8b97a7; font-weight: 500; }
  .mcell { font-size: 15px; color: #1a1a1a; }
  .mcell.cheapest .mval { color: #1a8917; font-weight: 800; }
  .mval { font-weight: 700; white-space: nowrap; }
  .mbell { margin-left: 4px; border: 0; background: transparent; cursor: pointer; font-size: 12px; padding: 0 2px; opacity: .55; }
  .mbell:hover { opacity: 1; }
  .alert-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1a2230; color: #fff; padding: 10px 18px; border-radius: 10px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,.25); z-index: 100; }
  .mgo { display: inline-flex; align-items: center; justify-content: center; margin-left: 5px; width: 18px; height: 18px; border-radius: 5px; background: #eef4ff; color: #2f6fed; font-size: 11px; font-weight: 700; text-decoration: none; }
  .mgo:hover { background: #2f6fed; color: #fff; }
  .mbreak { font-size: 10px; color: #9aa4b2; margin-top: 3px; font-weight: 400; white-space: normal; line-height: 1.35; }

  /* room cards */
  .room-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 820px) { .room-grid, .stay-row { grid-template-columns: 1fr; } .strip { grid-template-columns: repeat(3, 1fr); } .hotel-card { grid-template-columns: 120px 1fr; } .hc-price { grid-column: 2; text-align: left; } }
  @media (max-width: 520px) { .strip { grid-template-columns: repeat(2, 1fr); } .hero h1 { font-size: 30px; } }

  /* google offers */
  .google-offers { margin-top: 28px; background: #fff; border: 1px solid #ececec; border-radius: 14px; padding: 6px 18px; }
  .google-offers summary { cursor: pointer; font-weight: 700; font-size: 14px; color: #555; padding: 12px 0; }
  .offer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; padding: 6px 0 16px; }
  .offer { display: flex; justify-content: space-between; align-items: center; gap: 8px; text-decoration: none; color: inherit; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
  .offer:hover { border-color: #cfd6df; }
  .offer-who { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
  .offer-who img { width: 16px; height: 16px; border-radius: 3px; }
  .offer-amt { font-size: 14px; font-weight: 700; }

  .footer { text-align: center; color: #b8c0cc; font-size: 12px; padding: 30px 20px; }
</style>
