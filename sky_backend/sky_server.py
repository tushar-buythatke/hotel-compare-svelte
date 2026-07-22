#!/usr/bin/env python3
"""
Skyscanner backend for the hotel-compare webpage (svelte-Webpage).

Zero dependencies (stdlib only). Wraps Skyscanner's Hotels API (autosuggest -> create -> poll +
content) and normalizes the response into the SAME shapes the webpage's orchestrate.js / App.svelte
already render — so we can search a hotel in the page and see Skyscanner's prices/cards/grid, then judge
whether Skyscanner is worth integrating.

Endpoints (all JSON, CORS: *):
  GET  /suggest?q=<term>
       -> { suggestions: [ {entityId, name, city, type:"hotel", lat, lng, subtext} ] }

  GET  /compare?entityId=<id>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=2&rooms=1&children=
       -> { canonical:{...}, partners:[...], grid:[...] }   (webpage-native shapes)

Run:  python3 sky_server.py   (listens on 127.0.0.1:4460)
"""

import json
import os
import re
import ssl
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

API_BASE = "https://partners.api.skyscanner.net/apiservices"
API_KEY = ""
MARKET, LOCALE, CURRENCY = "IN", "en-GB", "INR"
PORT = 4460

# Every /compare is persisted here so we can analyse offline whether Skyscanner's rooms/prices can be
# merged with our own partner fetches (Hotel-backend/liveDump) by room matching.
DUMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dumps")
os.makedirs(DUMP_DIR, exist_ok=True)

_SSL = ssl.create_default_context()


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:60] or "hotel"


