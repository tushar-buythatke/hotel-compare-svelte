<script>
  // One room's cross-partner comparison. room = { room_name, room_class, meals: [{ meal, partners: [{who, price, stay, deepLink}] }] }
  // Partners within each meal are pre-sorted cheapest-first; the cheapest overall in the room is badged.
  // room.thumbnail: a REAL per-room photo when a partner's config extracted one (only some do). Falls back
  // to hotelImage (the hotel's own photo) when no partner supplied a room-specific shot — never fabricated.
  // partnerLogo: { [displayName]: logoSrc } — same map the rest of the page uses, passed down so there's
  // one source of truth for logos rather than a second copy living in this component.
  export let room;
  export let nights = 1;
  export let hotelImage = null;
  export let partnerLogo = {};
  const inr = (v) => (v == null ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));
  $: thumb = room.thumbnail || hotelImage;
  let lightboxOpen = false;
</script>

<div class="room-card">
  <div class="room-head">
    {#if thumb}<button type="button" class="room-thumb-btn" on:click={() => (lightboxOpen = true)}><img class="room-thumb" src={thumb} alt="" /></button>{/if}
    <div class="room-head-text">
      <h4>{room.room_name || room.room_class}</h4>
      <span class="room-cheap">from {inr(room.min)}{#if nights > 1} <small>total</small>{/if}</span>
    </div>
  </div>
  {#each room.meals as m}
    <div class="meal-block">
      <div class="meal-tag">{m.meal}</div>
      <div class="partner-rows">
        {#each m.partners as p, i}
          <a class="prow" class:best={i === 0} href={p.deepLink || "#"} target={p.deepLink ? "_blank" : null} rel="noopener" class:nolink={!p.deepLink}>
            <span class="prow-who">
              {#if partnerLogo[p.who]}<img class="prow-logo" src={partnerLogo[p.who]} alt="" />{/if}
              {p.who}
            </span>
            <span class="prow-pn">
              {inr(p.price)}{#if p.approx}<span class="usd-star" title="Approximate — Agoda prices are converted from USD at the current rate">*</span>{/if}<small>/night</small>
              {#if p.tax}<small class="prow-brk">{inr(p.base)} + {inr(p.tax)} tax</small>{/if}
            </span>
            {#if nights > 1}<span class="prow-total">{inr(p.stay)} <small>· {nights}n</small></span>{/if}
            <span class="prow-go">{#if p.deepLink}Book <span class="prow-go-ic">→</span>{/if}</span>
          </a>
        {/each}
      </div>
    </div>
  {/each}
</div>

{#if lightboxOpen && thumb}
  <div class="room-lightbox" on:click={() => (lightboxOpen = false)}>
    <button type="button" class="room-lightbox-close" on:click={() => (lightboxOpen = false)} aria-label="Close">×</button>
    <img src={thumb} alt="" on:click|stopPropagation />
  </div>
{/if}

<style>
  .room-card { border: 1px solid var(--v2-line); border-radius: var(--r-card); background: var(--v2-surface); overflow: hidden; box-shadow: var(--shadow-soft); }
  .room-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #fbfcfe; border-bottom: 1px solid var(--v2-line); }
  .room-thumb-btn { padding: 0; border: none; background: none; cursor: zoom-in; flex-shrink: 0; }
  .room-thumb { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; flex-shrink: 0; display: block; }
  .room-head-text { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex: 1; min-width: 0; }
  .room-head-text h4 { margin: 0; font-family: var(--font-display); font-size: 14.5px; font-weight: 700; color: var(--v2-ink); }
  .room-cheap { font-size: 13.5px; font-weight: 700; color: var(--v2-success); white-space: nowrap; }
  .room-cheap small { font-weight: 500; color: var(--v2-slate-300); font-size: 11px; }
  .meal-block { padding: 6px 0; border-bottom: 1px solid var(--v2-line); }
  .meal-block:last-child { border-bottom: none; }
  .meal-tag { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--v2-slate-300); padding: 6px 16px 2px; }
  .partner-rows { display: flex; flex-direction: column; }
  .prow {
    display: grid; grid-template-columns: 1.3fr 1fr auto; align-items: center; gap: 10px;
    padding: 9px 16px; text-decoration: none; color: inherit; border-radius: 8px; margin: 0 6px;
  }
  .prow:hover { background: #f7f9ff; }
  .prow.best { background: #ecfdf5; }
  .prow.best:hover { background: #e1fbef; }
  .prow.nolink { cursor: default; }
  .prow-who { font-size: 13.5px; font-weight: 600; color: var(--v2-ink); display: flex; align-items: center; gap: 8px; min-width: 0; }
  .prow-logo { width: 18px; height: 18px; object-fit: contain; border-radius: 5px; background: #fff; border: 1px solid var(--v2-line); padding: 2px; flex-shrink: 0; }
  .prow.best .prow-who { color: var(--v2-success); }
  .prow-pn { font-size: 14.5px; font-weight: 700; color: var(--v2-ink); text-align: right; }
  .prow.best .prow-pn { color: var(--v2-success); }
  .prow-brk { display: block; font-size: 11px; font-weight: 400; color: var(--v2-slate-300); }
  .prow-pn small, .prow-total small { font-size: 10px; font-weight: 500; color: var(--v2-slate-300); }
  .prow-total { font-size: 12.5px; color: var(--v2-slate); text-align: right; white-space: nowrap; }
  .prow-go { font-size: 12px; font-weight: 700; color: var(--v2-indigo); text-align: right; min-width: 46px; }
  .prow-go-ic { display: inline-block; transition: transform .15s; }
  .prow:hover .prow-go-ic { transform: translateX(2px); }
  .usd-star { color: var(--v2-amber); cursor: help; font-weight: 800; }

  :global(html.dark) .room-card { background: #131a26; border-color: #26303f; }
  :global(html.dark) .room-head { background: #0f1621; border-bottom-color: #26303f; }
  :global(html.dark) .room-head-text h4 { color: #e6e9ee; }
  :global(html.dark) .meal-block { border-bottom-color: #26303f; }
  :global(html.dark) .prow-who, :global(html.dark) .prow-pn { color: #e6e9ee; }
  :global(html.dark) .prow:hover { background: #1d2636; }
  :global(html.dark) .prow.best { background: rgba(16,185,129,.14); }
  :global(html.dark) .prow.best:hover { background: rgba(16,185,129,.2); }
  :global(html.dark) .prow-logo { background: #1d2430; border-color: #26303f; }

  @media (max-width: 560px) {
    .prow { grid-template-columns: 1fr auto; row-gap: 2px; }
    .prow-total, .prow-go { grid-column: 2; text-align: right; }
  }

  .room-lightbox { position: fixed; inset: 0; z-index: 200; background: rgba(10,14,22,.88); display: flex; align-items: center; justify-content: center; padding: 40px; cursor: zoom-out; }
  .room-lightbox img { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.5); cursor: default; }
  .room-lightbox-close { position: fixed; top: 18px; right: 22px; background: rgba(255,255,255,.12); color: #fff; border: none; border-radius: 50%; width: 38px; height: 38px; font-size: 22px; line-height: 1; cursor: pointer; }
  .room-lightbox-close:hover { background: rgba(255,255,255,.22); }
</style>
