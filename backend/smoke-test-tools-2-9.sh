#!/usr/bin/env bash
# End-to-end smoke test for tools #2-#9 (Invoice Generator has its own
# smoke-test.sh). Proves each tool's CRUD, its tier limit, and — where it
# has one — its signature logic feature (double-booking guard, stock ledger,
# kiosk check-in, queue ticketing) all actually work against a live server
# + real Postgres.
set -euo pipefail
BASE=http://127.0.0.1:4000/api
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "  PASS: $desc"; PASS=$((PASS+1));
  else echo "  FAIL: $desc -- expected [$want] got [$got]"; FAIL=$((FAIL+1)); fi
}

STAMP=$(date +%s)
EMAIL="smoketest2-${STAMP}@example.com"
SIGNUP=$(curl -s -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoketest123\",\"displayName\":\"Tools Smoke Test\"}")
TOKEN=$(echo "$SIGNUP" | jq -r .token)
check "test account created" "$([ "$TOKEN" != "null" ] && echo yes)" "yes"
AUTH=(-H "Authorization: Bearer $TOKEN")

echo "=== Appointment Booking ==="
CLIENT=$(curl -s -X POST "$BASE/appointment-booking/clients" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Jane Client"}')
CLIENT_ID=$(echo "$CLIENT" | jq -r .client.id)
SERVICE=$(curl -s -X POST "$BASE/appointment-booking/services" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Haircut","durationMinutes":30,"priceCents":3000}')
SERVICE_ID=$(echo "$SERVICE" | jq -r .service.id)
check "service created" "$([ "$SERVICE_ID" != "null" ] && echo yes)" "yes"
SECOND_SERVICE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/appointment-booking/services" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Color"}')
check "2nd service on free tier (max_services=1) -> 402" "$SECOND_SERVICE_STATUS" "402"

APPT1=$(curl -s -X POST "$BASE/appointment-booking/appointments" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"clientId\":$CLIENT_ID,\"serviceId\":$SERVICE_ID,\"startTime\":\"2026-10-01T10:00:00Z\"}")
APPT1_ID=$(echo "$APPT1" | jq -r .appointment.id)
check "appointment created" "$([ "$APPT1_ID" != "null" ] && echo yes)" "yes"
OVERLAP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/appointment-booking/appointments" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"clientId\":$CLIENT_ID,\"serviceId\":$SERVICE_ID,\"startTime\":\"2026-10-01T10:15:00Z\"}")
check "overlapping appointment -> 409" "$OVERLAP_STATUS" "409"

echo "=== Expense Tracker ==="
EXP=$(curl -s -X POST "$BASE/expense-tracker/expenses" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"category":"Office","amountCents":5000}')
check "expense created" "$(echo "$EXP" | jq -r '.expense.id != null')" "true"
BUDGET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/expense-tracker/budgets" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"category":"Office","monthlyLimitCents":1000}')
check "budgets are Pro-only -> 402 on free tier" "$BUDGET_STATUS" "402"
SUMMARY=$(curl -s "$BASE/expense-tracker/summary" "${AUTH[@]}")
check "summary totals Office category" "$(echo "$SUMMARY" | jq -r '.summary.categories[0].totalCents')" "5000"

