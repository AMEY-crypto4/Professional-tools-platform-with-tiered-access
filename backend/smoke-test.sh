#!/usr/bin/env bash
# End-to-end smoke test against a live server + real Postgres. Proves the
# vertical slice actually works: signup/login, the tools/tiers dashboard, the
# owner-email bypass, and Invoice Generator's CRUD + free-tier limit + PDF.
# Requires: the API running on :4000, and `jq` installed.
set -euo pipefail
BASE=http://127.0.0.1:4000/api
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $desc -- expected [$want] got [$got]"
    FAIL=$((FAIL+1))
  fi
}

STAMP=$(date +%s)
NORMAL_EMAIL="smoketest+${STAMP}@example.com"
OWNER_EMAIL="${SMOKE_OWNER_EMAIL:?Set SMOKE_OWNER_EMAIL to an email listed in the OWNER_EMAILS env var this server was started with}"

login() { curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
signup() { curl -s -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\",\"displayName\":\"$3\"}"; }

echo "=== 1. Health check ==="
HEALTH=$(curl -s "$BASE/health" | jq -r .ok)
check "GET /api/health -> ok:true" "$HEALTH" "true"

echo "=== 2. Signup + login (normal account) ==="
SIGNUP_RES=$(signup "$NORMAL_EMAIL" "smoketest123" "Smoke Test User")
TOKEN=$(echo "$SIGNUP_RES" | jq -r .token)
check "signup returns a token" "$([ "$TOKEN" != "null" ] && [ -n "$TOKEN" ] && echo yes)" "yes"
IS_OWNER=$(echo "$SIGNUP_RES" | jq -r .user.isOwner)
check "new random account is NOT an owner" "$IS_OWNER" "false"

DUP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' -d "{\"email\":\"$NORMAL_EMAIL\",\"password\":\"smoketest123\",\"displayName\":\"dup\"}")
check "duplicate signup -> 409" "$DUP" "409"

BADLOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$NORMAL_EMAIL\",\"password\":\"wrong\"}")
check "wrong password -> 401" "$BADLOGIN" "401"

echo "=== 3. Owner bypass (requires $OWNER_EMAIL in OWNER_EMAILS) ==="
OWNER_RES=$(login "$OWNER_EMAIL" "smoketest123" || true)
OWNER_TOKEN=$(echo "$OWNER_RES" | jq -r .token 2>/dev/null || echo null)
if [ "$OWNER_TOKEN" = "null" ] || [ -z "$OWNER_TOKEN" ]; then
  OWNER_RES=$(signup "$OWNER_EMAIL" "smoketest123" "Platform Owner")
  OWNER_TOKEN=$(echo "$OWNER_RES" | jq -r .token)
fi
OWNER_FLAG=$(echo "$OWNER_RES" | jq -r .user.isOwner)
check "owner-listed email is flagged isOwner" "$OWNER_FLAG" "true"

echo "=== 4. Tools dashboard reflects tier + limits ==="
TOOLS=$(curl -s "$BASE/tools" -H "Authorization: Bearer $TOKEN")
IG_TIER=$(echo "$TOOLS" | jq -r '.tools[] | select(.slug=="invoice-generator") | .tier')
check "new account starts on invoice-generator free tier" "$IG_TIER" "free"
IG_CAP=$(echo "$TOOLS" | jq -r '.tools[] | select(.slug=="invoice-generator") | .limits.max_invoices_per_month')
check "free tier cap is 5 invoices/month" "$IG_CAP" "5"

OWNER_TOOLS=$(curl -s "$BASE/tools" -H "Authorization: Bearer $OWNER_TOKEN")
OWNER_IG_TIER=$(echo "$OWNER_TOOLS" | jq -r '.tools[] | select(.slug=="invoice-generator") | .tier')
check "owner account is on invoice-generator pro tier for free" "$OWNER_IG_TIER" "pro"

