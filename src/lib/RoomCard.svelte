<script>
  // One room's cross-partner comparison. room = { room_name, room_class, meals: [{ meal, partners: [{who, price, stay, deepLink}] }] }
  // Partners within each meal are pre-sorted cheapest-first; the cheapest overall in the room is badged.
  export let room;
  export let nights = 1;
  const inr = (v) => (v == null ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));
</script>

<div class="room-card">
  <div class="room-head">
    <h4>{room.room_name || room.room_class}</h4>
    <span class="room-cheap">from {inr(room.min)} <small>total</small></span>
  </div>
  {#each room.meals as m}
    <div class="meal-block">
      <div class="meal-tag">{m.meal}</div>
      <div class="partner-rows">
        {#each m.partners as p, i}
          <a class="prow" class:best={i === 0} href={p.deepLink || "#"} target={p.deepLink ? "_blank" : null} rel="noopener" class:nolink={!p.deepLink}>
            <span class="prow-who">{#if i === 0}<span class="dot"></span>{/if}{p.who}</span>
            <span class="prow-pn">{inr(p.price)}{#if p.approx}<span class="usd-star" title="Approximate — Agoda prices are converted from USD at the current rate">*</span>{/if}<small>/night</small>{#if p.tax}<small class="prow-brk">{inr(p.base)} + {inr(p.tax)} tax</small>{/if}</span>
            <span class="prow-total">{inr(p.stay)} <small>· {nights}n</small></span>
            <span class="prow-go">{#if p.deepLink}Book →{/if}</span>
          </a>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .room-card { border: 1px solid #ececec; border-radius: 14px; background: #fff; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .room-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 18px; background: #fafafa; border-bottom: 1px solid #f0f0f0; }
  .room-head h4 { margin: 0; font-size: 15px; font-weight: 700; color: #1a1a1a; }
  .room-cheap { font-size: 14px; font-weight: 700; color: #1a8917; white-space: nowrap; }
  .room-cheap small { font-weight: 500; color: #8b97a7; font-size: 11px; }
  .meal-block { padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
  .meal-block:last-child { border-bottom: none; }
  .meal-tag { font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #8b97a7; padding: 6px 18px 2px; }
  .partner-rows { display: flex; flex-direction: column; }
  .prow {
    display: grid; grid-template-columns: 1.3fr 1fr 1fr auto; align-items: center; gap: 10px;
    padding: 9px 18px; text-decoration: none; color: inherit; border-radius: 8px; margin: 0 6px;
  }
  .prow:hover { background: #f7f9ff; }
  .prow.best { background: #f0fbf2; }
  .prow.best:hover { background: #e6f7ea; }
  .prow.nolink { cursor: default; }
  .prow-who { font-size: 14px; font-weight: 600; color: #2b2b2b; display: flex; align-items: center; gap: 7px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #1a8917; flex: none; }
  .prow.best .prow-who { color: #1a8917; }
  .prow-pn { font-size: 15px; font-weight: 700; color: #1a1a1a; text-align: right; }
  .prow.best .prow-pn { color: #1a8917; }
  .prow-brk { display: block; font-size: 11px; font-weight: 400; color: #8b97a7; }
  .prow-pn small, .prow-total small { font-size: 10px; font-weight: 500; color: #9aa4b2; }
  .prow-total { font-size: 13px; color: #555; text-align: right; }
  .prow-go { font-size: 12px; font-weight: 700; color: #2f6fed; text-align: right; min-width: 46px; }
  .usd-star { color: #e08a00; cursor: help; font-weight: 800; }
  @media (max-width: 560px) {
    .prow { grid-template-columns: 1fr auto; row-gap: 2px; }
    .prow-total, .prow-go { grid-column: 2; text-align: right; }
  }
</style>
