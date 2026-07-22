<script>
  import { createEventDispatcher } from "svelte";
  // Comprehensive listing filters — all map to REAL EMT HotelSearch body params (verified from captures):
  //   selectedRating (stars) · selectedTARating (user rating 5/4/3) · selectedProp · selectedAmen · min/maxPrice · sorttype.
  export let stars = [];        // [5,4,3,2,1]
  export let taRating = [];     // ["5"]=Excellent(4.2+) ["4"]=Very Good(3.5+) ["3"]=Good(3+)
  export let props = [];        // ["Hotel","Resort",...]
  export let amenities = [];    // ["Swimming Pool",...]
  export let sort = "popular";
  export let minPrice = null;
  export let maxPrice = null;

  const dispatch = createEventDispatcher();
  const SORTS = [
    { v: "popular", label: "Popularity" },
    { v: "price_asc", label: "Price: Low to High" },
    { v: "price_desc", label: "Price: High to Low" },
    { v: "rating", label: "Guest rating" },
  ];
  const STARS = [5, 4, 3, 2, 1];
  const TA = [{ v: "5", label: "Excellent · 4.2+" }, { v: "4", label: "Very Good · 3.5+" }, { v: "3", label: "Good · 3+" }];
  const PROPS = ["Hotel", "Resort", "Guest House", "Apartment", "Villa", "Homestay", "Inn"];
  const AMEN = ["Free Cancellation", "Breakfast", "Wi-Fi", "Swimming Pool", "Parking", "AC", "Bar", "Restaurant", "Spa Service", "Fitness", "24 Hour Front Desk"];
  const PRICE_STEPS = [[0, 2000], [2001, 4000], [4001, 8000], [8001, 20000], [20001, 30000], [30001, null]];
  const inr = (v) => "₹" + Math.round(v).toLocaleString("en-IN");

  const emit = () => dispatch("change", { stars, taRating, props, amenities, sort, minPrice: minPrice === "" ? null : minPrice, maxPrice: maxPrice === "" ? null : maxPrice });
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  function tStar(s) { stars = toggle(stars, s); emit(); }
  function tTa(v) { taRating = toggle(taRating, v); emit(); }
  function tProp(v) { props = toggle(props, v); emit(); }
  function tAmen(v) { amenities = toggle(amenities, v); emit(); }
  function onSort(e) { sort = e.target.value; emit(); }
  function setPriceRange(lo, hi) {
    const on = minPrice === lo && (maxPrice ?? null) === hi;
    minPrice = on ? null : lo; maxPrice = on ? null : hi; emit();
  }
  function onPrice() { emit(); }
  function clearAll() { stars = []; taRating = []; props = []; amenities = []; sort = "popular"; minPrice = null; maxPrice = null; emit(); }
  $: active = stars.length || taRating.length || props.length || amenities.length || minPrice != null || maxPrice != null || sort !== "popular";
</script>

<aside class="rail">
  <div class="rail-head"><span>Filters</span>{#if active}<button class="reset" on:click={clearAll}>Reset</button>{/if}</div>

  <section class="fsec">
    <h5>Sort by</h5>
    <select class="sort" bind:value={sort} on:change={onSort}>{#each SORTS as o}<option value={o.v}>{o.label}</option>{/each}</select>
  </section>

  <section class="fsec">
    <h5>Price / night</h5>
    <div class="price-inputs"><input type="number" placeholder="Min" bind:value={minPrice} on:change={onPrice} min="0" /><span>–</span><input type="number" placeholder="Max" bind:value={maxPrice} on:change={onPrice} min="0" /></div>
    <div class="price-steps">
      {#each PRICE_STEPS as [lo, hi]}
        <button class="pstep" class:on={minPrice === lo && (maxPrice ?? null) === hi} on:click={() => setPriceRange(lo, hi)}>
          {hi ? `${inr(lo === 0 ? 1 : lo)} – ${inr(hi)}` : `Above ${inr(lo)}`}
        </button>
      {/each}
    </div>
  </section>

  <section class="fsec">
    <h5>Star rating</h5>
    <div class="chips">{#each STARS as s}<button class="chip" class:on={stars.includes(s)} on:click={() => tStar(s)}>{s}★</button>{/each}</div>
  </section>

  <section class="fsec">
    <h5>Guest rating</h5>
    {#each TA as t}<label class="check"><input type="checkbox" checked={taRating.includes(t.v)} on:change={() => tTa(t.v)} /> {t.label}</label>{/each}
  </section>

  <section class="fsec">
    <h5>Property type</h5>
    {#each PROPS as p}<label class="check"><input type="checkbox" checked={props.includes(p)} on:change={() => tProp(p)} /> {p}</label>{/each}
  </section>

  <section class="fsec">
    <h5>Amenities</h5>
    {#each AMEN as a}<label class="check"><input type="checkbox" checked={amenities.includes(a)} on:change={() => tAmen(a)} /> {a}</label>{/each}
  </section>
</aside>

<style>
  .rail { background: #fff; border: 1px solid #ececec; border-radius: 16px; padding: 4px 18px 18px; position: sticky; top: 150px; align-self: start; }
  .rail-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 0 10px; border-bottom: 1px solid #f0f0f0; }
  .rail-head span { font-size: 16px; font-weight: 800; }
  .reset { background: none; border: none; color: #2f6fed; font-size: 13px; font-weight: 600; cursor: pointer; }
  .reset:hover { text-decoration: underline; }
  .fsec { padding: 14px 0; border-bottom: 1px solid #f5f5f5; }
  .fsec:last-child { border-bottom: none; }
  .fsec h5 { margin: 0 0 10px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: #8b97a7; }
  .sort { width: 100%; box-sizing: border-box; font-size: 13px; padding: 8px 10px; border: 1px solid #dcdcdc; border-radius: 8px; background: #fafafa; cursor: pointer; }
  .sort:focus { outline: none; border-color: #f5a623; }
  .price-inputs { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .price-inputs input { width: 100%; min-width: 0; box-sizing: border-box; font-size: 13px; padding: 8px 10px; border: 1px solid #dcdcdc; border-radius: 8px; background: #fafafa; }
  .price-inputs input:focus { outline: none; border-color: #f5a623; background: #fff; }
  .price-inputs span { color: #b8c0cc; }
  .price-steps { display: flex; flex-direction: column; gap: 6px; }
  .pstep { text-align: left; border: 1px solid #ececec; background: #fafafa; color: #555; font-size: 12px; border-radius: 8px; padding: 7px 10px; cursor: pointer; }
  .pstep:hover { border-color: #f5a623; }
  .pstep.on { background: #fff7e9; border-color: #f5a623; color: #b3730a; font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid #d9d9d9; background: #fafafa; color: #444; font-size: 13px; font-weight: 600; border-radius: 20px; padding: 6px 12px; cursor: pointer; }
  .chip:hover { border-color: #f5a623; }
  .chip.on { background: #f5a623; border-color: #f5a623; color: #1a1a1a; }
  .check { display: flex; align-items: center; gap: 9px; font-size: 13px; color: #333; padding: 5px 0; cursor: pointer; }
  .check input { accent-color: #f5a623; width: 15px; height: 15px; }
</style>