echo "=== 5. Invoice Generator: client + invoice CRUD ==="
CLIENT=$(curl -s -X POST "$BASE/invoice-generator/clients" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme Co","email":"billing@acme.test"}')
CLIENT_ID=$(echo "$CLIENT" | jq -r .client.id)
check "client created" "$([ "$CLIENT_ID" != "null" ] && echo yes)" "yes"

make_invoice() {
  curl -s -X POST "$BASE/invoice-generator/invoices" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"clientId\":$CLIENT_ID,\"taxPercent\":10,\"items\":[{\"description\":\"Design work\",\"quantity\":2,\"unitPriceCents\":5000}]}"
}
INV1=$(make_invoice)
INV1_TOTAL=$(echo "$INV1" | jq -r .invoice.total_cents)
check "invoice total = (2 * 5000) * 1.10 = 11000 cents" "$INV1_TOTAL" "11000"
INV1_ID=$(echo "$INV1" | jq -r .invoice.id)

echo "=== 6. Free-tier limit: 5 invoices OK, 6th blocked with 402 ==="
for i in 2 3 4 5; do make_invoice > /dev/null; done
SIXTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/invoice-generator/invoices" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"clientId\":$CLIENT_ID,\"items\":[{\"description\":\"x\",\"quantity\":1,\"unitPriceCents\":100}]}")
check "6th invoice this month -> 402" "$SIXTH_STATUS" "402"

USAGE=$(curl -s "$BASE/invoice-generator/invoices/usage" -H "Authorization: Bearer $TOKEN" | jq -r .usage.used)
check "usage counter reads back as 5" "$USAGE" "5"

echo "=== 7. Recurring invoices are Pro-only ==="
# Clients are scoped per-account, so the owner needs its own client — reusing
# $CLIENT_ID (owned by the normal test account) would 404, not prove anything.
OWNER_CLIENT=$(curl -s -X POST "$BASE/invoice-generator/clients" -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"Owner Test Client"}')
OWNER_CLIENT_ID=$(echo "$OWNER_CLIENT" | jq -r .client.id)
RECUR_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/invoice-generator/invoices" -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"clientId\":$OWNER_CLIENT_ID,\"isRecurring\":true,\"recurrenceInterval\":\"monthly\",\"items\":[{\"description\":\"Retainer\",\"quantity\":1,\"unitPriceCents\":20000}]}")
check "owner (pro tier) CAN create a recurring invoice -> 201" "$RECUR_STATUS" "201"

FREE_RECUR_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/invoice-generator/invoices" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"clientId\":$CLIENT_ID,\"isRecurring\":true,\"recurrenceInterval\":\"monthly\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unitPriceCents\":100}]}")
check "free-tier account CANNOT create a recurring invoice -> 402" "$FREE_RECUR_STATUS" "402"

echo "=== 8. PDF export ==="
PDF_CONTENT_TYPE=$(curl -s -D - -o /dev/null "$BASE/invoice-generator/invoices/$INV1_ID/pdf" -H "Authorization: Bearer $TOKEN" | grep -i '^content-type' | tr -d '\r' | tr '[:upper:]' '[:lower:]')
check "PDF endpoint returns application/pdf" "$PDF_CONTENT_TYPE" "content-type: application/pdf"

echo "=== 9. Status transitions ==="
PAID=$(curl -s -X PATCH "$BASE/invoice-generator/invoices/$INV1_ID/status" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status":"paid"}')
PAID_STATUS=$(echo "$PAID" | jq -r .invoice.status)
check "invoice marked paid" "$PAID_STATUS" "paid"

DELETE_PAID_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/invoice-generator/invoices/$INV1_ID" -H "Authorization: Bearer $TOKEN")
check "deleting a paid (non-draft) invoice -> 409" "$DELETE_PAID_STATUS" "409"

echo "=== 10. Billing endpoints degrade gracefully with no Stripe keys configured ==="
BILLING_CONFIGURED=$(curl -s "$BASE/billing/status" | jq -r .configured)
if [ "$BILLING_CONFIGURED" = "false" ]; then
  CHECKOUT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/billing/checkout" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"toolSlug":"invoice-generator","tier":"pro"}')
  check "checkout with no Stripe key -> 501" "$CHECKOUT_STATUS" "501"
else
  echo "  (Stripe is configured on this server -- skipping the not-configured check)"
fi

echo ""
echo "===== $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]
