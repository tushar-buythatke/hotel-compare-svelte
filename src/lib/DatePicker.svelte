<script>
  // Custom calendar popover. Emits ISO "YYYY-MM-DD" via onSelect. `min` (ISO) disables earlier days.
  export let value = "";
  export let min = "";
  export let onSelect = () => {};
  export let prices = {};   // ISO date -> indicative price (MMT calendar-availability), shown under the day

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];

  const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = (iso) => { if (!iso) return null; const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const selected = parse(value);
  const minD = parse(min);

  // which month the grid shows
  let vy = (selected || today).getFullYear();
  let vm = (selected || today).getMonth();

  function shift(n) {
    vm += n;
    if (vm < 0) { vm = 11; vy--; }
    else if (vm > 11) { vm = 0; vy++; }
  }

  // 6-week grid of Date objects (incl. leading/trailing days from neighbour months)
  $: grid = (() => {
    const first = new Date(vy, vm, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  })();

  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const disabled = (d) => (minD && d < minD) || d < today;

  function choose(d) {
    if (disabled(d)) return;
    onSelect(toISO(d));
  }

  const fmtPrice = (p) => p >= 1000 ? `${Math.round(p / 100) / 10}k` : String(Math.round(p));
</script>

<div class="dp" role="dialog" aria-label="Choose date">
  <div class="dp-head">
    <span class="dp-title">{MONTHS[vm]} {vy}</span>
    <div class="dp-nav">
      <button type="button" on:click={() => shift(-1)} aria-label="Previous month"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg></button>
      <button type="button" on:click={() => shift(1)} aria-label="Next month"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg></button>
    </div>
  </div>

  <div class="dp-dow">{#each DOW as w}<span>{w}</span>{/each}</div>

  <div class="dp-grid">
    {#each grid as d}
      <button
        type="button"
        class="dp-day"
        class:muted={d.getMonth() !== vm}
        class:today={sameDay(d, today)}
        class:selected={sameDay(d, selected)}
        class:priced={!disabled(d) && prices[toISO(d)] != null}
        disabled={disabled(d)}
        on:click={() => choose(d)}
      >
        <span class="dp-daynum">{d.getDate()}</span>
        {#if !disabled(d) && prices[toISO(d)] != null}<span class="dp-hint">₹{fmtPrice(prices[toISO(d)])}</span>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .dp { width: 288px; background: #fff; border: 1px solid var(--v2-line); border-radius: 16px; box-shadow: var(--shadow-lift); padding: 14px; font-family: var(--font-body); }
  .dp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .dp-title { font-family: var(--font-display); font-size: 14.5px; font-weight: 700; color: var(--v2-ink); }
  .dp-nav { display: flex; gap: 4px; }
  .dp-nav button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--v2-line); background: #fff; color: var(--v2-slate); cursor: pointer; transition: all var(--transition); }
  .dp-nav button:hover { color: var(--v2-indigo); border-color: var(--v2-indigo); }
  .dp-dow { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 4px; }
  .dp-dow span { text-align: center; font-size: 11px; font-weight: 600; color: var(--v2-slate-300); padding: 4px 0; }
  .dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .dp-day { height: 40px; border: none; background: none; border-radius: 9px; font-size: 13px; font-weight: 500; color: var(--v2-ink); cursor: pointer; transition: background var(--transition), color var(--transition); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 0; }
  .dp-day:hover:not(:disabled) { background: var(--v2-indigo-050); color: var(--v2-indigo); }
  .dp-day.muted { color: var(--v2-slate-300); }
  .dp-day.today:not(.selected) { box-shadow: inset 0 0 0 1.5px var(--v2-indigo); color: var(--v2-indigo); }
  .dp-day.selected { background: var(--v2-indigo); color: #fff; font-weight: 700; }
  .dp-day:disabled { color: #d7dde5; cursor: not-allowed; }
  .dp-hint { font-size: 9.5px; font-weight: 600; color: var(--v2-slate-300); line-height: 1; }
  .dp-day.selected .dp-hint { color: rgba(255, 255, 255, 0.75); }
  .dp-day.priced:hover:not(:disabled) .dp-hint { color: var(--v2-indigo); }

  :global(html.dark) .dp { background: #131a26; border-color: #26303f; }
  :global(html.dark) .dp-title, :global(html.dark) .dp-day { color: #e6e9ee; }
  :global(html.dark) .dp-nav button { background: #0f1621; border-color: #26303f; }
  :global(html.dark) .dp-day.muted, :global(html.dark) .dp-day:disabled { color: #3f4b5c; }
</style>
