// Dates and labels shared by more than one component.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                            "July", "August", "September", "October", "November",
                            "December"];
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const today = () => new Date().toISOString().slice(0, 10);

/** Local YYYY-MM-DD. Not toISOString(), which converts to UTC and can land on
 *  the wrong day either side of midnight. */
export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
  `${String(d.getDate()).padStart(2, "0")}`;

export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
export const STATUS_LABEL = { todo: "todo", doing: "doing", blocked: "blocked", done: "done" };
// Cycled by the status chip. `done` is deliberately absent — the checkbox owns it.
export const STATUS_RING = ["todo", "doing", "blocked"];

/** "3m ago" / "in 2h" — for the sync chip, where precision is not the point. */
export function relTime(stamp) {
  if (!stamp) return "never";
  const then = new Date(stamp.replace(" ", "T") + (stamp.endsWith("Z") ? "" : "Z"));
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  if (!Number.isFinite(secs)) return "never";
  const abs = Math.abs(secs);
  const [n, unit] = abs < 60 ? [abs, "s"]
    : abs < 3600 ? [Math.round(abs / 60), "m"]
    : abs < 86400 ? [Math.round(abs / 3600), "h"]
    : [Math.round(abs / 86400), "d"];
  return secs >= 0 ? `${n}${unit} ago` : `in ${n}${unit}`;
}
