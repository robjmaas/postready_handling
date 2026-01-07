#!/bin/bash
# Webhook test script for postready-handling

echo "🧪 Testing webhook endpoints..."
echo ""

# Test 1: Health check
echo "✅ Test 1: Health endpoint (GET /health)"
HEALTH=$(curl -s http://localhost:3000/health)
echo "Response: $HEALTH"
echo ""

# Test 2: Webhook with completed status
echo "✅ Test 2: Webhook with completed job"
WEBHOOK=$(curl -s -X POST http://localhost:3000/webhooks/coconut \
  -H "Content-Type: application/json" \
  -d '{"job": {"id": "test-completed-123", "status": "completed", "output": {"mp4": {"url": "https://example.com/output.mp4"}}}}')
echo "Response: $WEBHOOK"
echo ""

# Test 3: Webhook with failed status
echo "✅ Test 3: Webhook with failed job"
WEBHOOK=$(curl -s -X POST http://localhost:3000/webhooks/coconut \
  -H "Content-Type: application/json" \
  -d '{"job": {"id": "test-failed-123", "status": "failed", "errors": ["Transcoding error", "Invalid format"]}}')
echo "Response: $WEBHOOK"
echo ""

# Test 4: Invalid payload
echo "✅ Test 4: Webhook with invalid payload (missing job)"
WEBHOOK=$(curl -s -X POST http://localhost:3000/webhooks/coconut \
  -H "Content-Type: application/json" \
  -d '{"invalid": "payload"}')
echo "Response: $WEBHOOK"
echo ""

echo "🎉 All webhook tests completed!"
