<script>
  import { onMount } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  const physEase = cubicOut;   // physical, non-bouncy ease-out for entrance motion
  import { suggest, listHotels, fetchMeta, setHotelAlert, MODE } from "./lib/bridge.js";
  import { runCompare } from "./lib/orchestrate.js";
  import DatePicker from "./lib/DatePicker.svelte";
  import mmtLogo from "./assets/partners/makemytrip.png";
  import goibiboLogo from "./assets/partners/goibibo.png";
  import cleartripLogo from "./assets/partners/cleartrip.png";
  import agodaLogo from "./assets/partners/agoda.png";
  import bookingLogo from "./assets/partners/bookingcom.png";
  import emtLogo from "./assets/partners/easemytrip.png";
  import heroImg from "./assets/partners/image.png";
  import destGoa from "./assets/dest/goa.png";
  import destMumbai from "./assets/dest/mumbai.png";
  import destDelhi from "./assets/dest/delhi.png";
  import destJaipur from "./assets/dest/jaipur.png";
  import destBengaluru from "./assets/dest/bengaluru.png";
  import destHyderabad from "./assets/dest/hyderabad.png";
  // partner logos keyed by display name (used in the trust row + compare cards)
  const PARTNER_LOGO = {
    "MakeMyTrip": mmtLogo, "Goibibo": goibiboLogo, "Cleartrip": cleartripLogo,
    "Agoda": agodaLogo, "Booking.com": bookingLogo, "EaseMyTrip": emtLogo,
  };
  import RoomCard from "./lib/RoomCard.svelte";

  const log = (...a) => console.log("%c[app]", "color:#d29922", ...a);
  const PROVIDERS = { 1288: "MakeMyTrip", 1294: "Goibibo", 1289: "Cleartrip", 2255: "EaseMyTrip", 2361: "Agoda", 6871: "Booking.com" };
  const provName = (p) => ({ mmt: "MakeMyTrip", goibibo: "Goibibo", cleartrip: "Cleartrip", easemytrip: "EaseMyTrip", agoda: "Agoda", booking_com: "Booking.com" }[p] || p);
  const PARTNER_LIST = ["MakeMyTrip", "Goibibo", "Cleartrip", "EaseMyTrip", "Agoda", "Booking.com"];

  // ── search box + autosuggest ──
  let query = "", suggestions = [], showSuggest = false, suggestTimer, suggestSeq = 0;
  // text the CURRENT `suggestions` array actually resolved for — lets submitSearch() tell a fresh
  // suggestion apart from a stale one still sitting there from the previous query (see submitSearch).
  let suggestionsFor = "";
  let source = "emt";           // typeahead engine: emt | mmt | cleartrip (diagnostic toggle)

  // ── stay form ──
  const isoDay = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  let ci = isoDay(1), co = isoDay(2), rooms = 1, adults = 2, children = 0, childAge = "";
  $: nights = Math.max(1, Math.round((new Date(co) - new Date(ci)) / 864e5) || 1);
  $: queryParams = { checkin: ci, checkout: co, rooms: +rooms, adults: +adults, children: +children, child_age: childAge, nights };

  // Quick-pick cities on the homepage → straight into that city's listing.
  // Quick-pick destinations for the homepage. `hue` drives each tile's gradient (no stock photos available).
  const POPULAR_CITIES = [
    { name: "Goa", img: destGoa },
    { name: "Mumbai", img: destMumbai },
    { name: "New Delhi", img: destDelhi },
    { name: "Jaipur", img: destJaipur },
    { name: "Bengaluru", img: destBengaluru },
    { name: "Hyderabad", img: destHyderabad },
  ];
  // The sites we compare — shown as a trust row (grayscale, colour on hover).
  const TRUST_PARTNERS = ["MakeMyTrip", "Goibibo", "Cleartrip", "Agoda", "Booking.com", "EaseMyTrip"];

  // ── view + results state ──
  let view = "search";          // search | listing | compare
  let listing = [], listingTitle = "", listingLoading = false, listingSource = null;
  let listingPage = 1, listingHasMore = false, listingLoadingMore = false;
  let selected = null, canonical = null, grid = [];
  // cross-partner hotel gallery + aggregate rating (server.js mergeHotelGallery) — first-non-empty per
  // field across every partner that answered, plus a review-count-weighted average rating (0-5).
  let hotelInfo = null;
  let activeImage = null;   // user-clicked hotel gallery thumbnail — overrides the default hero image
  let lightboxSrc = null;   // any image the user clicked to view enlarged — null when closed
  $: mainImage = activeImage || (selected && selected.image) || hotelInfo?.image;
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

  // Top filter-pills row (listing) — quick access to the same filters as the sidebar, above the results.
  const PILL_SORTS = [
    { v: "popular", label: "Popularity" },
    { v: "price_asc", label: "Price: Low to High" },
    { v: "price_desc", label: "Price: High to Low" },
    { v: "rating", label: "Guest rating" },
  ];
  const PILL_STARS = [5, 4, 3, 2, 1];
  const PILL_TA = [{ v: "5", label: "Excellent · 4.2+" }, { v: "4", label: "Very Good · 3.5+" }, { v: "3", label: "Good · 3+" }];
  const PILL_PROPS = ["Hotel", "Resort", "Guest House", "Apartment", "Villa", "Homestay", "Inn"];
  const PILL_AMEN = ["Wi-Fi", "Swimming Pool", "Parking", "AC", "Bar", "Restaurant", "Spa Service", "Fitness", "24 Hour Front Desk"];
  let pillOpen = null; // 'sort' | 'star' | 'rating' | 'prop' | 'amen' | null
  const toggleArr = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  function clearAllFilters() { fStars = []; fTa = []; fProps = []; fAmen = []; fSort = "popular"; fMin = null; fMax = null; applyFilters(); }
  $: filtersActive = !!(fStars.length || fTa.length || fProps.length || fAmen.length || fMin != null || fMax != null || fSort !== "popular");
  $: pillSortLabel = (PILL_SORTS.find((o) => o.v === fSort) || PILL_SORTS[0]).label;

  // Wishlist heart on hotel cards — persisted locally as full card snapshots (name+city key), no backend
  // involved. Storing the whole card (not just a key) is what lets the homepage "Saved hotels" section
  // render real image/price/address without re-fetching anything.
  const favKey = (h) => `${h.name}|${h.city || listingTitle || ""}`;
  let favorites = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem("hc_favs") || "[]");
    favorites = new Map(raw.map((h) => [favKey(h), h]));
  } catch {}
  function toggleFav(h) {
    const snap = { ...h, city: h.city || listingTitle || "" };
    const k = favKey(snap);
    if (favorites.has(k)) favorites.delete(k); else favorites.set(k, snap);
    favorites = new Map(favorites);
    try { localStorage.setItem("hc_favs", JSON.stringify([...favorites.values()])); } catch {}
  }
  $: savedHotels = [...favorites.values()];
  // EMT addresses already come pipe-separated by locality ("South Goa>Vasco Da Gama") — split for breadcrumb display.
  const addrParts = (addr) => String(addr || "").split(">").map((s) => s.trim()).filter(Boolean);
  const filterObj = () => ({ stars: fStars, taRating: fTa, amenities: fAmen, props: fProps, minPrice: fMin, maxPrice: fMax, sort: fSort });

  function onInput() {
    clearTimeout(suggestTimer);
    const q = query.trim();
    // bump the seq on EVERY keystroke so any in-flight suggest for an older query is ignored when it resolves
    const seq = ++suggestSeq;
    if (q.length < 2) { suggestions = []; showSuggest = false; suggestionsFor = ""; return; }
    suggestTimer = setTimeout(async () => {
      try {
        const res = await suggest(q, source);
        // drop stale responses: a newer keystroke (or a pick/clear) has happened, or the box no longer holds q
        if (seq !== suggestSeq || query.trim() !== q) return;
        suggestions = res; showSuggest = res.length > 0; suggestionsFor = q;
      } catch (e) {
        log("suggest failed", e.message);
        if (seq !== suggestSeq) return;
        suggestions = []; showSuggest = false; suggestionsFor = "";
      }
    }, 200);
  }

  // "Best per room type" rail on the compare page — a drawer, closed by default, so the main comparison
  // content (matrix/cards) always gets the full page width instead of permanently losing a column to it.
  let recoRailOpen = false;

  // ── custom date picker (replaces the native date inputs) ──
  let openDate = null; // 'ci' | 'co' | null
  let openGuests = false;
  let barOpen = null; // 'ci' | 'co' | 'guests' | null — the sticky stay-bar's own popover state
  $: guestSummary = `${rooms} room${rooms > 1 ? "s" : ""} · ${adults} adult${adults > 1 ? "s" : ""}${children ? ` · ${children} child${children > 1 ? "ren" : ""}` : ""}`;
  const clampStep = (v, d, lo, hi) => Math.min(hi, Math.max(lo, v + d));
  const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const todayISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  function fmtDate(iso) {
    if (!iso) return "Select";
    const [y, m, d] = iso.split("-").map(Number);
    return `${DOW3[new Date(y, m - 1, d).getDay()]}, ${d} ${MON3[m - 1]}`;
  }
  function addDaysISO(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  function pickCi(iso) { ci = iso; if (!co || co <= iso) co = addDaysISO(iso, 1); openDate = null; }
  function pickCo(iso) { co = iso; openDate = null; }

  // Homepage Search button / Enter: pick the top suggestion if we have one, else run a city search on the text.
  function submitSearch() {
    // only trust suggestions[0] if it actually resolved for the text currently in the box — otherwise a
    // fast Enter (before the 200ms debounce refreshes suggestions for the new text) would silently pick
    // the PREVIOUS query's top suggestion (e.g. a hotel) instead of searching what's actually typed.
    const q = query.trim();
    if (suggestions && suggestions.length && suggestionsFor === q) { pick(suggestions[0]); return; }
    if (q) pick({ name: q, city: q, type: "city" });
  }
  function onSearchKey(e) {
    if (e.key === "Enter") { e.preventDefault(); showSuggest = false; submitSearch(); }
  }

  function pick(s) {
    // kill any pending/in-flight suggest so a late result can't reopen the dropdown or override the pick
    clearTimeout(suggestTimer); suggestSeq++;
    query = s.name; showSuggest = false; suggestions = []; suggestionsFor = "";
    if (s.type !== "hotel") { fStars = []; fTa = []; fProps = []; fAmen = []; fSort = "popular"; fMin = null; fMax = null; loadListing(s); return; }
    resolveAndCompare({ name: s.name, city: s.city, lat: s.lat, lng: s.lng, emt_hotel_id: s.emt_hotel_id, entityId: s.entityId });
  }

  // Resolve a hotel (from autosuggest OR a restored URL) to full ids via EMT search by name, then compare.
  // An autosuggest/URL hotel carries only name (+maybe ecid) — EMT search gives hid + geo + durl.
  let destResolving = false;
  async function resolveAndCompare({ name, city, lat, lng, emt_hotel_id, entityId }) {
    query = name;
    // Skyscanner mode: no EMT resolve step — we already hold the entityId, go straight to compare.
    if (MODE === "sky") {
      view = "compare"; status = "resolving"; selected = { name, city, lat, lng, type: "hotel", entityId };
      canonical = null; partners = {}; grid = []; doneCount = 0; planCount = 0;
      startCompare(); return;
    }
    // Resolve BEFORE navigating anywhere — we don't yet know if this lands on the hotel's compare page or
    // (on a miss) the city listing, so don't flip `view` until we know. Flipping early flashed the hotel
    // detail page open then immediately bounced back to listing on a miss — jarring and wrong.
    const wantEc = String(emt_hotel_id || "").replace(/^EMTHOTEL-/i, "").toLowerCase();
    let card = null;
    destResolving = true;
    try {
      const r = await listHotels({ city: city || "", params: queryParams, name });
      const hotels = (r && r.hotels) || [];
      // Find the picked hotel in the listing — by emt id, else by name — to enrich it (hid + durl + image).
      card = hotels.find((h) => wantEc && String(h.emt_hotel_id || "").toLowerCase() === wantEc)
        || hotels.find((h) => (h.name || "").toLowerCase().includes(name.toLowerCase().split(",")[0].trim()))
        || null;
    } catch (e) { log("resolve hotel failed", e.message); }
    destResolving = false;
    if (card) {
      selected = { name: card.name, city: city || card.city || "", lat: card.lat, lng: card.lng, type: "hotel",
        emt_hotel_id: card.emt_hotel_id, emt_secondary_id: card.emt_secondary_id, emt_durl: card.durl,
        image: card.image, address: card.address, rating: card.rating,
        locality: card.locality, propertyType: card.property_type, highlights: card.highlights,
        amenities: card.amenities, thumbnails: card.thumbnails, discount: card.discount,
        meal: card.meal, freeBreakfast: card.free_breakfast, checkinTime: card.checkin_time,
        checkoutTime: card.checkout_time, cashbackOffer: card.cashback_offer, roomOffer: card.room_offer };
      view = "compare"; status = "resolving"; canonical = null; partners = {}; grid = []; doneCount = 0; planCount = 0;
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

  // Called after any filter-pill/price mutation (fStars/fTa/fProps/fAmen/fSort/fMin/fMax are plain top-level
  // vars, mutated directly at the call site) — re-fetch page 1 with the new filters.
  // NOTE: the listing engine is ALWAYS EMT (HotelListIdWiseNew) — these are its native server-side filters.
  // The EMT|MMT toggle only affects the typeahead; MMT has no rich city listing.
  function applyFilters() {
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

  // `card.city` lets this work standalone (e.g. from the homepage's Saved Hotels, with no ambient listing) —
  // a plain listing card has no .city of its own, so it falls back to the current listingTitle as before.
  function pickHotel(card) {
    selected = { name: card.name, city: card.city || listingTitle, lat: card.lat, lng: card.lng, type: "hotel",
      emt_hotel_id: card.emt_hotel_id, emt_secondary_id: card.emt_secondary_id, emt_durl: card.durl,
      image: card.image, address: card.address, rating: card.rating,
      locality: card.locality, propertyType: card.property_type, highlights: card.highlights,
      amenities: card.amenities, thumbnails: card.thumbnails, discount: card.discount,
      meal: card.meal, freeBreakfast: card.free_breakfast, checkinTime: card.checkin_time,
      checkoutTime: card.checkout_time, cashbackOffer: card.cashback_offer, roomOffer: card.room_offer };
    query = card.name; view = "compare"; startCompare();
  }

  function startCompare() {
    if (!selected) return;
    // Skyscanner mode needs an entityId to compare — a name/city-only trigger (e.g. hash restore) can't
    // resolve one, so bail without wiping the current results or firing an empty /compare (was a 400).
    if (MODE === "sky" && !selected.entityId) return;
    syncHash();
    const s = selected, myRun = ++runSeq;
    canonical = null; partners = {}; grid = []; skyPartners = []; hotelInfo = null; activeImage = null; doneCount = 0; planCount = 0; status = "resolving";
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
          min_tax: r.partner ? r.partner.min_tax : null,
          min_stay_total: r.partner ? r.partner.min_stay_total : null,
          currency: r.partner ? r.partner.currency : "INR", approx: r.partner ? r.partner.approx : false,
          deepLink: r.partner ? r.partner.deep_link : null,
        };
        partners = partners;
        if (r.grid && r.grid.length) grid = r.grid;
        if (r.hotel) hotelInfo = r.hotel;
        doneCount += 1;
      },
      onDone: (hotel) => { if (stale()) return; status = "done"; if (hotel) hotelInfo = hotel; },
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
    if (live && live.min_price != null) return { who, val: live.min_price, tax: live.min_tax, incl: live.min_tax ? live.min_price + live.min_tax : live.min_price, stay: live.min_stay_total ?? (live.min_price * nights), approx: live.approx, src: "live", deepLink: live.deepLink };
    return { who, val: null, stay: null, src: null, status: live ? live.status : null };
  });
  // Sort by the TAX-INCLUSIVE per-night figure (what's actually shown as the headline price) — sorting by
  // base-only could crown a partner "best" whose real (incl. tax) price is higher than a rival's.
  $: best = merged.filter((m) => m.val != null).sort((a, b) => a.incl - b.incl)[0] || null;
  // Recommendations panel: cheapest first, then the rest of the priced partners ranked ascending; sold-out /
  // not-yet-loaded partners are listed separately, muted, at the end.
  $: ranked = merged.filter((m) => m.val != null).sort((a, b) => a.incl - b.incl);
  $: unranked = merged.filter((m) => m.val == null);

  // ── compare: grid → room CARDS (grouped by room signature, meals within, partners cheapest-first) ──
  const MEAL_ORDER = { "Room Only": 0, "Breakfast": 1, "Half Board": 2, "Full Board": 3, "All Inclusive": 4 };
  const stayOf = (c) => (c && (c.stay_total != null ? c.stay_total : (c.total != null ? c.total * (c.nights || nights) : null)));
  $: roomCards = (() => {
    const bySig = new Map();
    for (const row of grid || []) {
      const key = row.sig || row.room_class;
      if (!bySig.has(key)) bySig.set(key, { sig: key, room_name: row.room_name || row.room_class, room_class: row.room_class, thumbnail: null, meals: [] });
      const cardObj = bySig.get(key);
      if (row.room_name && row.room_name.length > (cardObj.room_name || "").length) cardObj.room_name = row.room_name;
      // Real per-room photo when a partner's config extracted one; only some partners do — falls back to
      // the hotel's own photo (passed separately) when no room ever supplied a thumbnail.
      if (!cardObj.thumbnail && Array.isArray(row.thumbnails) && row.thumbnails[0]) cardObj.thumbnail = row.thumbnails[0];
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
    calendar: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>`,
    users: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6"/><path d="M17 5.2a3.4 3.4 0 0 1 0 6.4M21.5 20c0-2.6-1.6-4.6-4-5.3"/></svg>`,
    search: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>`,
    arrow: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>`,
    price: `<span style="font-weight:800;font-size:15px;line-height:1;display:inline-flex;">₹</span>`,
    spinner: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" class="icon-spin"><path d="M12 2a10 10 0 0 1 10 10"/></svg>`,
    star: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>`,
    chat: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    briefcase: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    grid4: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M9 6h6M9 18h6M5 8v8M19 8v8"/></svg>`,
    chev: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
    coffee: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v2M12 3v2"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>`,
    sortIcon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-9.8-9.4C.6 7.4 2.4 4 5.9 4c2 0 3.5 1.1 4.4 2.4C11.2 5.1 12.7 4 14.7 4c3.5 0 5.3 3.4 3.7 7.1-2.3 4.8-9.8 9.4-9.8 9.4z"/></svg>`,
    map: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5 3 6.7v13l6-2.2 6 2.2 6-2.2v-13l-6 2.2M9 4.5l6 2.2M9 4.5v13.2M15 6.7v13.2"/></svg>`,
    bolt: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>`,
    tag: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 12.6 12 21.2 2.8 12l8.6-8.6H18a2 2 0 0 1 2 2v6.6z"/><circle cx="14.5" cy="9.5" r="1.5"/></svg>`,
    info: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/></svg>`,
    check: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  };
  const icon = (t) => ICONS[t] || (["region","area","locality","city"].includes(t) ? ICONS.city : ICONS.place);
</script>

<svelte:window on:scroll={onWindowScroll} />

<header class="topbar">
  <a href="/" class="logo" on:click|preventDefault={goHome}>
    <span class="logo-txt">Hotel<span class="accent">Compare</span></span>
  </a>
  <div class="topbar-right">
    <span class="mode-badge">{MODE === "ext" ? "Extension" : MODE === "sky" ? "Skyscanner" : "Dev"}</span>
    <button class="dark-toggle" on:click={toggleDark} title="Toggle theme" aria-label="Toggle theme">
      {@html dark ? icon("sun") : icon("moon")}
    </button>
  </div>
</header>

<main>
  <!-- ── Sticky stay bar (listing + compare) ── -->
  {#if view !== "search"}
    <div class="stay-bar">
      {#if barOpen}
        <button type="button" class="dp-backdrop" aria-label="Close" on:click={() => (barOpen = null)}></button>
      {/if}
      {#if view === "listing"}
        <div class="sb-cell dest" class:active={showSuggest}>
          <span class="sb-ic">{@html icon("place")}</span>
          <div class="sb-dest-field">
            <span class="sb-lbl">Destination</span>
            <input type="text" autocomplete="off" placeholder="Search a city or hotel…" bind:value={query}
              on:input={onInput} on:focus={() => (showSuggest = suggestions.length > 0)}
              on:blur={() => setTimeout(() => (showSuggest = false), 150)} />
          </div>
          {#if query}
            <button type="button" class="sb-clear" aria-label="Clear destination"
              on:click={() => { query = ""; suggestions = []; showSuggest = false; }}>×</button>
          {/if}
          {#if showSuggest}
            <div class="dropdown sb-dropdown" transition:fade={{ duration: 120 }}>
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
        <div class="sb-div"></div>
      {/if}
      <div class="sb-cell" class:active={barOpen === "ci"}>
        <span class="sb-ic">{@html icon("calendar")}</span>
        <button type="button" class="sb-btn" on:click={() => (barOpen = barOpen === "ci" ? null : "ci")}>
          <span class="sb-lbl">Check-in</span><span class="sb-val">{fmtDate(ci)}</span>
        </button>
        {#if barOpen === "ci"}<div class="dp-pop" transition:fade={{ duration: 120 }}><DatePicker value={ci} min={todayISO} onSelect={(d) => { pickCi(d); barOpen = null; }} /></div>{/if}
      </div>
      <div class="sb-cell" class:active={barOpen === "co"}>
        <span class="sb-ic">{@html icon("calendar")}</span>
        <button type="button" class="sb-btn" on:click={() => (barOpen = barOpen === "co" ? null : "co")}>
          <span class="sb-lbl">Check-out</span><span class="sb-val">{fmtDate(co)}</span>
        </button>
        {#if barOpen === "co"}<div class="dp-pop" transition:fade={{ duration: 120 }}><DatePicker value={co} min={addDaysISO(ci, 1)} onSelect={(d) => { pickCo(d); barOpen = null; }} /></div>{/if}
      </div>
      <div class="sb-cell" class:active={barOpen === "guests"}>
        <span class="sb-ic">{@html icon("users")}</span>
        <button type="button" class="sb-btn" on:click={() => (barOpen = barOpen === "guests" ? null : "guests")}>
          <span class="sb-lbl">Guests &amp; rooms</span><span class="sb-val">{guestSummary}</span>
        </button>
        {#if barOpen === "guests"}
          <div class="dp-pop gp-pop" transition:fade={{ duration: 120 }}>
            <div class="gp-row"><div class="gp-info"><span class="gp-name">Rooms</span></div><div class="gp-step"><button type="button" on:click={() => (rooms = clampStep(rooms, -1, 1, 8))} disabled={rooms <= 1}>−</button><span class="gp-num">{rooms}</span><button type="button" on:click={() => (rooms = clampStep(rooms, 1, 1, 8))} disabled={rooms >= 8}>+</button></div></div>
            <div class="gp-row"><div class="gp-info"><span class="gp-name">Adults</span><span class="gp-hint">Age 13+</span></div><div class="gp-step"><button type="button" on:click={() => (adults = clampStep(adults, -1, 1, 12))} disabled={adults <= 1}>−</button><span class="gp-num">{adults}</span><button type="button" on:click={() => (adults = clampStep(adults, 1, 1, 12))} disabled={adults >= 12}>+</button></div></div>
            <div class="gp-row"><div class="gp-info"><span class="gp-name">Children</span><span class="gp-hint">Age 0–12</span></div><div class="gp-step"><button type="button" on:click={() => (children = clampStep(children, -1, 0, 6))} disabled={children <= 0}>−</button><span class="gp-num">{children}</span><button type="button" on:click={() => (children = clampStep(children, 1, 0, 6))} disabled={children >= 6}>+</button></div></div>
            <button type="button" class="gp-done" on:click={() => (barOpen = null)}>Done</button>
          </div>
        {/if}
      </div>
      {#if view === "listing"}
        <div class="sb-div"></div>
        <div class="sb-cell" class:active={barOpen === "price"}>
          <span class="sb-ic">{@html icon("price")}</span>
          <button type="button" class="sb-btn" on:click={() => (barOpen = barOpen === "price" ? null : "price")}>
            <span class="sb-lbl">Price / Night</span>
            <span class="sb-val">{(fMin != null || fMax != null) ? `${inr(fMin || 0)} – ${fMax ? inr(fMax) : "∞"}` : "Any"}</span>
          </button>
          {#if barOpen === "price"}
            <div class="dp-pop price-pop" transition:fade={{ duration: 120 }}>
              <div class="price-pop-inputs">
                <input type="number" placeholder="Min" bind:value={fMin} min="0" />
                <span>–</span>
                <input type="number" placeholder="Max" bind:value={fMax} min="0" />
              </div>
              <button type="button" class="gp-done" on:click={() => { applyFilters(); barOpen = null; }}>Apply</button>
            </div>
          {/if}
        </div>
      {/if}
      <span class="sb-nights">{nights} night{nights > 1 ? "s" : ""}</span>
      <button class="sb-update" on:click={applyStay}><span class="sm-go-ic">{@html icon("search")}</span> Update</button>
    </div>
  {/if}

  <!-- ── SEARCH (home) ── -->
  {#if view === "search"}
    <section class="home" in:fade={{ duration: 350 }}>
      <div class="home-media" aria-hidden="true"><img class="home-media-img" src={heroImg} alt="" /></div>

      <div class="home-inner">
        <div class="home-hero" in:fly={{ y: 18, duration: 520, easing: physEase }}>
          <div class="home-copy">
            <span class="home-eyebrow"><span class="dot"></span> Live prices · 6 sites · one search</span>
            <h1 class="home-title">Find the <span class="hl">best hotel price</span>,<br />every single time.</h1>
            <p class="home-sub">We compare live prices from MakeMyTrip, Goibibo, Cleartrip, Agoda, Booking.com &amp; EaseMyTrip — so you never overpay.</p>
          </div>
        </div>

        <!-- signature: one unified search module -->
        {#if openDate || openGuests}
          <button type="button" class="dp-backdrop" aria-label="Close" on:click={() => { openDate = null; openGuests = false; }}></button>
        {/if}
        <div class="search-module" in:fly={{ y: 22, duration: 560, delay: 90, easing: physEase }}>
          <div class="sm-source">
            <span class="sm-source-lbl">Search with</span>
            <div class="sm-seg">
              <button class:on={source === "emt"} on:click={() => { source = "emt"; if (query.length >= 2) onInput(); }}>
                <img src={emtLogo} alt="" /> EaseMyTrip
              </button>
              <button class:on={source === "mmt"} on:click={() => { source = "mmt"; if (query.length >= 2) onInput(); }}>
                <img src={mmtLogo} alt="" /> MakeMyTrip
              </button>
              <button class:on={source === "cleartrip"} on:click={() => { source = "cleartrip"; if (query.length >= 2) onInput(); }}>
                <img src={cleartripLogo} alt="" /> Cleartrip
              </button>
            </div>
          </div>

          <div class="sm-dest">
            <span class="sm-ic">{@html icon("place")}</span>
            <div class="sm-field">
              <label>Destination</label>
              <input type="text" autocomplete="off" placeholder="Where to? Search a city or hotel…"
                bind:value={query} on:input={onInput} on:keydown={onSearchKey}
                on:focus={() => (showSuggest = suggestions.length > 0)}
                on:blur={() => setTimeout(() => (showSuggest = false), 150)} />
            </div>
            {#if showSuggest}
              <div class="dropdown" transition:fade={{ duration: 120 }}>
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

          <div class="sm-controls">
            <div class="sm-cell date" class:active={openDate === "ci"}>
              <span class="sm-ic sm">{@html icon("calendar")}</span>
              <button type="button" class="sm-date-btn" on:click={() => { openDate = openDate === "ci" ? null : "ci"; openGuests = false; }}>
                <span class="sm-lbl">Check-in</span>
                <span class="sm-val">{fmtDate(ci)}</span>
              </button>
              {#if openDate === "ci"}
                <div class="dp-pop" transition:fade={{ duration: 120 }}>
                  <DatePicker value={ci} min={todayISO} onSelect={pickCi} />
                </div>
              {/if}
            </div>
            <div class="sm-div"></div>
            <div class="sm-cell date" class:active={openDate === "co"}>
              <span class="sm-ic sm">{@html icon("calendar")}</span>
              <button type="button" class="sm-date-btn" on:click={() => { openDate = openDate === "co" ? null : "co"; openGuests = false; }}>
                <span class="sm-lbl">Check-out</span>
                <span class="sm-val">{fmtDate(co)}</span>
              </button>
              {#if openDate === "co"}
                <div class="dp-pop dp-pop-r" transition:fade={{ duration: 120 }}>
                  <DatePicker value={co} min={addDaysISO(ci, 1)} onSelect={pickCo} />
                </div>
              {/if}
            </div>
            <div class="sm-div"></div>
            <div class="sm-cell guests date" class:active={openGuests}>
              <span class="sm-ic sm">{@html icon("users")}</span>
              <button type="button" class="sm-date-btn" on:click={() => { openGuests = !openGuests; openDate = null; }}>
                <span class="sm-lbl">Guests &amp; rooms</span>
                <span class="sm-val">{guestSummary}</span>
              </button>
              {#if openGuests}
                <div class="dp-pop dp-pop-r gp-pop" transition:fade={{ duration: 120 }}>
                  <div class="gp-row">
                    <div class="gp-info"><span class="gp-name">Rooms</span></div>
                    <div class="gp-step">
                      <button type="button" on:click={() => (rooms = clampStep(rooms, -1, 1, 8))} disabled={rooms <= 1} aria-label="Fewer rooms">−</button>
                      <span class="gp-num">{rooms}</span>
                      <button type="button" on:click={() => (rooms = clampStep(rooms, 1, 1, 8))} disabled={rooms >= 8} aria-label="More rooms">+</button>
                    </div>
                  </div>
                  <div class="gp-row">
                    <div class="gp-info"><span class="gp-name">Adults</span><span class="gp-hint">Age 13+</span></div>
                    <div class="gp-step">
                      <button type="button" on:click={() => (adults = clampStep(adults, -1, 1, 12))} disabled={adults <= 1} aria-label="Fewer adults">−</button>
                      <span class="gp-num">{adults}</span>
                      <button type="button" on:click={() => (adults = clampStep(adults, 1, 1, 12))} disabled={adults >= 12} aria-label="More adults">+</button>
                    </div>
                  </div>
                  <div class="gp-row">
                    <div class="gp-info"><span class="gp-name">Children</span><span class="gp-hint">Age 0–12</span></div>
                    <div class="gp-step">
                      <button type="button" on:click={() => (children = clampStep(children, -1, 0, 6))} disabled={children <= 0} aria-label="Fewer children">−</button>
                      <span class="gp-num">{children}</span>
                      <button type="button" on:click={() => (children = clampStep(children, 1, 0, 6))} disabled={children >= 6} aria-label="More children">+</button>
                    </div>
                  </div>
                  <button type="button" class="gp-done" on:click={() => (openGuests = false)}>Done</button>
                </div>
              {/if}
            </div>
            <button class="sm-go" on:click={submitSearch} aria-label="Search hotels">
              <span class="sm-go-ic">{@html icon("search")}</span><span class="sm-go-txt">Search</span>
            </button>
          </div>
        </div>

        <!-- saved hotels — from the wishlist heart on hotel cards, persisted in localStorage -->
        {#if savedHotels.length}
          <div class="dest-block" in:fly={{ y: 22, duration: 560, delay: 140, easing: physEase }}>
            <div class="dest-head-row">
              <span class="dest-head">Saved hotels</span>
            </div>
            <div class="saved-grid">
              {#each savedHotels as h}
                <div class="saved-card" role="button" tabindex="0" on:click={() => pickHotel(h)}
                  on:keydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickHotel(h); } }}>
                  <div class="saved-img">
                    {#if h.image}<img src={h.image} alt={h.name} loading="lazy" />{:else}<span class="hc-noimg">{@html icon("hotel")}</span>{/if}
                    {#if h.rating}<span class="hc-rating-pill">{h.rating.toFixed ? h.rating.toFixed(1) : h.rating} ★</span>{/if}
                    <button type="button" class="hc-fav on" aria-label="Remove from saved" on:click|stopPropagation={() => toggleFav(h)}>{@html icon("heart")}</button>
                  </div>
                  <div class="saved-body">
                    <span class="saved-name">{h.name}</span>
                    {#if h.address}<span class="saved-addr">{addrParts(h.address).join(" › ")}</span>{/if}
                    {#if h.price}<span class="saved-price">{inr(h.price)} <small>per night</small></span>{/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- popular destinations -->
        <div class="dest-block" in:fly={{ y: 22, duration: 560, delay: 180, easing: physEase }}>
          <div class="dest-head-row">
            <span class="dest-head">Popular destinations</span>
          </div>
          <div class="dest-grid">
            {#each POPULAR_CITIES as c}
              <button type="button" class="dest-tile" on:click={() => pick({ name: c.name, city: c.name, type: "city" })}>
                <img src={c.img} alt={c.name} loading="lazy" />
              </button>
            {/each}
          </div>
        </div>

        <!-- trust row -->
        <div class="trust" in:fade={{ duration: 500, delay: 300 }}>
          <span class="trust-lbl">Comparing live prices across</span>
          <div class="trust-logos">
            {#each TRUST_PARTNERS as p}
              {#if PARTNER_LOGO[p]}<img class="trust-logo-img" src={PARTNER_LOGO[p]} alt={p} title={p} />{:else}<span class="trust-logo">{p}</span>{/if}
            {/each}
          </div>
        </div>
      </div>
    </section>
  {/if}

  <!-- ── LISTING ── -->
  {#if view === "listing"}
    <section class="page">
      <!-- horizontal filter pills — same filter state as the sidebar, quick access above the results -->
      <div class="filter-pills">
        {#if pillOpen}<button type="button" class="dp-backdrop" aria-label="Close" on:click={() => (pillOpen = null)}></button>{/if}

        <div class="fp-item" class:active={pillOpen === "sort"}>
          <button type="button" class="fp-btn" on:click={() => (pillOpen = pillOpen === "sort" ? null : "sort")}>
            <span class="fp-ic">{@html icon("sortIcon")}</span> Sort: {pillSortLabel}
            <span class="fp-chev" class:up={pillOpen === "sort"}>{@html icon("chev")}</span>
          </button>
          {#if pillOpen === "sort"}
            <div class="fp-pop" transition:fade={{ duration: 120 }}>
              {#each PILL_SORTS as o}<button type="button" class="fp-opt" class:on={fSort === o.v} on:click={() => { fSort = o.v; applyFilters(); pillOpen = null; }}>{o.label}</button>{/each}
            </div>
          {/if}
        </div>

        <div class="fp-item" class:active={pillOpen === "star"}>
          <button type="button" class="fp-btn" on:click={() => (pillOpen = pillOpen === "star" ? null : "star")}>
            <span class="fp-ic">{@html icon("star")}</span> Star rating{#if fStars.length}<span class="fp-count">{fStars.length}</span>{/if}
            <span class="fp-chev" class:up={pillOpen === "star"}>{@html icon("chev")}</span>
          </button>
          {#if pillOpen === "star"}
            <div class="fp-pop" transition:fade={{ duration: 120 }}>
              <div class="fp-chips">{#each PILL_STARS as s}<button type="button" class="fp-chip" class:on={fStars.includes(s)} on:click={() => { fStars = toggleArr(fStars, s); applyFilters(); }}>{s}★</button>{/each}</div>
            </div>
          {/if}
        </div>

        <div class="fp-item" class:active={pillOpen === "rating"}>
          <button type="button" class="fp-btn" on:click={() => (pillOpen = pillOpen === "rating" ? null : "rating")}>
            <span class="fp-ic">{@html icon("chat")}</span> Guest rating{#if fTa.length}<span class="fp-count">{fTa.length}</span>{/if}
            <span class="fp-chev" class:up={pillOpen === "rating"}>{@html icon("chev")}</span>
          </button>
          {#if pillOpen === "rating"}
            <div class="fp-pop" transition:fade={{ duration: 120 }}>
              {#each PILL_TA as t}<label class="fp-check"><input type="checkbox" checked={fTa.includes(t.v)} on:change={() => { fTa = toggleArr(fTa, t.v); applyFilters(); }} /> {t.label}</label>{/each}
            </div>
          {/if}
        </div>

        <div class="fp-item" class:active={pillOpen === "prop"}>
          <button type="button" class="fp-btn" on:click={() => (pillOpen = pillOpen === "prop" ? null : "prop")}>
            <span class="fp-ic">{@html icon("briefcase")}</span> Property type{#if fProps.length}<span class="fp-count">{fProps.length}</span>{/if}
            <span class="fp-chev" class:up={pillOpen === "prop"}>{@html icon("chev")}</span>
          </button>
          {#if pillOpen === "prop"}
            <div class="fp-pop" transition:fade={{ duration: 120 }}>
              {#each PILL_PROPS as p}<label class="fp-check"><input type="checkbox" checked={fProps.includes(p)} on:change={() => { fProps = toggleArr(fProps, p); applyFilters(); }} /> {p}</label>{/each}
            </div>
          {/if}
        </div>

        <div class="fp-item" class:active={pillOpen === "amen"}>
          <button type="button" class="fp-btn" on:click={() => (pillOpen = pillOpen === "amen" ? null : "amen")}>
            <span class="fp-ic">{@html icon("grid4")}</span> Amenities{#if fAmen.filter((a) => a !== "Free Cancellation" && a !== "Breakfast").length}<span class="fp-count">{fAmen.filter((a) => a !== "Free Cancellation" && a !== "Breakfast").length}</span>{/if}
            <span class="fp-chev" class:up={pillOpen === "amen"}>{@html icon("chev")}</span>
          </button>
          {#if pillOpen === "amen"}
            <div class="fp-pop" transition:fade={{ duration: 120 }}>
              {#each PILL_AMEN as a}<label class="fp-check"><input type="checkbox" checked={fAmen.includes(a)} on:change={() => { fAmen = toggleArr(fAmen, a); applyFilters(); }} /> {a}</label>{/each}
            </div>
          {/if}
        </div>

        <button type="button" class="fp-toggle" class:on={fAmen.includes("Free Cancellation")}
          on:click={() => { fAmen = toggleArr(fAmen, "Free Cancellation"); applyFilters(); }}>
          <span class="fp-ic">{@html icon("shield")}</span> Free cancellation
        </button>
        <button type="button" class="fp-toggle" class:on={fAmen.includes("Breakfast")}
          on:click={() => { fAmen = toggleArr(fAmen, "Breakfast"); applyFilters(); }}>
          <span class="fp-ic">{@html icon("coffee")}</span> Breakfast included
        </button>

        {#if filtersActive}<button type="button" class="fp-clear" on:click={clearAllFilters}>{@html icon("refresh")} Clear all</button>{/if}
      </div>

      <nav class="crumbs">
        <button class="crumb" on:click={goHome}>Home</button>
        <span class="crumb-sep">›</span>
        <span class="crumb on">Hotels in {listingTitle}</span>
      </nav>
      <!-- Dates/guests/room count already live on the sticky bar above — don't repeat them here. -->
      <div class="listhead">
        <h2 class="page-title">Hotels in {listingTitle}{#if !listingLoading && listing.length}<span class="page-count">· {listing.length} hotels found</span>{/if}</h2>
      </div>
      <div class="listing-layout">
        <div class="listing-main">
          {#if listingLoading}
            <div class="hotel-grid">{#each Array(6) as _}<div class="hotel-skel"></div>{/each}</div>
          {:else if displayedListing.length}
            <div class="hotel-grid">
              {#each displayedListing as h}
                <div class="hotel-card" role="button" tabindex="0" on:click={() => pickHotel(h)}
                  on:keydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickHotel(h); } }}>
                  <div class="hc-img">
                    {#if h.image}<img src={h.image} alt={h.name} loading="lazy" />{:else}<span class="hc-noimg">{@html icon("hotel")}</span>{/if}
                    {#if h.rating}<span class="hc-rating-pill">{h.rating.toFixed ? h.rating.toFixed(1) : h.rating} ★</span>{/if}
                    <button type="button" class="hc-fav" class:on={favorites.has(favKey(h))}
                      aria-label={favorites.has(favKey(h)) ? "Remove from wishlist" : "Save to wishlist"}
                      on:click|stopPropagation={() => toggleFav(h)}>{@html icon("heart")}</button>
                  </div>
                  <div class="hc-body">
                    <h3 class="hc-name">{h.name}</h3>
                    {#if h.address}
                      <p class="hc-addr">
                        <span class="hc-pin">{@html icon("place")}</span>
                        <span class="hc-addr-text">
                          {#each addrParts(h.address) as part, i}
                            {#if i > 0}<span class="hc-addr-sep">›</span>{/if}{part}
                          {/each}
                        </span>
                      </p>
                    {/if}
                    <div class="hc-logos">{#each Object.entries(PARTNER_LOGO) as [name, src]}<img src={src} alt={name} title={name} />{/each}</div>
                  </div>
                  <div class="hc-price">
                    {#if h.price}
                      <span class="hc-amt">{inr(h.price)}</span>
                      <span class="hc-per">per night</span>
                      <span class="hc-tax">incl. taxes &amp; fees</span>
                    {/if}
                    <span class="hc-cta">View deals <span class="hc-cta-ic">{@html icon("arrow")}</span></span>
                  </div>
                </div>
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
      <nav class="crumbs">
        <button class="crumb" on:click={goHome}>Home</button>
        <span class="crumb-sep">›</span>
        <button class="crumb" on:click={backToListing}>Hotels in {canonical?.city || selected.city}</button>
        <span class="crumb-sep">›</span>
        <span class="crumb on">{selected.name || canonical?.hotel_name}</span>
      </nav>

      <div class="compare-layout">
      <div class="hotel-head">
        <div class="hh-img-wrap">
          <div class="hh-img-main">
            {#if mainImage}<button type="button" class="hh-img-btn" on:click={() => (lightboxSrc = mainImage)}><img class="hh-img" src={mainImage} alt={selected.name} /></button>{:else}<span class="hc-noimg">{@html icon("hotel")}</span>{/if}
            {#if hotelInfo?.our_rating}<span class="hc-rating-pill">{hotelInfo.our_rating} ★</span>
            {:else if selected.rating}<span class="hc-rating-pill">{selected.rating} ★</span>{/if}
          </div>
          {#if hotelInfo?.thumbnails && hotelInfo.thumbnails.length > 1}
            <div class="hh-gallery">
              {#each hotelInfo.thumbnails.slice(0, 5) as t}
                <button type="button" class="hh-gallery-thumb" class:active={t === mainImage} on:click={() => (activeImage = t)}>
                  <img src={t} alt="" />
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <div class="hh-info">
          {#if canonical?.star || hotelInfo?.star}<span class="hh-stars">{"★".repeat(canonical?.star || hotelInfo.star)}<span class="hh-stars-lbl">{canonical?.star || hotelInfo.star}-star hotel</span></span>{/if}
          <h2>{selected.name || canonical?.hotel_name}</h2>
          {#if canonical?.address || selected.address || hotelInfo?.address}
            <p class="hh-addr">
              <span class="hc-pin">{@html icon("place")}</span>
              <span>{[canonical?.city || selected.city || hotelInfo?.city, ...addrParts(canonical?.address || selected.address || hotelInfo?.address)].filter(Boolean).join(" › ")}</span>
            </p>
          {/if}
          {#if hotelInfo?.our_review_count}
            <p class="hh-reviews">{hotelInfo.our_rating} ★ our rating · {hotelInfo.our_review_count.toLocaleString("en-IN")} reviews across partners</p>
          {/if}
          {#if hotelInfo?.checkin_time || hotelInfo?.checkout_time || selected.checkinTime || selected.checkoutTime}
            {@const cin = hotelInfo?.checkin_time || selected.checkinTime}
            {@const cout = hotelInfo?.checkout_time || selected.checkoutTime}
            <p class="hh-times">{#if cin}Check-in {cin}{/if}{#if cin && cout} · {/if}{#if cout}Check-out {cout}{/if}</p>
          {/if}
        </div>
        {#if best}
          <a class="hh-best" href={best.deepLink || "#"} target={best.deepLink ? "_blank" : null} rel="noopener" class:nolink={!best.deepLink}>
            <span class="hh-best-lbl">Best price</span>
            <span class="hh-best-val">{inr(best.incl)}{best.approx ? "~" : ""}</span>
            <span class="hh-best-src">on {best.who} · per night</span>
            <span class="hh-best-cta">Book now <span class="hc-cta-ic">{@html icon("arrow")}</span></span>
          </a>
        {/if}
      </div>

      {#if hotelInfo?.description || selected.propertyType || (selected.highlights && selected.highlights.length) || (selected.amenities && selected.amenities.length)}
        <div class="hh-detail">
          {#if hotelInfo?.description}<p class="hh-desc">{hotelInfo.description}</p>{/if}
          {#if selected.propertyType || (selected.highlights && selected.highlights.length)}
            <div class="hh-chip-row">
              {#if selected.propertyType}<span class="hh-chip hh-chip-type">{selected.propertyType}</span>{/if}
              {#each selected.highlights || [] as h}<span class="hh-chip">{h}</span>{/each}
            </div>
          {/if}
          {#if selected.amenities && selected.amenities.length}
            <div class="hh-chip-row">
              {#each selected.amenities as a}<span class="hh-chip hh-chip-amen">{@html icon("check")} {a}</span>{/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="status-line">
        {#if status === "resolving"}Resolving partners…
        {:else if status === "streaming"}Fetching live prices… {doneCount}/{planCount}
        {:else if status === "done"}Compared {doneCount}/{planCount} partners
        {/if}
      </div>

      <!-- partner strip — one box per partner, cheapest highlighted -->
      <div class="strip-head"><h3>Price Comparison</h3><span class="muted">per night · {nights} night{nights > 1 ? "s" : ""} stay</span></div>
      <div class="strip">
        {#each merged as m}
          <a class="pcard" class:best={best && best.who === m.who} href={m.deepLink || "#"} target={m.deepLink ? "_blank" : null} rel="noopener" class:nolink={!m.deepLink}>
            <div class="pcard-who">{#if PARTNER_LOGO[m.who]}<img class="pcard-logo" src={PARTNER_LOGO[m.who]} alt="" />{/if}{m.who}</div>
            {#if m.val != null}
              <div class="pcard-amt">{inr(m.tax ? m.val + m.tax : m.val)}{#if m.approx}<span class="usd-star" title="Approximate — Agoda prices are converted from USD at the current rate">*</span>{/if}<small>/night</small></div>
              {#if m.tax}<div class="pcard-tax">{inr(m.val)} + {inr(m.tax)} tax</div>{/if}
              {#if m.stay != null}<div class="pcard-total">{inr(m.stay)} total</div>{/if}
              <div class="pcard-src live">live</div>
            {:else}
              <div class="pcard-amt muted">{m.status === "pending" ? "…" : "—"}</div>
            {/if}
          </a>
        {/each}
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
          <button class="meal-info-btn" on:click={() => (showMealInfo = !showMealInfo)} aria-expanded={showMealInfo} title="What do the meal plans mean?">{@html icon("info")} Meal plans</button>
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
          {#each roomCards as room (room.sig)}<RoomCard {room} {nights} hotelImage={selected.image} partnerLogo={PARTNER_LOGO} />{/each}
        </div>

        <!-- full comparison matrix (room × partner) -->
        <div class="strip-head rooms-head"><h3>Full price matrix</h3><span class="muted">totals for {nights} night{nights > 1 ? "s" : ""} · cheapest highlighted · per-night + tax below</span></div>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead><tr><th class="rt-col">Room type</th>{#each gridProviders as p}<th>{#if PARTNER_LOGO[provName(p)]}<img class="mth-logo" src={PARTNER_LOGO[provName(p)]} alt="" />{/if}{provName(p)}</th>{/each}</tr></thead>
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

      {#if roomCards.length}
        <button class="reco-rail-tab" class:open={recoRailOpen} on:click={() => (recoRailOpen = !recoRailOpen)}>
          <span class="reco-rail-tab-icon">{@html icon("tag")}</span>
          <span class="reco-rail-tab-text">Best per room type</span>
        </button>
        {#if recoRailOpen}
          <div class="reco-rail-backdrop" on:click={() => (recoRailOpen = false)}></div>
          <aside class="room-reco-rail" transition:fly={{ x: 300, duration: 220 }}>
            <div class="reco-rail-head">
              {@html icon("tag")} Best per room type
              <button class="reco-rail-close" on:click={() => (recoRailOpen = false)} aria-label="Close">×</button>
            </div>
            {#each roomCards as room (room.sig)}
              {@const bestMeal = room.meals[0]}
              {@const bestOffer = bestMeal.partners[0]}
              <a class="reco-rail-row" href={bestOffer.deepLink || "#"} target={bestOffer.deepLink ? "_blank" : null} rel="noopener" class:nolink={!bestOffer.deepLink}>
                <div class="reco-rail-room">
                  <span class="reco-rail-name">{room.room_name || room.room_class}</span>
                  <span class="reco-rail-meal">{bestMeal.meal}</span>
                </div>
                <div class="reco-rail-offer">
                  {#if PARTNER_LOGO[bestOffer.who]}<img class="reco-rail-logo" src={PARTNER_LOGO[bestOffer.who]} alt="" />{/if}
                  <span class="reco-rail-price">{inr(bestOffer.price)}<small>/night</small></span>
                </div>
              </a>
            {/each}
          </aside>
        {/if}
      {/if}
      </div>

    </section>
    {#if lightboxSrc}
      <div class="lightbox" on:click={() => (lightboxSrc = null)} transition:fade={{ duration: 150 }}>
        <button type="button" class="lightbox-close" on:click={() => (lightboxSrc = null)} aria-label="Close">×</button>
        <img src={lightboxSrc} alt="" on:click|stopPropagation />
      </div>
    {/if}
  {/if}

  {#if alertMsg}<div class="alert-toast">{alertMsg}</div>{/if}
</main>

{#if view !== "search"}
  <footer class="footer">{MODE === "sky" ? "Powered by Skyscanner Hotels API · live prices across Agoda, Booking.com, Goibibo, Expedia, Yatra, Vio.com" : "Powered by EaseMyTrip · live partner prices via the BuyHatke extension"}</footer>
{/if}

<style>
  :global(body) { margin: 0; background: var(--v2-bg); color: var(--v2-ink); font-family: var(--font-body); }
  main { max-width: 1180px; margin: 0 auto; padding: 20px 20px 60px; }

  .topbar-right { display: inline-flex; align-items: center; gap: 10px; }
  .mode-badge { font-size: 11px; font-weight: 600; letter-spacing: .01em; color: var(--v2-slate); background: #eef1f6; border: 1px solid var(--v2-line); border-radius: 999px; padding: 4px 11px; }
  .dark-toggle { display: inline-flex; align-items: center; justify-content: center; background: #fff; border: 1px solid var(--v2-line); border-radius: 10px; width: 36px; height: 36px; cursor: pointer; color: var(--v2-slate); transition: color var(--transition), border-color var(--transition), transform var(--transition); }
  .dark-toggle:hover { color: var(--v2-indigo); border-color: var(--v2-indigo); transform: translateY(-1px); }
  .dark-toggle :global(svg) { width: 17px; height: 17px; }

  /* ── DARK MODE — overrides on <html.dark>; covers body + all card surfaces, text, inputs, borders ── */
  :global(html.dark body) { background: #0f141b; color: #e6e9ee; }
  :global(html.dark) { --page-bg: #0f141b; }
  :global(html.dark) .topbar { background: #161c25; border-bottom-color: #232b36; }
  :global(html.dark) .logo { color: #e6e9ee; }
  :global(html.dark) .dark-toggle { background: #232b36; border-color: #2c3543; color: #e6e9ee; }
  :global(html.dark) .stay-bar,
  :global(html.dark) .hotel-card,
  :global(html.dark) .hotel-head,
  :global(html.dark) .pcard,
  :global(html.dark) .matrix-wrap,
  :global(html.dark) .google-offers,
  :global(html.dark) .offer,
  :global(html.dark) :global(.room-card) { background: #161c25; border-color: #232b36; }
  :global(html.dark) .page-title,
  :global(html.dark) .hh-info h2,
  :global(html.dark) .strip-head h3,
  :global(html.dark) .pcard-amt,
  :global(html.dark) .hc-amt,
  :global(html.dark) :global(.room-head h4) { color: #e6e9ee; }
  :global(html.dark) .dropdown { background: #1d2430; border-color: #2c3543; }
  :global(html.dark) .ac-item:hover, :global(html.dark) .pcard:hover { background: #232b36; }
  :global(html.dark) .ac-name, :global(html.dark) :global(.check), :global(html.dark) .offer-who, :global(html.dark) .offer-amt { color: #e6e9ee; }
  :global(html.dark) .source-toggle { background: #232b36; }
  :global(html.dark) .source-toggle button.on { background: #0f141b; }
  /* home v2 — dark */
  :global(html.dark) .home-title, :global(html.dark) .dest-name, :global(html.dark) .dest-head { color: #f8fafc; }
  :global(html.dark) .home-sub, :global(html.dark) .dest-tag { color: #94a3b8; }
  :global(html.dark) .home-mesh { opacity: .55; }
  :global(html.dark) .search-module { background: #131a26; border-color: #26303f; }
  :global(html.dark) .sm-dest, :global(html.dark) .sm-controls { background: #0f1621; border-color: #26303f; }
  :global(html.dark) .sm-dest:focus-within { background: #131a26; }
  :global(html.dark) .sm-field input, :global(html.dark) .sm-field select { color: #e6e9ee; }
  :global(html.dark) .sm-seg { background: #1d2430; }
  :global(html.dark) .sm-seg button.on { background: #0b1220; }
  :global(html.dark) .dest-tile { border-color: hsla(var(--hue), 30%, 45%, .35); background: linear-gradient(135deg, hsla(var(--hue), 45%, 22%, .5), #131a26 82%); }
  :global(html.dark) .dropdown { background: #131a26; border-color: #26303f; }
  :global(html.dark) .ac-item:hover { background: #1d2636; }
  :global(html.dark) .hc-img, :global(html.dark) :global(.room-head) { background: #1d2430; }
  :global(html.dark) :global(.room-card .prow:hover) { background: #232b36; }
  :global(html.dark) .matrix thead th { background: #0b1baa00; background: #0d1220; }
  :global(html.dark) .matrix .rt-col, :global(html.dark) .matrix thead .rt-col { background: #161c25; }
  :global(html.dark) .matrix tbody td { border-top-color: #232b36; }
  :global(html.dark) .mcell, :global(html.dark) .matrix .rt-col { color: #e6e9ee; }

  /* topbar */
  .topbar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; justify-content: space-between; gap: 16px;
    background: rgba(248,250,252,.55); backdrop-filter: blur(24px) saturate(200%); -webkit-backdrop-filter: blur(24px) saturate(200%);
    border-bottom: 1px solid rgba(15,23,42,.06); padding: 12px 24px; }
  :global(html.dark) .topbar { background: rgba(11,18,32,.55); border-bottom-color: rgba(255,255,255,.06); }
  .logo { display: inline-flex; align-items: center; font-family: var(--font-display); font-size: 24px; font-weight: 800; color: var(--v2-ink); text-decoration: none; letter-spacing: -.03em; }
  .logo .accent { color: var(--v2-indigo); }

  /* buttons */
  .btn-primary { background: #f5a623; color: #1a1a1a; font-weight: 700; font-size: 14px; border: none; border-radius: 10px; padding: 10px 24px; cursor: pointer; }
  .btn-primary:hover { background: #e69512; }
  .back { background: none; border: none; color: #2f6fed; font-size: 14px; font-weight: 600; cursor: pointer; padding: 4px 0; margin-bottom: 12px; }
  .back:hover { text-decoration: underline; }
  .muted { color: #8b97a7; font-size: 13px; }

  /* sticky stay bar (listing + compare) — v2 pill controls */
  .stay-bar { position: sticky; top: 12px; z-index: 20; display: flex; align-items: stretch; gap: 4px; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: 16px; padding: 6px; margin-bottom: 22px; box-shadow: var(--shadow-soft); }
  .sb-cell { position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 11px; transition: background var(--transition); min-width: 0; }
  .sb-cell:hover { background: #fbfcfe; }
  .sb-cell.active { background: #fff; box-shadow: inset 0 0 0 1.5px rgba(79,70,229,.35); }
  .sb-ic { display: flex; color: var(--v2-slate); flex-shrink: 0; }
  .sb-btn { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; border: none; background: none; padding: 0; cursor: pointer; text-align: left; font-family: var(--font-body); }
  .sb-lbl { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--v2-slate-300); }
  .sb-val { font-size: 14px; font-weight: 600; color: var(--v2-ink); white-space: nowrap; }
  .sb-nights { align-self: center; margin-left: auto; color: var(--v2-slate); font-size: 13px; font-weight: 600; padding: 0 6px; }
  .sb-update { align-self: center; display: inline-flex; align-items: center; gap: 8px; background: var(--v2-indigo); color: #fff; font-family: var(--font-display); font-size: 14px; font-weight: 700; border: none; border-radius: 11px; padding: 11px 22px; cursor: pointer; transition: background var(--transition), transform var(--transition), box-shadow var(--transition); }
  .sb-update:hover { background: var(--v2-indigo-hover); transform: translateY(-1px); box-shadow: var(--shadow-indigo); }
  :global(html.dark) .sb-val { color: #e6e9ee; }
  :global(html.dark) .stay-bar { background: #131a26; border-color: #26303f; }
  :global(html.dark) .sb-cell:hover, :global(html.dark) .sb-cell.active { background: #0f1621; }

  /* sticky bar: destination field (listing only) */
  .sb-cell.dest { flex: 1.6 1 220px; }
  .sb-dest-field { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
  .sb-dest-field input { border: none; background: none; outline: none; width: 100%; font-family: var(--font-body); font-size: 14px; font-weight: 500; color: var(--v2-ink); padding: 1px 0; }
  .sb-dest-field input::placeholder { color: #aab4c2; font-weight: 400; }
  .sb-clear { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; border-radius: 50%; background: #eef1f6; color: var(--v2-slate); font-size: 14px; line-height: 1; cursor: pointer; }
  .sb-clear:hover { background: #e2e7ee; color: var(--v2-ink); }
  .sb-dropdown { min-width: 320px; }
  :global(html.dark) .sb-dest-field input { color: #e6e9ee; }
  :global(html.dark) .sb-clear { background: #1d2430; }

  /* sticky bar: price popover */
  .price-pop { width: 240px; background: #fff; border: 1px solid var(--v2-line); border-radius: 16px; box-shadow: var(--shadow-lift); padding: 14px; }
  .price-pop-inputs { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .price-pop-inputs input { width: 100%; min-width: 0; box-sizing: border-box; font-size: 13px; padding: 9px 10px; border: 1.5px solid var(--v2-line); border-radius: 10px; background: #fbfcfe; color: var(--v2-ink); }
  .price-pop-inputs input:focus { outline: none; border-color: var(--v2-indigo); background: #fff; }
  .price-pop-inputs span { color: var(--v2-slate-300); }
  :global(html.dark) .price-pop { background: #131a26; border-color: #26303f; }
  :global(html.dark) .price-pop-inputs input { background: #0f1621; border-color: #26303f; color: #e6e9ee; }

  @media (max-width: 900px) { .sb-cell.dest { flex: 1 1 100%; order: -1; } .stay-bar { flex-wrap: wrap; } }

  /* horizontal filter-pills row (listing, above breadcrumbs) */
  /* nowrap (not overflow-x:auto) — auto-scroll would force overflow-y to compute as auto too (CSS2.1
     visible/auto pairing rule), clipping the fp-pop popovers below. Nowrap keeps everything on one line
     without an ancestor that can clip a child popover. */
  .filter-pills { display: flex; align-items: center; gap: 7px; flex-wrap: nowrap; margin-bottom: 18px; }
  .fp-btn, .fp-toggle, .fp-item, .fp-clear { flex-shrink: 0; }
  .fp-btn, .fp-toggle { padding: 7px 12px; font-size: 12.5px; }
  .fp-item { position: relative; }
  .fp-btn, .fp-toggle { display: inline-flex; align-items: center; gap: 7px; border: 1.5px solid var(--v2-line); background: var(--v2-surface); color: var(--v2-slate); font-family: var(--font-body); font-size: 13px; font-weight: 600; border-radius: 999px; padding: 8px 14px; cursor: pointer; transition: all var(--transition); white-space: nowrap; }
  .fp-btn:hover, .fp-toggle:hover { border-color: var(--v2-slate-300); }
  .fp-item.active .fp-btn { border-color: var(--v2-indigo); color: var(--v2-indigo); background: var(--v2-indigo-050); }
  .fp-ic { display: flex; flex-shrink: 0; }
  .fp-chev { display: flex; margin-left: 2px; transition: transform var(--transition); color: var(--v2-slate-300); }
  .fp-chev.up { transform: rotate(180deg); }
  .fp-count { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--v2-indigo); color: #fff; font-size: 10px; font-weight: 700; }
  .fp-toggle.on { border-color: var(--v2-indigo); color: var(--v2-indigo); background: var(--v2-indigo-050); }
  .fp-clear { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; border: none; background: none; color: var(--v2-slate); font-size: 13px; font-weight: 600; cursor: pointer; padding: 8px 4px; }
  .fp-clear:hover { color: var(--v2-indigo); }
  .fp-pop { position: absolute; top: calc(100% + 8px); left: 0; z-index: 45; min-width: 220px; background: #fff; border: 1px solid var(--v2-line); border-radius: 14px; box-shadow: var(--shadow-lift); padding: 8px; }
  .fp-opt { display: block; width: 100%; text-align: left; border: none; background: none; padding: 9px 12px; border-radius: 9px; font-size: 13.5px; font-weight: 500; color: var(--v2-ink); cursor: pointer; }
  .fp-opt:hover { background: var(--v2-indigo-050); }
  .fp-opt.on { color: var(--v2-indigo); font-weight: 700; background: var(--v2-indigo-050); }
  .fp-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px; }
  .fp-chip { border: 1.5px solid var(--v2-line); background: #fbfcfe; color: var(--v2-slate); font-size: 13px; font-weight: 600; border-radius: 999px; padding: 6px 12px; cursor: pointer; }
  .fp-chip.on { background: var(--v2-indigo); border-color: var(--v2-indigo); color: #fff; }
  .fp-check { display: flex; align-items: center; gap: 9px; font-size: 13.5px; color: var(--v2-ink); padding: 7px 8px; cursor: pointer; border-radius: 8px; }
  .fp-check:hover { background: #fbfcfe; }
  .fp-check input { accent-color: var(--v2-indigo); width: 16px; height: 16px; }
  :global(html.dark) .fp-btn, :global(html.dark) .fp-toggle { background: #131a26; border-color: #26303f; color: #a8b3c2; }
  :global(html.dark) .fp-pop { background: #131a26; border-color: #26303f; }
  :global(html.dark) .fp-opt, :global(html.dark) .fp-check { color: #e6e9ee; }
  :global(html.dark) .fp-chip { background: #0f1621; border-color: #26303f; color: #a8b3c2; }

  /* ═══════════ HOME (Design Science v2) ═══════════ */
  .home { position: relative; overflow: hidden; padding: clamp(18px, 2.4vw, 32px) 20px 36px; }
  /* hero image: absolute, bleeds from the top-right corner of the viewport, feathers into the bg on the left + bottom */
  .home-media { position: absolute; top: 0; right: 0; width: min(58vw, 980px); height: 520px; pointer-events: none; z-index: 0;
    -webkit-mask-image: linear-gradient(to right, transparent, #000 24%); mask-image: linear-gradient(to right, transparent, #000 24%); }
  .home-media-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .home-media::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 58%, var(--page-bg)); }
  .home-inner { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; }

  /* hero copy — sits on the left over the feathered image */
  .home-hero { margin-bottom: 24px; }
  .home-copy { text-align: left; max-width: 560px; }
  .home-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600;
    color: var(--v2-indigo); background: var(--v2-indigo-050); border: 1px solid rgba(79,70,229,.14);
    border-radius: 999px; padding: 5px 13px; margin-bottom: 16px; }
  .home-eyebrow .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--v2-success); box-shadow: 0 0 0 0 rgba(16,185,129,.5); animation: pulse-dot 2.4s var(--ease-physical) infinite; }
  @keyframes pulse-dot { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,.5); } 70% { box-shadow: 0 0 0 7px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }
  .home-title { font-family: var(--font-display); font-size: clamp(32px, 3.8vw, 50px); font-weight: 800;
    letter-spacing: -.035em; line-height: 1.04; color: var(--v2-ink); margin: 0 0 14px; }
  .home-title .hl { background: linear-gradient(120deg, var(--v2-indigo), var(--v2-violet)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .home-sub { font-size: clamp(14px, 1.5vw, 16px); line-height: 1.6; color: var(--v2-slate); max-width: 420px; margin: 0; }

  /* signature: unified search module — full width, below the hero copy */
  .search-module { position: relative; z-index: 46; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: 20px;
    box-shadow: var(--shadow-lift); padding: 12px; margin: 0 auto; }
  .sm-source { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 2px 4px 10px; }
  .sm-source-lbl { font-size: 12.5px; font-weight: 500; color: var(--v2-slate); }
  .sm-seg { display: inline-flex; gap: 6px; }
  .sm-seg button { display: inline-flex; align-items: center; gap: 7px; border: 1.5px solid var(--v2-line); background: #fff; font-size: 12.5px; font-weight: 600; color: var(--v2-slate); padding: 6px 13px; border-radius: 999px; cursor: pointer; transition: all var(--transition); }
  .sm-seg button img { width: 15px; height: 15px; object-fit: contain; border-radius: 4px; }
  .sm-seg button:hover { border-color: var(--v2-slate-300); }
  .sm-seg button.on { border-color: var(--v2-indigo); color: var(--v2-indigo); background: var(--v2-indigo-050); }
  .sm-source-more { display: inline-flex; align-items: center; justify-content: center; min-width: 34px; height: 30px; padding: 0 8px; border-radius: 999px; background: #f1f5f9; color: var(--v2-slate); font-size: 12.5px; font-weight: 700; cursor: default; }
  :global(html.dark) .sm-seg button { background: #0f1621; border-color: #26303f; }
  :global(html.dark) .sm-source-more { background: #1d2430; }

  .sm-dest { position: relative; display: flex; align-items: center; gap: 12px; padding: 9px 14px;
    border: 1.5px solid var(--v2-line); border-radius: var(--r-input); background: #fbfcfe; transition: border-color var(--transition), background var(--transition), box-shadow var(--transition); }
  .sm-dest:focus-within { border-color: var(--v2-indigo); background: #fff; box-shadow: 0 0 0 4px rgba(79,70,229,.1); }
  .sm-ic { display: flex; color: var(--v2-indigo); flex-shrink: 0; }
  .sm-ic.sm { color: var(--v2-slate); }
  .sm-field { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
  .sm-field label { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--v2-slate-300); }
  .sm-field input, .sm-field select { border: none; background: none; outline: none; color: var(--v2-ink); font-family: var(--font-body); font-weight: 500; }
  .sm-dest .sm-field input { font-size: 15px; padding: 1px 0; }
  .sm-dest .sm-field input::placeholder { color: #aab4c2; font-weight: 400; }

  .sm-controls { display: flex; align-items: stretch; gap: 2px; margin-top: 10px; padding: 4px;
    border: 1.5px solid var(--v2-line); border-radius: var(--r-input); background: #fbfcfe; }
  .sm-cell { display: flex; align-items: center; gap: 10px; flex: 1 1 0; padding: 8px 12px; border-radius: 9px; transition: background var(--transition); min-width: 0; }
  .sm-cell.guests { flex: 1.5 1 0; }
  .sm-cell:hover { background: #fff; }
  .sm-cell input[type="date"] { font-size: 14px; width: 100%; min-width: 0; }
  .sm-div { width: 1px; background: var(--v2-line); margin: 8px 0; flex-shrink: 0; }
  .sm-guests { display: flex; gap: 4px; min-width: 0; }
  .sm-guests select { font-size: 13px; cursor: pointer; padding: 1px 2px; min-width: 0; flex: 1 1 0; }
  .sm-go { display: inline-flex; align-items: center; justify-content: center; gap: 9px; flex-shrink: 0; background: var(--v2-indigo); color: #fff;
    font-family: var(--font-display); font-size: 15px; font-weight: 700; border: none; border-radius: 10px;
    padding: 0 24px; margin-left: 4px; cursor: pointer; transition: transform var(--transition), background var(--transition), box-shadow var(--transition); }
  .sm-go:hover { background: var(--v2-indigo-hover); transform: translateY(-1px); box-shadow: var(--shadow-indigo); }
  .sm-go:active { transform: scale(.98); }
  .sm-go-ic { display: flex; }

  /* custom date trigger + popover */
  .sm-cell.date { position: relative; }
  .sm-cell.date.active { background: #fff; box-shadow: inset 0 0 0 1.5px rgba(79,70,229,.35); }
  .sm-date-btn { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; flex: 1; min-width: 0; border: none; background: none; padding: 0; cursor: pointer; text-align: left; font-family: var(--font-body); }
  .sm-lbl { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--v2-slate-300); }
  .sm-val { font-size: 14px; font-weight: 600; color: var(--v2-ink); white-space: nowrap; }
  .dp-pop { position: absolute; top: calc(100% + 10px); left: 0; z-index: 50; }
  .dp-pop-r { left: auto; right: 0; }
  .dp-backdrop { position: fixed; inset: 0; z-index: 45; background: transparent; border: none; padding: 0; cursor: default; }
  .sm-cell.guests .sm-val { overflow: hidden; text-overflow: ellipsis; }
  :global(html.dark) .sm-val { color: #e6e9ee; }

  /* guests stepper popover */
  .gp-pop { width: 268px; background: #fff; border: 1px solid var(--v2-line); border-radius: 16px; box-shadow: var(--shadow-lift); padding: 8px; }
  .gp-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; }
  .gp-info { display: flex; flex-direction: column; gap: 1px; }
  .gp-name { font-size: 14px; font-weight: 600; color: var(--v2-ink); }
  .gp-hint { font-size: 12px; color: var(--v2-slate); }
  .gp-step { display: flex; align-items: center; gap: 12px; }
  .gp-step button { width: 32px; height: 32px; border-radius: 9px; border: 1.5px solid var(--v2-line); background: #fff; color: var(--v2-indigo); font-size: 19px; line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: all var(--transition); }
  .gp-step button:hover:not(:disabled) { border-color: var(--v2-indigo); background: var(--v2-indigo-050); }
  .gp-step button:disabled { color: var(--v2-slate-300); opacity: .55; cursor: not-allowed; }
  .gp-num { min-width: 18px; text-align: center; font-size: 14px; font-weight: 700; color: var(--v2-ink); }
  .gp-done { width: calc(100% - 8px); margin: 4px 4px 2px; padding: 10px; border: none; border-radius: 11px; background: var(--v2-indigo); color: #fff; font-family: var(--font-display); font-weight: 700; font-size: 14px; cursor: pointer; transition: background var(--transition); }
  .gp-done:hover { background: var(--v2-indigo-hover); }
  :global(html.dark) .gp-pop { background: #131a26; border-color: #26303f; }
  :global(html.dark) .gp-name, :global(html.dark) .gp-num { color: #e6e9ee; }
  :global(html.dark) .gp-step button { background: #0f1621; border-color: #26303f; }

  /* premium autocomplete */
  .dropdown { position: absolute; top: calc(100% + 8px); left: 0; right: 0; background: #fff; border: 1px solid var(--v2-line);
    border-radius: 14px; box-shadow: var(--shadow-lift); z-index: 40; overflow: hidden; max-height: 360px; overflow-y: auto; text-align: left; padding: 6px; }
  .ac-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 11px 12px; border: none; background: none; cursor: pointer; text-align: left; border-radius: 10px; transition: background var(--transition); }
  .ac-item:hover { background: var(--v2-indigo-050); }
  .ac-ic { color: var(--v2-slate); display: flex; }
  .ac-item:hover .ac-ic { color: var(--v2-indigo); }
  .ac-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .ac-name { font-size: 14.5px; font-weight: 600; color: var(--v2-ink); }
  .ac-sub { font-size: 12px; color: var(--v2-slate); }
  .ac-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--v2-slate); background: #f1f5f9; border-radius: 6px; padding: 3px 8px; }

  /* popular destinations — photo cards (image has title + arrow baked in) */
  .dest-block { margin-top: clamp(20px, 2.4vw, 28px); }
  .dest-head-row { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 14px; }
  .dest-head { font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--v2-ink); }
  .dest-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; }
  .dest-tile { position: relative; overflow: hidden; padding: 0; border: none; background: none; cursor: pointer; border-radius: var(--r-card); box-shadow: var(--shadow-soft); aspect-ratio: 540 / 385; transition: transform var(--transition), box-shadow var(--transition); }
  .dest-tile img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform var(--transition-slow); }
  .dest-tile:hover { transform: translateY(-4px); box-shadow: var(--shadow-lift); }
  .dest-tile:hover img { transform: scale(1.05); }
  @media (max-width: 980px) { .dest-grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 560px) { .dest-grid { grid-template-columns: repeat(2, 1fr); } }

  /* saved hotels (homepage) */
  .saved-grid { display: flex; gap: 14px; overflow-x: auto; scroll-snap-type: x proximity; padding-bottom: 4px; }
  .saved-card { flex: 0 0 calc((100% - 3 * 14px) / 4); scroll-snap-align: start; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: var(--r-card); overflow: hidden; cursor: pointer; transition: transform var(--transition), box-shadow var(--transition); }
  .saved-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lift); }
  .saved-card:focus-visible { outline: 2px solid var(--v2-indigo); outline-offset: 2px; }
  .saved-img { position: relative; width: 100%; height: 130px; background: #eef1f6; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .saved-img img { width: 100%; height: 100%; object-fit: cover; }
  .saved-body { display: flex; flex-direction: column; gap: 4px; padding: 12px; }
  .saved-name { font-family: var(--font-display); font-size: 13.5px; font-weight: 700; color: var(--v2-ink); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .saved-addr { font-size: 11.5px; color: var(--v2-slate); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .saved-price { font-size: 13px; font-weight: 700; color: var(--v2-ink); margin-top: 2px; }
  .saved-price small { font-size: 10.5px; font-weight: 500; color: var(--v2-slate); }
  @media (max-width: 980px) { .saved-card { flex-basis: calc((100% - 14px) / 2); } }
  @media (max-width: 560px) { .saved-card { flex-basis: 78%; } }
  :global(html.dark) .saved-card { background: #131a26; border-color: #26303f; }
  :global(html.dark) .saved-name, :global(html.dark) .saved-price { color: #e6e9ee; }

  /* trust */
  .trust { margin-top: clamp(28px, 4vw, 42px); text-align: center; }
  .trust-lbl { display: block; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--v2-slate-300); margin-bottom: 14px; }
  .trust-logos { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px 26px; }
  .trust-logo { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: #b2bccb; letter-spacing: -.01em; transition: color var(--transition); cursor: default; }
  .trust-logo:hover { color: var(--v2-ink); }
  .trust-logo-img { height: 24px; width: auto; object-fit: contain; filter: grayscale(1); opacity: .55; transition: filter var(--transition), opacity var(--transition); }
  .trust-logo-img:hover { filter: grayscale(0); opacity: 1; }
  :global(html.dark) .trust-logo-img { opacity: .7; }

  @media (max-width: 820px) {
    .home-media { opacity: .28; width: 100%; }
    .home-copy { max-width: 100%; }
  }
  @media (max-width: 720px) {
    .sm-controls { flex-wrap: wrap; }
    .sm-div { display: none; }
    .sm-cell { flex: 1 1 44%; }
    .sm-go { flex: 1 1 100%; justify-content: center; padding: 13px 26px; margin-top: 4px; }
    .sm-source { justify-content: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) {
    .home-eyebrow .dot { animation: none; }
    .dest-tile:hover, .sm-go:hover { transform: none; }
  }

  /* page containers */
  .page-title { font-family: var(--font-display); font-size: 26px; font-weight: 800; letter-spacing: -.02em; margin: 0; color: var(--v2-ink); }

  /* breadcrumbs */
  .crumbs { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: 13px; }
  .crumb { border: none; background: none; padding: 0; cursor: pointer; color: var(--v2-slate); font-size: 13px; font-weight: 500; transition: color var(--transition); }
  .crumb:hover { color: var(--v2-indigo); }
  .crumb.on { color: var(--v2-ink); font-weight: 600; cursor: default; }
  .crumb-sep { color: var(--v2-slate-300); }

  /* listing header: titles left, compact search right */
  .listhead { margin-bottom: 20px; }
  .page-count { margin-left: 10px; font-size: 15px; font-weight: 600; color: var(--v2-indigo); }
  .listsearch { position: relative; display: flex; align-items: center; gap: 8px; border: 1.5px solid var(--v2-line); border-radius: var(--r-input); padding: 0 14px; background: var(--v2-surface); min-width: 300px; flex: 0 1 380px; transition: border-color var(--transition), box-shadow var(--transition); }
  .listsearch:focus-within { border-color: var(--v2-indigo); box-shadow: 0 0 0 4px rgba(79,70,229,.1); }
  .listsearch .search-ic { color: var(--v2-slate); display: flex; }
  .listsearch input { flex: 1; border: 0; outline: none; background: transparent; padding: 11px 0; font-size: 14.5px; color: inherit; }
  :global(html.dark) .listsearch { background: #131a26; border-color: #26303f; }
  :global(html.dark) .crumb.on { color: #e6e9ee; }
  @media (max-width: 640px) { .listsearch { min-width: 0; width: 100%; flex-basis: 100%; } }

  /* listing two-column */
  .listing-layout { display: block; }

  /* compare page: main content + small sticky "best per room type" rail */
  .compare-layout { position: relative; }
  /* closed-by-default drawer: main content always keeps the full page width; the panel is a fixed
     overlay that only occupies space while open, toggled by a tab docked on the right edge. */
  /* writing-mode (not a rotate+translate transform) so the box's own layout width is correct and it can
     never end up half off-screen — a rotated box's geometry has to be compensated by hand, this doesn't. */
  .reco-rail-tab {
    position: fixed; top: 50%; right: 0; transform: translateY(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 60;
    background: var(--v2-indigo); color: #fff; border: none; border-radius: 10px 0 0 10px; padding: 14px 9px;
    cursor: pointer; box-shadow: var(--shadow-soft);
  }
  .reco-rail-tab-icon { display: flex; flex-shrink: 0; }
  .reco-rail-tab-text {
    writing-mode: vertical-rl; text-orientation: mixed;
    font-family: var(--font-display); font-size: 12.5px; font-weight: 700; letter-spacing: .02em; white-space: nowrap;
  }
  .reco-rail-tab.open { display: none; }
  .reco-rail-backdrop { position: fixed; inset: 0; background: rgba(15,20,30,.25); z-index: 61; }
  .room-reco-rail {
    position: fixed; top: 0; right: 0; bottom: 0; width: 300px; z-index: 62;
    background: var(--v2-surface); border-left: 1px solid var(--v2-line); box-shadow: var(--shadow-lift);
    padding: 6px; overflow-y: auto;
  }
  .reco-rail-head { display: flex; align-items: center; gap: 7px; font-family: var(--font-display); font-size: 12.5px; font-weight: 700; color: var(--v2-indigo); text-transform: uppercase; letter-spacing: .03em; padding: 14px 10px 10px; }
  .reco-rail-close { margin-left: auto; border: none; background: none; font-size: 20px; line-height: 1; color: var(--v2-slate-300); cursor: pointer; padding: 0 4px; }
  .reco-rail-row { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; text-decoration: none; color: inherit; border-top: 1px solid var(--v2-line); transition: background var(--transition); }
  .reco-rail-row:first-of-type { border-top: none; }
  .reco-rail-row:hover { background: #fbfcfe; }
  .reco-rail-row.nolink { cursor: default; }
  .reco-rail-name { display: block; font-size: 12.5px; font-weight: 700; color: var(--v2-ink); line-height: 1.3; }
  .reco-rail-meal { font-size: 11px; color: var(--v2-slate-300); }
  .reco-rail-offer { display: flex; align-items: center; gap: 7px; }
  .reco-rail-logo { width: 18px; height: 18px; object-fit: contain; border-radius: 5px; background: #fff; border: 1px solid var(--v2-line); padding: 2px; flex-shrink: 0; }
  .reco-rail-price { font-family: var(--font-display); font-size: 13.5px; font-weight: 700; color: var(--v2-success); }
  .reco-rail-price small { font-size: 10px; font-weight: 500; color: var(--v2-slate-300); }
  @media (max-width: 640px) { .room-reco-rail { width: 100%; } }
  :global(html.dark) .reco-rail-tab { background: #6366f1; }
  :global(html.dark) .room-reco-rail { background: #131a26; border-color: #26303f; }
  :global(html.dark) .reco-rail-close { color: #8b97a7; }
  :global(html.dark) .reco-rail-row { border-top-color: #26303f; }
  :global(html.dark) .reco-rail-row:hover { background: #0f1621; }
  :global(html.dark) .reco-rail-name { color: #e6e9ee; }
  :global(html.dark) .reco-rail-logo { background: #1d2430; border-color: #26303f; }

  /* hotel listing grid */
  .hotel-grid { display: flex; flex-direction: column; gap: 16px; }
  .hotel-card { display: grid; grid-template-columns: 232px 1fr 200px; gap: 20px; align-items: stretch; width: 100%; text-align: left; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: var(--r-card); padding: 14px; cursor: pointer; transition: box-shadow var(--transition), border-color var(--transition), transform var(--transition); }
  .hotel-card:hover { border-color: var(--v2-slate-300); box-shadow: var(--shadow-lift); transform: translateY(-2px); }
  .hc-img { position: relative; width: 232px; height: 168px; border-radius: 12px; overflow: hidden; background: #eef1f6; display: flex; align-items: center; justify-content: center; }
  .hc-img img { width: 100%; height: 100%; object-fit: cover; transition: transform var(--transition-slow); }
  .hotel-card:hover .hc-img img { transform: scale(1.05); }
  .hc-noimg { color: #c8ced6; display: flex; }
  .hc-noimg :global(svg) { width: 40px; height: 40px; }
  .hc-rating-pill { position: absolute; top: 10px; left: 10px; display: inline-flex; align-items: center; gap: 3px; background: rgba(255,255,255,.95); color: var(--v2-ink); font-size: 12px; font-weight: 700; border-radius: 8px; padding: 4px 8px; box-shadow: 0 2px 6px rgba(15,23,42,.12); }
  .hc-fav { position: absolute; top: 10px; right: 10px; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; border-radius: 50%; background: rgba(255,255,255,.95); color: var(--v2-slate); cursor: pointer; box-shadow: 0 2px 6px rgba(15,23,42,.12); transition: color var(--transition), transform var(--transition); }
  .hc-fav:hover { transform: scale(1.08); }
  .hc-fav.on { color: var(--v2-danger); }
  .hc-fav.on :global(svg) { fill: currentColor; }
  .hotel-card:focus-visible { outline: 2px solid var(--v2-indigo); outline-offset: 2px; }
  .hc-addr-sep { color: var(--v2-slate-300); margin: 0 2px; }
  .hc-body { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
  .hc-name { margin: 0; font-family: var(--font-display); font-size: 19px; font-weight: 700; color: var(--v2-ink); letter-spacing: -.01em; line-height: 1.25; }
  .hc-addr { display: flex; align-items: flex-start; gap: 5px; margin: 0; color: var(--v2-slate); font-size: 13.5px; line-height: 1.4; }
  .hc-pin { display: inline-flex; color: var(--v2-slate-300); flex-shrink: 0; margin-top: 1px; }
  .hc-pin :global(svg) { width: 15px; height: 15px; }
  .hc-logos { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .hc-logos img { height: 16px; width: auto; object-fit: contain; opacity: .8; }
  .icon-spin { animation: icon-spin 0.8s linear infinite; }
  @keyframes icon-spin { to { transform: rotate(360deg); } }
  .hc-price { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px; text-align: right; white-space: nowrap; border-left: 1px solid var(--v2-line); padding-left: 18px; }
  .hc-amt { font-family: var(--font-display); font-size: 26px; font-weight: 800; color: var(--v2-ink); letter-spacing: -.02em; }
  .hc-per { font-size: 12px; font-weight: 600; color: var(--v2-slate); }
  .hc-tax { font-size: 11px; color: var(--v2-slate-300); }
  .hc-cta { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; background: var(--v2-indigo); color: #fff; font-family: var(--font-display); font-size: 13.5px; font-weight: 700; border-radius: 10px; padding: 9px 16px; transition: background var(--transition); }
  .hotel-card:hover .hc-cta { background: var(--v2-indigo-hover); }
  .hc-cta-ic { display: inline-flex; transition: transform var(--transition); }
  .hc-cta-ic :global(svg) { width: 15px; height: 15px; }
  .hotel-card:hover .hc-cta-ic { transform: translateX(3px); }
  .hotel-skel { height: 196px; border-radius: var(--r-card); background: linear-gradient(90deg,#eef1f6,#f7f9fc,#eef1f6); background-size: 200% 100%; animation: sh 1.2s infinite; }
  :global(html.dark) .hotel-skel { background: linear-gradient(90deg,#161c25,#1d2430,#161c25); background-size: 200% 100%; }
  @keyframes sh { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
  .load-more { display: block; margin: 24px auto 0; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: 12px; padding: 12px 32px; font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--v2-ink); cursor: pointer; transition: all var(--transition); }
  .load-more:hover { border-color: var(--v2-indigo); color: var(--v2-indigo); }
  :global(html.dark) .hc-name, :global(html.dark) .hc-amt { color: #e6e9ee; }
  :global(html.dark) .hc-rating-pill { background: rgba(26,34,51,.95); color: #e6e9ee; }
  :global(html.dark) .hc-price { border-left-color: #26303f; }
  .loading-more, .empty { text-align: center; color: #8b97a7; padding: 24px; }

  /* compare header */
  .hotel-head { display: flex; align-items: stretch; gap: 20px; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: var(--r-card); padding: 16px; margin-bottom: 18px; box-shadow: var(--shadow-soft); }
  .hh-img-wrap { width: 240px; flex: none; display: flex; flex-direction: column; gap: 8px; }
  .hh-img-main { position: relative; width: 240px; height: 200px; }
  .hh-img-btn { position: absolute; inset: 0; padding: 0; border: none; background: none; cursor: zoom-in; }
  .hh-img { width: 100%; height: 100%; border-radius: 14px; object-fit: cover; display: block; }
  .hh-gallery { display: flex; gap: 6px; }
  .hh-gallery-thumb { flex: 1; width: 0; height: 48px; padding: 0; border: 2px solid transparent; border-radius: 8px; overflow: hidden; cursor: pointer; background: none; }
  .hh-gallery-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .hh-gallery-thumb.active { border-color: var(--v2-indigo); }
  .hh-gallery-thumb:hover { opacity: .85; }
  .hh-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
  .hh-stars { display: inline-flex; align-items: center; gap: 6px; color: var(--v2-amber); font-size: 13px; width: fit-content; }
  .hh-stars-lbl { font-size: 12px; font-weight: 600; color: var(--v2-slate); }
  .hh-info h2 { margin: 0; font-family: var(--font-display); font-size: 24px; font-weight: 800; letter-spacing: -.01em; color: var(--v2-ink); line-height: 1.2; }
  .hh-addr { display: flex; align-items: flex-start; gap: 5px; margin: 0; color: var(--v2-slate); font-size: 13.5px; }
  .hh-reviews { margin: 0; color: var(--v2-slate); font-size: 12.5px; }
  .hh-times { margin: 0; color: var(--v2-slate-300); font-size: 12px; }
  .hh-detail { border-top: 1px solid var(--v2-line); margin-top: 14px; padding-top: 14px; display: flex; flex-direction: column; gap: 12px; }
  .hh-desc { margin: 0; color: var(--v2-slate); font-size: 13px; line-height: 1.55; max-width: 76ch; }
  .hh-chip-row { display: flex; flex-wrap: wrap; gap: 7px; }
  .hh-chip { display: inline-flex; align-items: center; gap: 5px; background: #f3f4f9; color: var(--v2-slate); font-size: 12px; font-weight: 500; border-radius: 999px; padding: 5px 12px; }
  .hh-chip-type { background: rgba(79,70,229,.1); color: var(--v2-indigo); font-weight: 700; }
  .hh-chip-amen :global(svg) { color: var(--v2-success); flex-shrink: 0; }
  .hh-best { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 3px; text-align: right; flex: none; padding: 0 20px 0 22px; border-left: 1px solid var(--v2-line); text-decoration: none; }
  .hh-best-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--v2-slate-300); font-weight: 700; }
  .hh-best-val { font-family: var(--font-display); font-size: 30px; font-weight: 800; color: var(--v2-success); line-height: 1.1; }
  .hh-best-src { font-size: 12px; color: var(--v2-slate); }
  .hh-best-cta { display: inline-flex; align-items: center; gap: 7px; background: var(--v2-success); color: #fff; font-family: var(--font-display); font-size: 13px; font-weight: 700; border-radius: 10px; padding: 8px 16px; margin-top: 6px; transition: background var(--transition); }
  .hh-best:hover .hh-best-cta { background: #0d9c6f; }
  .hh-best.nolink { cursor: default; }
  :global(html.dark) .hh-info h2 { color: #e6e9ee; }
  :global(html.dark) .hh-best { border-left-color: #26303f; }
  :global(html.dark) .hh-detail { border-top-color: #26303f; }
  :global(html.dark) .hh-chip { background: #1d2430; color: #cfd6df; }
  :global(html.dark) .hh-chip-type { background: rgba(99,102,241,.18); }

  /* meal-plan glossary */
  .meal-info-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; border: 1.5px solid var(--v2-line); background: var(--v2-surface); color: var(--v2-slate); font-size: 12.5px; font-weight: 600; padding: 6px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; transition: all var(--transition); }
  .meal-info-btn:hover { border-color: var(--v2-indigo); color: var(--v2-indigo); }
  .meal-legend { border: 1px solid var(--v2-line); border-radius: var(--r-card); background: var(--v2-surface); padding: 14px 16px; margin: 0 0 14px; }
  .meal-legend-head { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--v2-ink); margin-bottom: 8px; }
  .meal-legend-row { display: flex; gap: 12px; padding: 7px 0; border-top: 1px solid var(--v2-line); font-size: 13px; }
  .meal-legend-row:first-of-type { border-top: 0; }
  .ml-label { flex: 0 0 130px; font-weight: 700; color: var(--v2-ink); }
  .ml-terms { color: var(--v2-slate); }
  :global(html.dark) .meal-info-btn { background: #131a26; border-color: #26303f; color: #a8b3c2; }
  :global(html.dark) .meal-legend { background: #131a26; border-color: #26303f; }
  :global(html.dark) .meal-legend-head, :global(html.dark) .ml-label { color: #e6e9ee; }
  :global(html.dark) .meal-legend-row { border-top-color: #26303f; }

  /* partner strip (Skyscanner-only agents — supplementary list, keeps the small-card grid) */
  .strip-head { display: flex; align-items: baseline; gap: 12px; margin: 4px 0 12px; }
  .strip-head h3 { font-family: var(--font-display); font-size: 17px; font-weight: 800; margin: 0; color: var(--v2-ink); }
  .rooms-head { margin-top: 30px; }
  .strip { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
  .pcard { display: block; text-align: center; text-decoration: none; color: inherit; background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: 14px; padding: 14px 8px; transition: box-shadow var(--transition), border-color var(--transition); }
  .pcard:hover { border-color: var(--v2-slate-300); box-shadow: var(--shadow-soft); }
  .pcard.best { border-color: var(--v2-success); background: #ecfdf5; }
  .pcard.nolink { cursor: default; }
  .pcard-who { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--v2-slate); margin-bottom: 8px; }
  .pcard-logo { width: 28px; height: 28px; object-fit: contain; border-radius: 7px; background: #fff; border: 1px solid var(--v2-line); padding: 3px; }
  .pcard-amt { font-family: var(--font-display); font-size: 19px; font-weight: 800; color: var(--v2-ink); }
  .pcard-amt small { font-size: 11px; font-weight: 500; color: var(--v2-slate-300); }
  .pcard.best .pcard-amt { color: var(--v2-success); }
  .pcard-tax { font-size: 10.5px; color: var(--v2-slate-300); margin-top: 1px; }
  .pcard-total { font-size: 12px; color: var(--v2-slate); font-weight: 600; margin-top: 2px; }
  .pcard-src { font-size: 10px; color: var(--v2-slate-300); margin-top: 4px; text-transform: uppercase; letter-spacing: .05em; }
  .pcard-src.live { color: var(--v2-success); }
  .usd-star { color: var(--v2-amber); cursor: help; font-weight: 800; }
  .status-line { color: var(--v2-slate); font-size: 13px; margin: 0 2px 16px; }
  :global(html.dark) .pcard { background: #131a26; border-color: #26303f; }
  :global(html.dark) .pcard.best { background: rgba(16,185,129,.12); }
  :global(html.dark) .strip-head h3 { color: #e6e9ee; }

  /* recommendations panel — cheapest hero + ranked list + sold-out tail */
  .reco-panel { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
  .reco-best { display: block; text-decoration: none; color: inherit; background: linear-gradient(135deg, var(--v2-indigo-050), #fff 60%); border: 1.5px solid var(--v2-indigo); border-radius: var(--r-card); padding: 16px 18px; transition: box-shadow var(--transition); }
  .reco-best:hover { box-shadow: var(--shadow-lift); }
  .reco-best-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--v2-indigo); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 10px; }
  .reco-best-row { display: flex; align-items: center; gap: 14px; }
  .reco-logo { object-fit: contain; border-radius: 8px; background: #fff; border: 1px solid var(--v2-line); flex-shrink: 0; }
  .reco-logo.lg { width: 46px; height: 46px; padding: 6px; }
  .reco-logo.sm { width: 26px; height: 26px; padding: 3px; }
  .reco-logo:not(.lg):not(.sm) { width: 32px; height: 32px; padding: 4px; }
  .reco-best-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .reco-best-who { font-family: var(--font-display); font-size: 16px; font-weight: 800; color: var(--v2-ink); }
  .reco-best-total { font-size: 12.5px; color: var(--v2-slate); }
  .reco-best-price { text-align: right; flex-shrink: 0; }
  .reco-best-amt { display: block; font-family: var(--font-display); font-size: 24px; font-weight: 800; color: var(--v2-ink); letter-spacing: -.01em; }
  .reco-best-per { font-size: 11.5px; color: var(--v2-slate); }
  .reco-best-cta { display: inline-flex; align-items: center; gap: 7px; background: var(--v2-indigo); color: #fff; font-family: var(--font-display); font-size: 13.5px; font-weight: 700; border-radius: 10px; padding: 10px 18px; margin-left: 18px; flex-shrink: 0; }
  .reco-best:hover .reco-best-cta { background: var(--v2-indigo-hover); }

  .reco-list { background: var(--v2-surface); border: 1px solid var(--v2-line); border-radius: var(--r-card); overflow: hidden; }
  .reco-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; text-decoration: none; color: inherit; border-top: 1px solid var(--v2-line); transition: background var(--transition); }
  .reco-row:first-child { border-top: none; }
  .reco-row:hover { background: #fbfcfe; }
  .reco-row.nolink { cursor: default; }
  .reco-rank { font-size: 12px; font-weight: 700; color: var(--v2-slate-300); width: 24px; flex-shrink: 0; }
  .reco-who { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--v2-ink); }
  .reco-amt { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--v2-ink); white-space: nowrap; }
  .reco-amt small { font-size: 11px; font-weight: 500; color: var(--v2-slate-300); }
  .reco-total { font-size: 12px; color: var(--v2-slate); white-space: nowrap; }
  .reco-cta { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 700; color: var(--v2-indigo); white-space: nowrap; }

  .reco-unranked { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .reco-unranked-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: #f1f5f9; }
  .reco-unranked-status { font-size: 12px; color: var(--v2-slate-300); }

  :global(html.dark) .reco-best { background: linear-gradient(135deg, rgba(79,70,229,.16), #131a26 60%); }
  :global(html.dark) .reco-list { background: #131a26; border-color: #26303f; }
  :global(html.dark) .reco-row { border-top-color: #26303f; }
  :global(html.dark) .reco-row:hover { background: #0f1621; }
  :global(html.dark) .reco-who, :global(html.dark) .reco-amt, :global(html.dark) .reco-best-who, :global(html.dark) .reco-best-amt { color: #e6e9ee; }
  :global(html.dark) .reco-logo { background: #1d2430; border-color: #26303f; }
  :global(html.dark) .reco-unranked-row { background: #161c25; }

  /* full price matrix */
  /* fixed layout → columns share the width equally and the table always fits (no horizontal scroll) */
  .matrix-wrap { border: 1px solid #ececec; border-radius: 14px; background: #fff; margin-bottom: 8px; overflow: hidden; }
  .matrix { border-collapse: collapse; width: 100%; table-layout: fixed; }
  .matrix thead th { background: #1a2230; color: #cfd6df; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; text-align: left; padding: 12px 14px; }
  .mth-logo { width: 20px; height: 20px; object-fit: contain; border-radius: 6px; background: #fff; padding: 2px; vertical-align: middle; margin-right: 6px; }
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
  @media (max-width: 820px) { .room-grid { grid-template-columns: 1fr; } .strip { grid-template-columns: repeat(3, 1fr); } .hotel-card { grid-template-columns: 120px 1fr; } .hc-price { grid-column: 2; text-align: left; } }
  @media (max-width: 520px) { .strip { grid-template-columns: repeat(2, 1fr); } }

  /* google offers */
  .google-offers { margin-top: 28px; background: #fff; border: 1px solid #ececec; border-radius: 14px; padding: 6px 18px; }
  .google-offers summary { cursor: pointer; font-weight: 700; font-size: 14px; color: #555; padding: 12px 0; }
  .offer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; padding: 6px 0 16px; }
  .offer { display: flex; justify-content: space-between; align-items: center; gap: 8px; text-decoration: none; color: inherit; border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px 12px; }
  .offer:hover { border-color: #cfd6df; }
  .offer-who { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
  .offer-who img { width: 16px; height: 16px; border-radius: 3px; }
  .offer-amt { font-size: 14px; font-weight: 700; }

  .footer { text-align: center; color: #b8c0cc; font-size: 12px; padding: 30px 20px; background: transparent; border-top: none; }
  :global(html.dark) .footer { color: #5a6577; }

  .lightbox { position: fixed; inset: 0; z-index: 200; background: rgba(10,14,22,.88); display: flex; align-items: center; justify-content: center; padding: 40px; cursor: zoom-out; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.5); cursor: default; }
  .lightbox-close { position: fixed; top: 18px; right: 22px; background: rgba(255,255,255,.12); color: #fff; border: none; border-radius: 50%; width: 38px; height: 38px; font-size: 22px; line-height: 1; cursor: pointer; }
  .lightbox-close:hover { background: rgba(255,255,255,.22); }
</style>