def save_dump(req, payload, raw_rooms, agents):
    """Write one compare result: request + our normalized shape + flat per-room list + agent dict."""
    try:
        name = _slug((payload.get("canonical") or {}).get("hotel_name") or req.get("entityId"))
        fname = f"{name}_{req.get('checkin')}_{req.get('checkout')}_{req.get('adults')}a.json"
        doc = {
            "savedAt": datetime.now(timezone.utc).isoformat(),
            "request": req,
            "canonical": payload.get("canonical"),
            "partners": payload.get("partners"),      # per-agent cheapest (our strip shape)
            "grid": payload.get("grid"),              # our grid rows (room x agent, cheapest per spec)
            "raw_rooms": raw_rooms,                    # FLAT per-room list — the granularity for room matching
            "agents": agents,
        }
        path = os.path.join(DUMP_DIR, fname)
        with open(path, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
        # also append to an index for quick scanning
        with open(os.path.join(DUMP_DIR, "_index.jsonl"), "a") as f:
            f.write(json.dumps({
                "savedAt": doc["savedAt"], "file": fname,
                "hotel": (payload.get("canonical") or {}).get("hotel_name"),
                "entityId": req.get("entityId"), "rooms": len(raw_rooms),
                "agents": sorted({r["agent"] for r in raw_rooms}),
            }) + "\n")
        print(f"[sky] dumped -> dumps/{fname}  ({len(raw_rooms)} rooms)")
        return fname
    except Exception as e:
        print("[sky] dump failed:", e)
        return None


def _post(path, payload, timeout=25):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        API_BASE + path, data=body, method="POST",
        headers={"x-api-key": API_KEY, "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
        return json.loads(r.read().decode())


# ── Skyscanner calls ──────────────────────────────────────────────────────────────────────────────
def sky_autosuggest(term, limit=8):
    r = _post("/v3/autosuggest/hotels", {
        "query": {"market": MARKET, "locale": LOCALE, "searchTerm": term}, "limit": limit,
    })
    return r.get("places", []) or []


def sky_create(entity_id, checkin, checkout, adults, rooms, children_ages):
    def ymd(s):
        y, m, d = s.split("-")
        return {"year": int(y), "month": int(m), "day": int(d)}
    q = {
        "market": MARKET, "locale": LOCALE, "currency": CURRENCY, "entityId": str(entity_id),
        "checkinDate": ymd(checkin), "checkoutDate": ymd(checkout), "adults": int(adults), "rooms": int(rooms),
    }
    if children_ages:
        q["childrenAges"] = children_ages
    return _post("/v1/hotels/live/search/create", {"query": q, "initialPageSize": 25})


def sky_poll(token):
    return _post("/v1/hotels/live/search/poll/" + token,
                 {"pagination": {"limit": 25, "offset": 0},
                  "sort": {"type": "PRICE", "direction": "ASCENDING"}})


def sky_content(hotel_id):
    try:
        r = _post("/v1/hotels/content", {"hotelIds": [str(hotel_id)], "locale": LOCALE})
        return (r.get("hotelsContent") or {}).get(str(hotel_id))
    except Exception:
        return None


# ── Normalizers (Skyscanner enum -> webpage vocabulary) ─────────────────────────────────────────────
MEAL_MAP = {
    "MEAL_PLAN_TYPE_ROOM_ONLY": "Room Only",
    "MEAL_PLAN_TYPE_BREAKFAST_INCLUDED": "With Breakfast",
    "MEAL_PLAN_TYPE_HALF_BOARD": "Half Board",
    "MEAL_PLAN_TYPE_FULL_BOARD": "Full Board",
    "MEAL_PLAN_TYPE_ALL_INCLUSIVE": "All Inclusive",
    "MEAL_PLAN_TYPE_UNSPECIFIED": "Room Only",
}


def meal_label(mp):
    return MEAL_MAP.get(mp or "", "Room Only")


def stars_num(s):
    m = {"STARS_ONE_STAR": 1, "STARS_TWO_STAR": 2, "STARS_THREE_STAR": 3,
         "STARS_FOUR_STAR": 4, "STARS_FIVE_STAR": 5}
    return m.get(s or "", 0)


_SIG_STRIP = re.compile(
    r"\b(king|queen|twin|double|single|sofa|murphy|bed|beds|room|rooms|with|the|a|an|and|"
    r"size|non|smoking|guest|deluxe)\b", re.I)


def room_sig(name):
    s = (name or "").lower()
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = _SIG_STRIP.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or (name or "").lower().strip()


def nights_between(ci, co):
    from datetime import date
    y1, m1, d1 = map(int, ci.split("-"))
    y2, m2, d2 = map(int, co.split("-"))
    return max(1, (date(y2, m2, d2) - date(y1, m1, d1)).days)


# ── Build the webpage payload from a completed poll ─────────────────────────────────────────────────
def build_compare(poll, content, nights, want_id=None):
    results = (poll.get("content") or {}).get("results") or {}
    agents = results.get("agents") or {}
    all_opts = results.get("hotelsPricingOptions") or {}
    info = results.get("hotelInfo") or {}
    hc_poll = results.get("hotelContent") or {}

    # A hotel-entity search still returns the hotel + nearby alternatives. Keep ONLY the searched hotel's
    # options (keyed "{hotelId}_{optionId}") so we don't mix a cheaper neighbour's rooms into the grid.
    want = str(want_id) if want_id else None
    opts = {k: o for k, o in all_opts.items() if not want or str(o.get("hotelId")) == want}
    if not opts and all_opts:  # requested id not in results → fall back to the single most-quoted hotel
        from collections import Counter
        top = Counter(str(o.get("hotelId")) for o in all_opts.values()).most_common(1)[0][0]
        opts = {k: o for k, o in all_opts.items() if str(o.get("hotelId")) == top}

    # canonical hotel (prefer Content API, fall back to poll's lightweight content/info)
    hid = want
    for o in opts.values():
        hid = o.get("hotelId")
        break
    poll_hc = hc_poll.get(hid) or {}
    poll_hi = info.get(hid) or {}
    c = content or {}
    images = c.get("images") or []
    image = images[0] if images else None
    canonical = {
        "hotel_name": c.get("hotelName") or poll_hc.get("name") or "",
        "city": poll_hc.get("city") or "",
        "address": c.get("hotelStreetAddress") or poll_hc.get("address") or "",
        "star": stars_num(c.get("stars")) or poll_hc.get("starRating") or 0,
        "image": image,
        "hotel_map_id": hid,
        "rating": (c.get("guestRating") or poll_hi.get("guestRating") or {}).get("overall"),
        "reviews": {
            "rating": (c.get("guestRating") or poll_hi.get("guestRating") or {}).get("overall"),
            "count": (c.get("guestRating") or poll_hi.get("guestRating") or {}).get("reviewCount"),
        },
    }

    # grid: group by (room signature, meal); cheapest option per agent per group
    grid = {}
    per_agent = {}  # agent display -> cheapest {night_total, stay_total, deep_link}
    raw_rooms = []  # FLAT, ungrouped per-room list — the granularity we need for room matching
    for o in opts.values():
        price = o.get("price") or {}
        base_stay = price.get("basePrice") or price.get("price") or 0
        tax_stay = sum(f.get("value", 0) for f in (price.get("taxesAndFees") or []))
        if not base_stay:
            continue
        total_stay = base_stay + tax_stay
        agent = agents.get(o.get("agentId"), {})
        who = agent.get("name") or o.get("agentId")
        meal = meal_label(o.get("mealPlan"))
        rname = o.get("roomName") or "Room"
        sig = room_sig(rname) + "|" + meal
        raw_rooms.append({
            "agent": who,
            "agentId": o.get("agentId"),
            "room_name": rname,
            "room_sig": room_sig(rname),
            "room_type_enum": o.get("roomType"),
            "meal": meal,
            "meal_enum": o.get("mealPlan"),
            "cancellation": o.get("cancellationPolicy"),
            "payment_type": o.get("paymentType"),
            "base_stay": round(base_stay),
            "tax_stay": round(tax_stay),
            "total_stay": round(total_stay),
            "base_night": round(base_stay / nights),
            "tax_night": round(tax_stay / nights) if tax_stay else 0,
            "total_night": round(total_stay / nights),
            "currency": price.get("currency") or CURRENCY,
            "deep_link": o.get("deeplink") or "",
        })
        cell = {
            "room_type": rname,
            "meal": meal,
            "price": round(base_stay / nights),          # per-night base
            "tax": round(tax_stay / nights) if tax_stay else 0,
            "total": round(total_stay / nights),         # per-night incl tax
            "stay_total": round(total_stay),
            "nights": nights,
            "currency": price.get("currency") or CURRENCY,
            "deep_link": o.get("deeplink") or "",
        }
        row = grid.setdefault(sig, {
            "sig": sig, "room_class": rname, "room_name": rname, "meal": meal, "byPartner": {},
        })
        # keep the fullest room name for display
        if len(rname) > len(row["room_name"]):
            row["room_name"] = rname
        prev = row["byPartner"].get(who)
        if not prev or cell["total"] < prev["total"]:
            row["byPartner"][who] = cell
        # per-agent cheapest (for the partner strip)
        pa = per_agent.get(who)
        if not pa or cell["total"] < pa["min_price"]:
            per_agent[who] = {
                "min_price": cell["total"], "min_stay_total": cell["stay_total"],
                "currency": cell["currency"], "deep_link": cell["deep_link"], "approx": False,
            }

    partners = [
        {"provider": who, "status": "success", "min_price": v["min_price"],
         "min_stay_total": v["min_stay_total"], "currency": v["currency"],
         "approx": v["approx"], "deep_link": v["deep_link"]}
        for who, v in sorted(per_agent.items(), key=lambda kv: kv[1]["min_price"])
    ]
    grid_rows = sorted(
        grid.values(),
        key=lambda r: min((c["total"] for c in r["byPartner"].values()), default=1e12),
    )
    return {"canonical": canonical, "partners": partners, "grid": grid_rows,
            "_raw_rooms": raw_rooms, "_agents": agents}


# ── HTTP handler ────────────────────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[sky]", self.command, self.path.split("?")[0], "-", fmt % args)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/suggest":
                places = sky_autosuggest(qs.get("q", ""))
                out = []
                for p in places:
                    if p.get("type") != "PLACE_TYPE_HOTEL":
                        continue
                    hier = (p.get("hierarchy") or "").split("|")
                    lat, lng = (p.get("location") or ",").split(",")[:2]
                    out.append({
                        "entityId": p.get("entityId"), "name": p.get("name"), "type": "hotel",
                        "city": hier[0] if hier else "", "subtext": ", ".join(hier[:2]),
                        "lat": float(lat) if lat.strip() else None,
                        "lng": float(lng) if lng.strip() else None,
                    })
                return self._send(200, {"suggestions": out})

            if u.path == "/compare":
                entity = qs.get("entityId")
                if not entity:
                    return self._send(400, {"error": "entityId required"})
                ci, co = qs["checkin"], qs["checkout"]
                adults, rooms = qs.get("adults", "2"), qs.get("rooms", "1")
                ages = [int(x) for x in (qs.get("children", "") or "").split(",") if x.strip().isdigit()]
                created = sky_create(entity, ci, co, adults, rooms, ages)
                token = created.get("sessionToken")
                if not token:
                    return self._send(502, {"error": "no sessionToken", "raw": created})
                poll = None
                for _ in range(8):                       # poll up to ~8x
                    poll = sky_poll(token)
                    if poll.get("status") == "RESULT_STATUS_COMPLETE":
                        break
                    time.sleep(2.5)
                content = sky_content(entity)
                payload = build_compare(poll or {}, content, nights_between(ci, co), want_id=entity)
                payload["status"] = (poll or {}).get("status")
                # Persist for offline room-matching analysis, then strip the internal-only keys before
                # sending to the browser.
                raw_rooms = payload.pop("_raw_rooms", [])
                sky_agents = payload.pop("_agents", {})
                save_dump({"entityId": entity, "checkin": ci, "checkout": co,
                           "adults": adults, "rooms": rooms, "children": qs.get("children", "")},
                          payload, raw_rooms, sky_agents)
                return self._send(200, payload)

            return self._send(404, {"error": "not found"})
        except urllib.error.HTTPError as e:
            self._send(e.code, {"error": "skyscanner http %d" % e.code, "detail": e.read().decode()[:400]})
        except Exception as e:
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"Skyscanner backend on http://127.0.0.1:{PORT}  (market={MARKET} currency={CURRENCY})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
