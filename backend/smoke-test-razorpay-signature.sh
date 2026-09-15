#!/usr/bin/env bash
# Verifies the security-critical part of the Razorpay integration end to
# end: signature computation and verification. This does NOT need a real
# Razorpay account — verifyCheckout() is pure local HMAC + a DB lookup, it
# never calls Razorpay's network API (only createCheckoutSession and
# cancelSubscription do that, which this script does not exercise). We fake
# the "subscription was created" step by inserting the row directly, exactly
# as createCheckoutSession would have, then prove the same signature formula
# Razorpay's Checkout widget uses is accepted, and that a wrong signature or
# a mismatched subscription id is rejected.
#
# Requires: RAZORPAY_KEY_SECRET set in the server's environment (any value —
# it's only used as an HMAC key here, never sent to Razorpay) and jq/openssl.
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:4000/api}"
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "  PASS: $desc"; PASS=$((PASS+1));
  else echo "  FAIL: $desc -- expected [$want] got [$got]"; FAIL=$((FAIL+1)); fi
}

RAZORPAY_KEY_SECRET="${RAZORPAY_KEY_SECRET:?Set RAZORPAY_KEY_SECRET to the same value the server is running with}"
STAMP=$(date +%s)
EMAIL="razorpaytest-${STAMP}@example.com"
SIGNUP=$(curl -s -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoketest123\",\"displayName\":\"Razorpay Test\"}")
TOKEN=$(echo "$SIGNUP" | jq -r .token)
# /auth/me returns the JWT payload including sub; use it to get the numeric user id reliably.
USER_ID=$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $TOKEN" | jq -r .user.sub)
check "test account created" "$([ "$USER_ID" != "null" ] && echo yes)" "yes"

FAKE_SUB_ID="sub_faketest${STAMP}"
PAYMENT_ID="pay_faketest${STAMP}"

# Simulate what createCheckoutSession() does after calling Razorpay's API —
# insert the 'pending_payment' row directly, using this repo's own DB
# connection settings.
cd "$(dirname "$0")"
node -e "
import('./src/db/pool.js').then(async ({pool}) => {
  await pool.query(
    \`INSERT INTO subscriptions (user_id, tool_slug, tier, status, provider, provider_subscription_id)
     VALUES (\$1,'invoice-generator','pro','pending_payment','razorpay',\$2)
     ON CONFLICT (user_id, tool_slug) DO UPDATE SET status='pending_payment', provider='razorpay', provider_subscription_id=\$2, tier='pro'\`,
    [$USER_ID, '$FAKE_SUB_ID']
  );
  await pool.end();
});
"

CORRECT_SIG=$(printf '%s|%s' "$PAYMENT_ID" "$FAKE_SUB_ID" | openssl dgst -sha256 -hmac "$RAZORPAY_KEY_SECRET" | sed 's/^.* //')

echo "=== Wrong signature is rejected ==="
WRONG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/billing/verify" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toolSlug\":\"invoice-generator\",\"razorpay_payment_id\":\"$PAYMENT_ID\",\"razorpay_subscription_id\":\"$FAKE_SUB_ID\",\"razorpay_signature\":\"0000000000000000000000000000000000000000000000000000000000000000\"}")
check "tampered signature -> 400" "$WRONG_STATUS" "400"

echo "=== Mismatched subscription id is rejected (even with a validly-computed signature for IT) ==="
OTHER_SIG=$(printf '%s|%s' "$PAYMENT_ID" "sub_someoneelses" | openssl dgst -sha256 -hmac "$RAZORPAY_KEY_SECRET" | sed 's/^.* //')
MISMATCH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/billing/verify" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toolSlug\":\"invoice-generator\",\"razorpay_payment_id\":\"$PAYMENT_ID\",\"razorpay_subscription_id\":\"sub_someoneelses\",\"razorpay_signature\":\"$OTHER_SIG\"}")
check "client-claimed subscription id that doesn't match our stored one -> 400" "$MISMATCH_STATUS" "400"

echo "=== Correctly-computed signature (matching Razorpay's own documented formula) is accepted ==="
GOOD_RES=$(curl -s -X POST "$BASE/billing/verify" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toolSlug\":\"invoice-generator\",\"razorpay_payment_id\":\"$PAYMENT_ID\",\"razorpay_subscription_id\":\"$FAKE_SUB_ID\",\"razorpay_signature\":\"$CORRECT_SIG\"}")
check "valid signature -> {ok:true}" "$(echo "$GOOD_RES" | jq -r .ok)" "true"

TOOLS_AFTER=$(curl -s "$BASE/tools" -H "Authorization: Bearer $TOKEN")
check "tool now reports pro tier after verification" "$(echo "$TOOLS_AFTER" | jq -r '.tools[] | select(.slug=="invoice-generator") | .tier')" "pro"

echo "=== Webhook signature verification + event handling ==="
RAZORPAY_WEBHOOK_SECRET="${RAZORPAY_WEBHOOK_SECRET:?Set RAZORPAY_WEBHOOK_SECRET to the same value the server is running with}"
BODY_FILE=$(mktemp)
cat > "$BODY_FILE" <<EOF
{"event":"subscription.charged","payload":{"subscription":{"entity":{"id":"$FAKE_SUB_ID","status":"active","current_end":9999999999,"notes":{"userId":"$USER_ID","toolSlug":"invoice-generator","tier":"pro"}}}}}
EOF
GOOD_WEBHOOK_SIG=$(openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" "$BODY_FILE" | sed 's/^.* //')

BAD_WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/billing/webhook/razorpay" \
  -H 'Content-Type: application/json' -H 'X-Razorpay-Signature: deadbeef' --data-binary "@$BODY_FILE")
check "webhook with wrong signature -> 400" "$BAD_WEBHOOK_STATUS" "400"

GOOD_WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/billing/webhook/razorpay" \
  -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $GOOD_WEBHOOK_SIG" --data-binary "@$BODY_FILE")
check "webhook with correct signature -> 200" "$GOOD_WEBHOOK_STATUS" "200"

STATUS_AFTER_WEBHOOK=$(node -e "
import('./src/db/pool.js').then(async ({pool}) => {
  const { rows } = await pool.query('SELECT status, current_period_end FROM subscriptions WHERE user_id = \$1 AND tool_slug = \$2', [$USER_ID, 'invoice-generator']);
  console.log(rows[0].status);
  await pool.end();
});
")
check "subscription.charged webhook marks it active" "$STATUS_AFTER_WEBHOOK" "active"

echo "=== subscription.cancelled webhook flips it back to free ==="
cat > "$BODY_FILE" <<EOF
{"event":"subscription.cancelled","payload":{"subscription":{"entity":{"id":"$FAKE_SUB_ID","status":"cancelled","notes":{"userId":"$USER_ID","toolSlug":"invoice-generator","tier":"pro"}}}}}
EOF
CANCEL_SIG=$(openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" "$BODY_FILE" | sed 's/^.* //')
curl -s -o /dev/null -X POST "$BASE/billing/webhook/razorpay" -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $CANCEL_SIG" --data-binary "@$BODY_FILE"
rm -f "$BODY_FILE"

TOOLS_AFTER_CANCEL=$(curl -s "$BASE/tools" -H "Authorization: Bearer $TOKEN")
check "tool drops back to free tier after cancellation webhook" "$(echo "$TOOLS_AFTER_CANCEL" | jq -r '.tools[] | select(.slug=="invoice-generator") | .tier')" "free"

echo ""
echo "===== $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]
