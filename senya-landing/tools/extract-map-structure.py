"""Pull the S&P 500 map structure (sector -> industry -> ticker + market cap)
out of finviz's map_base webpack chunk and write it as compact JSON."""
import re, json, sys

src, dest = sys.argv[1], sys.argv[2]
d = open(src, encoding="utf-8", errors="replace").read()

# The chunk exports one tree: {name:"Root",children:[ <sector>, … ]}
start = d.find('{name:"Root"')
if start < 0:
    sys.exit("map structure not found in chunk")

# Scan forward with a depth counter to the matching close brace.
depth = 0
end = -1
for j in range(start, len(d)):
    c = d[j]
    if c in "[{":
        depth += 1
    elif c in "]}":
        depth -= 1
        if depth == 0:
            end = j
            break
raw = d[start:end + 1]

# Unquoted object keys -> JSON. Values are already quoted strings or numbers.
js = re.sub(r'([{,])(name|description|children|value)\s*:', r'\1"\2":', raw)
tree = json.loads(js)["children"]

out = []
for sec in tree:
    tickers = []
    for ind in sec.get("children", []):
        for t in ind.get("children", []):
            tickers.append({
                "t": t["name"],
                "n": t.get("description", ""),
                "i": ind["name"],
                "v": t["value"],
            })
    tickers.sort(key=lambda x: -x["v"])
    out.append({"sector": sec["name"], "tickers": tickers})

out.sort(key=lambda s: -sum(t["v"] for t in s["tickers"]))
json.dump(out, open(dest, "w"), separators=(",", ":"))
print("sectors:", len(out), "tickers:", sum(len(s["tickers"]) for s in out))
print("largest:", out[0]["sector"], out[0]["tickers"][0])
