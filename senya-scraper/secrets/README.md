# secrets/

Drop `fb_cookies.txt` here to give SenyaScraper a signed-in Facebook session.
**Everything in this directory except this file is gitignored** — a session
cookie grants full access to the account, so treat it exactly like a password.

    chmod 600 fb_cookies.txt

See ../README.md → "Using a signed-in Facebook account" for how to export it.
