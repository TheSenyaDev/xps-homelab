// Display formatting shared by more than one component.

export const money = (v, currency) =>
  v == null ? ""
    : new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: currency || "CAD",
      }).format(v);

export const priceText = (item) =>
  item.price != null ? money(item.price, item.currency) : (item.price_text || "—");
