// Shared state, behind accessors.
//
// Small enough not to need a store, big enough that three components reading
// the same module-level `let` from different files would be a mess. Everything
// mutable that more than one component touches lives here.

let sites = [];            // /api/sites
let currentSearch = null;  // the saved search on screen, if any
let lastRun = null;        // its last run, so views re-render without re-scraping

export const getSites = () => sites;
export const setSites = (v) => { sites = v || []; };
export const siteByKey = (key) => sites.find((s) => s.key === key);
export const siteLabel = (key) => siteByKey(key)?.label || key;

export const getCurrentSearch = () => currentSearch;
export const setCurrentSearch = (v) => { currentSearch = v; };

export const getLastRun = () => lastRun;
export const setLastRun = (v) => { lastRun = v; };

/** True when the results on screen mix markets — controls the per-card badge. */
export const isMultiSite = (items) =>
  new Set(items.map((i) => i.site)).size > 1;
