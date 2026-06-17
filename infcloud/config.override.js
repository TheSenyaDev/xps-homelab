

// ── Homelab override (appended to config.js at build time) ──────────────────
// Point InfCloud at Baikal's principal collection on the SAME origin: the nginx
// in this container reverse-proxies /dav.php/ to the `baikal` container, so this
// is never a cross-origin request and needs no CORS headers. location.host keeps
// it correct whether you reach it via LAN IP, Tailscale, or a future cal.senya.ca.
//
// The login screen takes a Baikal username (e.g. "Senya") + password. Baikal must
// use Basic auth (dav_auth_type: Basic) — InfCloud's XHR cannot do Digest.
var globalNetworkCheckSettings={
	href: location.protocol+'//'+location.host+'/dav.php/principals/',
	timeOut: 90000,
	lockTimeOut: 10000,
	checkContentType: true,
	settingsAccount: true,
	delegation: true,
	additionalResources: [],
	hrefLabel: null,
	forceReadOnly: null,
	ignoreAlarms: false,
	backgroundCalendars: []
};