echo "=== Membership Management ==="
MEMBER=$(curl -s -X POST "$BASE/membership-management/members" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Alex Member"}')
MEMBER_ID=$(echo "$MEMBER" | jq -r .member.id)
PAYMENT=$(curl -s -X POST "$BASE/membership-management/members/$MEMBER_ID/payments" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"amountCents":2000,"periodStart":"2020-01-01","periodEnd":"2020-02-01"}')
check "payment recorded" "$(echo "$PAYMENT" | jq -r '.payment.id != null')" "true"
MEMBERS=$(curl -s "$BASE/membership-management/members" "${AUTH[@]}")
check "member shows expired status (period ended in the past)" "$(echo "$MEMBERS" | jq -r '.members[0].membership_status')" "expired"

echo "=== Employee Leave Management ==="
EMP=$(curl -s -X POST "$BASE/leave-management/employees" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Sam Employee"}')
EMP_ID=$(echo "$EMP" | jq -r .employee.id)
REQ=$(curl -s -X POST "$BASE/leave-management/requests" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"employeeId\":$EMP_ID,\"startDate\":\"2026-11-01\",\"endDate\":\"2026-11-03\"}")
REQ_ID=$(echo "$REQ" | jq -r .request.id)
check "leave request starts pending" "$(echo "$REQ" | jq -r .request.status)" "pending"
APPROVED=$(curl -s -X PATCH "$BASE/leave-management/requests/$REQ_ID/status" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"status":"approved"}')
check "leave request approved" "$(echo "$APPROVED" | jq -r .request.status)" "approved"
BAD_DATES=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/leave-management/requests" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"employeeId\":$EMP_ID,\"startDate\":\"2026-11-05\",\"endDate\":\"2026-11-01\"}")
check "end date before start date -> 400" "$BAD_DATES" "400"

echo "=== Inventory Management ==="
PROD=$(curl -s -X POST "$BASE/inventory-management/products" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Widget","quantityOnHand":10,"lowStockThreshold":5}')
PROD_ID=$(echo "$PROD" | jq -r .product.id)
SALE=$(curl -s -X POST "$BASE/inventory-management/products/$PROD_ID/adjust" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"changeQty":-7,"reason":"sale"}')
check "stock reduced by sale (10-7=3)" "$(echo "$SALE" | jq -r .product.quantity_on_hand)" "3"
LOW=$(curl -s "$BASE/inventory-management/products/low-stock" "${AUTH[@]}")
check "product now shows in low-stock (3 <= threshold 5)" "$(echo "$LOW" | jq -r '.products | length')" "1"
OVERSELL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/inventory-management/products/$PROD_ID/adjust" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"changeQty":-100,"reason":"sale"}')
check "selling more than on hand -> 409" "$OVERSELL_STATUS" "409"

echo "=== Staff Attendance (incl. public kiosk) ==="
KIOSK=$(curl -s "$BASE/staff-attendance/kiosk-token" "${AUTH[@]}")
KIOSK_TOKEN=$(echo "$KIOSK" | jq -r .token)
check "kiosk token issued" "$([ "$KIOSK_TOKEN" != "null" ] && echo yes)" "yes"
STAFF=$(curl -s -X POST "$BASE/staff-attendance/employees" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Kim Staff","employeeCode":"K1"}')
check "staff employee created" "$(echo "$STAFF" | jq -r '.employee.id != null')" "true"
CHECKIN=$(curl -s -X POST "$BASE/staff-attendance/kiosk/checkin" -H 'Content-Type: application/json' -d "{\"token\":\"$KIOSK_TOKEN\",\"employeeCode\":\"K1\"}")
check "public kiosk check-in (no auth header sent)" "$(echo "$CHECKIN" | jq -r .action)" "checked_in"
CHECKOUT=$(curl -s -X POST "$BASE/staff-attendance/kiosk/checkin" -H 'Content-Type: application/json' -d "{\"token\":\"$KIOSK_TOKEN\",\"employeeCode\":\"K1\"}")
check "second scan same day checks out" "$(echo "$CHECKOUT" | jq -r .action)" "checked_out"
THIRD_SCAN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/staff-attendance/kiosk/checkin" -H 'Content-Type: application/json' -d "{\"token\":\"$KIOSK_TOKEN\",\"employeeCode\":\"K1\"}")
check "third scan same day -> 409" "$THIRD_SCAN_STATUS" "409"
CSV_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/staff-attendance/export.csv" "${AUTH[@]}")
check "payroll CSV export is Pro-only -> 402 on free tier" "$CSV_STATUS" "402"

echo "=== Property Management ==="
PROP=$(curl -s -X POST "$BASE/property-management/properties" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Maple Apartments"}')
PROP_ID=$(echo "$PROP" | jq -r .property.id)
UNIT=$(curl -s -X POST "$BASE/property-management/properties/$PROP_ID/units" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"unitLabel":"Unit 1A","monthlyRentCents":150000}')
UNIT_ID=$(echo "$UNIT" | jq -r .unit.id)
TENANT=$(curl -s -X POST "$BASE/property-management/units/$UNIT_ID/tenants" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Tenant Tom"}')
check "tenant created under correct unit" "$(echo "$TENANT" | jq -r '.tenant.unit_id')" "$UNIT_ID"
MAINT=$(curl -s -X POST "$BASE/property-management/units/$UNIT_ID/maintenance-requests" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"description":"Leaky faucet"}')
check "maintenance request created" "$(echo "$MAINT" | jq -r '.request.status')" "open"
THIRD_PROPERTY=$(curl -s -X POST "$BASE/property-management/properties" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Second Property"}')
THIRD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/property-management/properties" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Third Property"}')
check "3rd property on free tier (max_properties=2) -> 402" "$THIRD_STATUS" "402"

echo "=== Queue Management (incl. public join) ==="
QUEUE=$(curl -s -X POST "$BASE/queue-management/queues" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"General"}')
QUEUE_ID=$(echo "$QUEUE" | jq -r .queue.id)
JOIN_TOKEN=$(echo "$QUEUE" | jq -r .queue.join_token)
SECOND_QUEUE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/queue-management/queues" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"name":"Billing"}')
check "2nd queue on free tier (max_active_queues=1) -> 402" "$SECOND_QUEUE_STATUS" "402"

JOIN1=$(curl -s -X POST "$BASE/queue-management/public/$JOIN_TOKEN/join" -H 'Content-Type: application/json' -d '{"customerName":"Walk-in A"}')
check "public join (no auth) gets ticket #1" "$(echo "$JOIN1" | jq -r .position)" "1"
JOIN2=$(curl -s -X POST "$BASE/queue-management/public/$JOIN_TOKEN/join" -H 'Content-Type: application/json' -d '{"customerName":"Walk-in B"}')
TICKET2_ID=$(echo "$JOIN2" | jq -r .ticket.id)
check "second public join gets ticket #2" "$(echo "$JOIN2" | jq -r .position)" "2"

STATUS_BEFORE=$(curl -s "$BASE/queue-management/public/$JOIN_TOKEN/tickets/$TICKET2_ID")
check "ticket #2 sees 1 person ahead before any call" "$(echo "$STATUS_BEFORE" | jq -r .ticket.peopleAhead)" "1"

CALLED=$(curl -s -X POST "$BASE/queue-management/queues/$QUEUE_ID/call-next" "${AUTH[@]}")
check "call-next calls ticket #1 (oldest waiting)" "$(echo "$CALLED" | jq -r .ticket.ticket_number)" "1"
STATUS_AFTER=$(curl -s "$BASE/queue-management/public/$JOIN_TOKEN/tickets/$TICKET2_ID")
check "ticket #2 now sees 0 people ahead (ticket #1 no longer waiting)" "$(echo "$STATUS_AFTER" | jq -r .ticket.peopleAhead)" "0"

echo ""
echo "===== $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]
