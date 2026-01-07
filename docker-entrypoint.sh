#!/bin/bash
# Load Fly.dev secrets and start the app

# Source secrets from Fly.dev's secrets directory if available
if [ -d /run/secrets ]; then
  for secret in /run/secrets/*; do
    if [ -f "$secret" ]; then
      export "$(basename $secret)"="$(cat $secret)"
      echo "✅ Loaded $(basename $secret) from /run/secrets/"
    fi
  done
fi

# Start the Node.js application
exec npm run start
