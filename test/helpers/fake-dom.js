// A pinhole DOM, just wide enough to actually RUN the dashboard's inline
// filter script against rendered HTML. The tab/plan/search filtering only
// exists as a string inside renderDashboardHtml's <script>, so asserting on
// the markup alone can never catch a filter that hides rows it shouldn't --
// which is exactly the class of bug this exists for. Everything the script
// touches but the filter doesn't (composer, dismiss) resolves to an empty
// list rather than being stubbed out in detail.

function classListOf(initial) {
  const set = new Set(String(initial || "").split(/\s+/).filter(Boolean));
  return {
    contains: (c) => set.has(c),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)),
    toString: () => [...set].join(" "),
  };
}

function makeEl({ className = "", dataset = {} } = {}) {
  const el = {
    dataset,
    classList: classListOf(className),
    style: {},
    value: "",
    textContent: "",
    disabled: false,
    _listeners: {},
    addEventListener(type, fn) {
      (el._listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of el._listeners[type] || []) fn.call(el, { target: el });
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
  };
  return el;
}

// Attributes off a single opening tag, e.g. `class="x" data-plan="6"`.
function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-z-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// data-tab-bucket -> dataset.tabBucket, matching the browser's camelCasing.
function datasetOf(attrs) {
  const ds = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith("data-")) continue;
    ds[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return ds;
}

export function runDashboardScript(html) {
  const rows = [...html.matchAll(/<tr class="job-row"([^>]*)>/g)].map((m) => makeEl({ className: "job-row", dataset: datasetOf(attrsOf(m[1])) }));

  const buttons = [...html.matchAll(/<button class="((?:tab|plan)-btn[^"]*)"([^>]*)>/g)].map((m) =>
    makeEl({ className: m[1], dataset: datasetOf(attrsOf(m[2])) })
  );
  const tabBtns = buttons.filter((b) => b.classList.contains("tab-btn"));
  const planBtns = buttons.filter((b) => b.classList.contains("plan-btn"));

  const byId = {};
  const document = {
    addEventListener() {},
    createElement: () => makeEl(),
    body: { appendChild() {}, removeChild() {} },
    getElementById(id) {
      if (!html.includes(`id="${id}"`)) return null;
      return (byId[id] ||= makeEl());
    },
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel.includes("tr[data-service]")) return rows;
      if (sel === ".tab-btn") return tabBtns;
      if (sel === ".plan-btn") return planBtns;
      return [];
    },
  };

  const src = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  new Function("document", "navigator", "location", "fetch", "confirm", "setTimeout", src)(
    document,
    {},
    { reload() {} },
    async () => ({ ok: true }),
    () => true,
    () => {}
  );

  return {
    rows,
    tabBtns,
    planBtns,
    byId,
    visible: () => rows.filter((r) => r.style.display !== "none"),
    clickPlan(months) {
      const btn = planBtns.find((b) => b.dataset.tabPlan === String(months));
      if (!btn) throw new Error(`no plan tab for ${months}`);
      btn.dispatch("click");
    },
    clickTab(bucket) {
      const btn = tabBtns.find((b) => b.dataset.tabBucket === bucket);
      if (!btn) throw new Error(`no urgency tab for ${bucket}`);
      btn.dispatch("click");
    },
  };
}

// The number printed on a plan tab, e.g. planTabCount(html, 6).
export function planTabCount(html, months) {
  const m = html.match(new RegExp(`data-tab-plan="${months}"[^>]*>[^<]*<span class="n">(\\d+)</span>`));
  return m ? Number(m[1]) : null;
}
