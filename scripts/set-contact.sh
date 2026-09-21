#!/usr/bin/env bash
# Fill in your name, contact email and GitHub username everywhere at once.
#
# App Store Connect will not accept a submission without a reachable support
# page and privacy policy, and guideline 1.2 wants a published way to reach the
# developer of an app with chat in it. Those details appeared as placeholders in
# six places across the app and the support site, and a single one left behind
# is a dead mailbox shown to someone who has just pressed "Report". This fills
# every one of them, then checks that none are left.
#
# Usage:
#   ./scripts/set-contact.sh "Your Name" you@example.com your-github-username
#
# Nothing is published by this. It only edits files in this repository; putting
# the support site online is a separate step (see support-site/README.md).
set -euo pipefail

if [ $# -ne 3 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

NAME="$1"
EMAIL="$2"
GITHUB="$3"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
say()  { printf '\033[1m%s\033[0m\n' "$*"; }

# Cheap sanity checks. A typo here ends up in a shipped binary and on a public
# page, and the App Store reviewer is the first person likely to notice.
case "$EMAIL" in
  *@*.*) ;;
  *) fail "\"$EMAIL\" does not look like an email address." ;;
esac
case "$EMAIL" in
  *example.invalid*) fail "That is the placeholder, not a real address." ;;
esac
if ! printf '%s' "$GITHUB" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'; then
  fail "\"$GITHUB\" is not a valid GitHub username."
fi
[ -n "$NAME" ] || fail "The name cannot be empty."

REPO="airlink-support"
SITE="https://${GITHUB}.github.io/${REPO}/"
PRIVACY="${SITE}privacy.html"

# Python rather than sed: the values contain characters sed treats as special
# (the @ and dots of an address, the slashes of a URL), and a name can contain
# anything at all, including an apostrophe.
python3 - "$NAME" "$EMAIL" "$SITE" "$PRIVACY" "$GITHUB" <<'PY'
import sys, re, html
name, email, site, privacy, github = sys.argv[1:6]
safe_name = html.escape(name)
safe_email = html.escape(email)

def edit(path, pairs):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    for old, new in pairs:
        text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)

# --- the app: the in-app "Email the developer" button reads these ---------
edit("packages/config/src/brand.ts", [
    ("supportEmail: 'support@example.invalid'", "supportEmail: '" + email.replace("'", "\\'") + "'"),
    ("supportUrl: 'https://example.invalid/airlink/support'", "supportUrl: '" + site + "'"),
])

# --- the support site ------------------------------------------------------
for page in ("support-site/index.html", "support-site/privacy.html"):
    with open(page, encoding="utf-8") as f:
        text = f.read()
    # The labelled markers first, so their surrounding red box goes with them.
    text = text.replace('<span class="edit-me">EDIT ME — support@example.invalid</span>', safe_email)
    text = text.replace('<span class="edit-me">EDIT ME — your name</span>', safe_name)
    text = text.replace("mailto:support@example.invalid", "mailto:" + safe_email)
    # The "Before publishing" box is only true while something is unfilled.
    text = re.sub(r'\s*<!-- OWNER EDIT[^>]*?-->\s*<p class="edit-note">.*?</p>', "", text, flags=re.S)
    with open(page, "w", encoding="utf-8") as f:
        f.write(text)

# --- the listing copy, so what you paste into App Store Connect is right ----
edit("docs/APP_STORE_LISTING.md", [
    ("https://<your-username>.github.io/airlink-support/privacy.html", privacy),
    ("https://<your-username>.github.io/airlink-support/", site),
])
PY

# Refuse to report success while anything is still a placeholder. Scoped to the
# files that ship or get published - the README explains the placeholders, so
# it naturally still mentions them.
LEFT=$(grep -n "example\.invalid\|EDIT ME" \
  packages/config/src/brand.ts support-site/index.html support-site/privacy.html 2>/dev/null || true)
if [ -n "$LEFT" ]; then
  echo "$LEFT" | sed 's/^/  /'
  fail "Some placeholders are still there. The lines above need a look."
fi

say "Done. Every placeholder is filled."
echo "  Contact email : $EMAIL"
echo "  Support URL   : $SITE"
echo "  Privacy URL   : $PRIVACY"
echo
echo "  Those two URLs are what App Store Connect asks for. They only work once"
echo "  the support site is published - see support-site/README.md."
echo "  Rebuild the app so the in-app \"Email the developer\" button appears."
