<script>
  // Two-month range calendar — pick check-in then check-out in one shared view instead of two disconnected
  // single-month popovers, so the whole stay window (and its per-day prices) is visible at once.
  export let ci = "";
  export let co = "";
  export let min = "";
  export let prices = {};
  export let onSelect = () => {};   // (ciISO, coISO) — called once the range is complete
  export let onClose = () => {};

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];

  const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = (iso) => { if (!iso) return null; const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtPrice = (p) => p >= 1000 ? `${Math.round(p / 100) / 10}k` : String(Math.round(p));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const minD = parse(min) || today;

  // Left month starts on check-in's month (or today); right month is always the next one.
  const base = parse(ci) || today;
  let vy = base.getFullYear(), vm = base.getMonth();
  function shift(n) {
    vm += n;
    if (vm < 0) { vm = 11; vy--; }
    else if (vm > 11) { vm = 0; vy++; }
  }
  const monthGrid = (y, m) => {
    const first = new Date(y, m, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  };
  $: leftGrid = monthGrid(vy, vm);
  $: rightVy = vm === 11 ? vy + 1 : vy;
  $: rightVm = vm === 11 ? 0 : vm + 1;
  $: rightGrid = monthGrid(rightVy, rightVm);

  // Picking a start clears the end and waits for a second click; picking an end before the start restarts.
  let picking = "start";
  $: selStart = parse(ci);
  $: selEnd = parse(co);

  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const disabled = (d) => d < minD;
  const inRange = (d) => selStart && selEnd && d > selStart && d < selEnd;

  function choose(d) {
    if (disabled(d)) return;
    if (picking === "start" || !selStart || d <= selStart) {
      ci = toISO(d); co = ""; picking = "end";
    } else {
      co = toISO(d); picking = "start";
      onSelect(ci, co);
      onClose();
    }
  }

  function renderMonth(y, m, grid) {
    return { title: `${MONTHS[m]} ${y}`, grid };
  }
</script>

<div class="rdp" role="dialog" aria-label="Choose check-in and check-out dates">
  <div class="rdp-head">
    <button type="button" class="rdp-nav" on:click={() => shift(-1)} aria-label="Previous month"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg></button>
    <span class="rdp-hint">{picking === "start" ? "Select check-in" : "Select check-out"}</span>
    <button type="button" class="rdp-nav" on:click={() => shift(1)} aria-label="Next month"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg></button>
  </div>

  <div class="rdp-months">
    {#each [renderMonth(vy, vm, leftGrid), renderMonth(rightVy, rightVm, rightGrid)] as mo, i}
      <div class="rdp-month">
        <div class="rdp-title">{mo.title}</div>
        <div class="rdp-dow">{#each DOW as w}<span>{w}</span>{/each}</div>
        <div class="rdp-grid">
          {#each mo.grid as d}
            {@const iso = toISO(d)}
            <button
              type="button"
              class="rdp-day"
              class:muted={d.getMonth() !== (i === 0 ? vm : rightVm)}
              class:today={sameDay(d, today)}
              class:start={sameDay(d, selStart)}
              class:end={sameDay(d, selEnd)}
              class:inrange={inRange(d)}
              class:priced={!disabled(d) && prices[iso] != null}
              disabled={disabled(d)}
              on:click={() => choose(d)}
            >
              <span class="rdp-daynum">{d.getDate()}</span>
              {#if !disabled(d) && prices[iso] != null}<span class="rdp-hint-price">₹{fmtPrice(prices[iso])}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .rdp { width: 616px; background: #fff; border: 1px solid var(--v2-line); border-radius: 16px; box-shadow: var(--shadow-lift); padding: 16px; font-family: var(--font-body); }
  .rdp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .rdp-hint { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--v2-indigo); }
  .rdp-nav { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--v2-line); background: #fff; color: var(--v2-slate); cursor: pointer; transition: all var(--transition); }
  .rdp-nav:hover { color: var(--v2-indigo); border-color: var(--v2-indigo); }
  .rdp-months { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .rdp-title { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--v2-ink); margin-bottom: 8px; text-align: center; }
  .rdp-dow { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 4px; }
  .rdp-dow span { text-align: center; font-size: 11px; font-weight: 600; color: var(--v2-slate-300); padding: 4px 0; }
  .rdp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .rdp-day { height: 42px; border: none; background: none; border-radius: 9px; font-size: 13px; font-weight: 500; color: var(--v2-ink); cursor: pointer; transition: background var(--transition), color var(--transition); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 0; position: relative; }
  .rdp-day:hover:not(:disabled) { background: var(--v2-indigo-050); color: var(--v2-indigo); }
  .rdp-day.muted { color: var(--v2-slate-300); }
  .rdp-day.today:not(.start):not(.end) { box-shadow: inset 0 0 0 1.5px var(--v2-indigo); color: var(--v2-indigo); }
  .rdp-day.inrange { background: var(--v2-indigo-050); border-radius: 0; }
  .rdp-day.start, .rdp-day.end { background: var(--v2-indigo); color: #fff; font-weight: 700; }
  .rdp-day.start { border-radius: 9px 0 0 9px; }
  .rdp-day.end { border-radius: 0 9px 9px 0; }
  .rdp-day.start.end { border-radius: 9px; }
  .rdp-day:disabled { color: #d7dde5; cursor: not-allowed; }
  .rdp-hint-price { font-size: 9.5px; font-weight: 600; color: var(--v2-slate-300); line-height: 1; }
  .rdp-day.start .rdp-hint-price, .rdp-day.end .rdp-hint-price { color: rgba(255, 255, 255, 0.75); }
  .rdp-day.priced:hover:not(:disabled) .rdp-hint-price { color: var(--v2-indigo); }

  @media (max-width: 720px) {
    .rdp { width: 320px; }
    .rdp-months { grid-template-columns: 1fr; gap: 12px; }
  }

  :global(html.dark) .rdp { background: #131a26; border-color: #26303f; }
  :global(html.dark) .rdp-title, :global(html.dark) .rdp-day { color: #e6e9ee; }
  :global(html.dark) .rdp-nav { background: #0f1621; border-color: #26303f; }
  :global(html.dark) .rdp-day.muted, :global(html.dark) .rdp-day:disabled { color: #3f4b5c; }
</style>
