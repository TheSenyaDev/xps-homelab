// Generates /app/dat/config.json from environment variables on each boot, so the
// CouchDB password and LiveSync passphrases live ONLY in the root .env — never in
// a committed file or baked into the image. Building the JSON in code (rather than
// envsubst on a template) means special characters in passphrases can't break the
// file. The env vars come from docker-compose `environment:` (see root compose).

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const config = {
  peers: [
    {
      type: "couchdb",
      name: "obsidian-couchdb",
      group: "vault",
      url: env("LIVESYNC_COUCHDB_URL", "http://obsidian-couchdb:5984"),
      database: env("LIVESYNC_DATABASE", "obsidian"),
      username: env("COUCHDB_USER"),
      password: env("COUCHDB_PASSWORD"),
      // Must match the Obsidian "Self-hosted LiveSync" plugin exactly. Empty =
      // E2E disabled. obfuscatePassphrase is only used if path obfuscation is on.
      passphrase: env("LIVESYNC_E2E_PASSPHRASE"),
      obfuscatePassphrase: env("LIVESYNC_OBFUSCATE_PASSPHRASE"),
      baseDir: "",
      customChunkSize: 0,
      minimumChunkSize: 20,
      useRemoteTweaks: true,
    },
    {
      type: "storage",
      name: "vault-files",
      group: "vault",
      baseDir: env("LIVESYNC_VAULT_DIR", "/app/data/vault"),
      scanOfflineChanges: true,
      useChokidar: true,
    },
  ],
};

await Deno.mkdir("/app/dat", { recursive: true });
await Deno.writeTextFile("/app/dat/config.json", JSON.stringify(config, null, 2));

const cb = config.peers[0];
console.log(
  `[render-config] wrote /app/dat/config.json — db=${cb.database} ` +
  `e2e=${cb.passphrase ? "on" : "off"} ` +
  `obfuscate=${cb.obfuscatePassphrase ? "on" : "off"} ` +
  `out=${config.peers[1].baseDir}`,
);
if (!cb.username || !cb.password) {
  console.warn("[render-config] WARNING: COUCHDB_USER/COUCHDB_PASSWORD are empty — check .env");
}
