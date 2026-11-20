#!/bin/sh
# Web-role container entrypoint.
#
# Session 55: the image ran `node server.js` directly, so Prisma migrations
# never ran on deploy. Every schema change needed somebody to remember to apply
# it by hand against the production database, and one had already been sitting
# unapplied (20260908090000_order_quote_lead_optional) while the code that
# needed it was live. A deploy that ships code expecting a column the database
# does not have is a broken deploy that looks like a successful one.
#
# `prisma migrate deploy` only applies migrations that are already committed to
# prisma/migrations. It never generates one, never prompts, and never resets —
# it is the command Prisma documents for exactly this job.
set -e

# Only meaningful on the Prisma substrate. The JSON substrate has no database,
# and the build sets a placeholder DATABASE_URL that points nowhere.
if [ "$PERSISTENCE_PROVIDER" = "prisma" ]; then
  if [ -z "$DATABASE_URL" ]; then
    echo "[entrypoint] PERSISTENCE_PROVIDER=prisma but DATABASE_URL is empty — refusing to start."
    exit 1
  fi

  echo "[entrypoint] Applying database migrations..."
  if npx --no-install prisma migrate deploy; then
    echo "[entrypoint] Migrations applied."
  else
    # Fail the deploy rather than serve traffic against a schema the code does
    # not match. Render keeps the previous version live when the new one fails
    # to boot, so stopping here is the safe outcome, not the destructive one.
    echo "[entrypoint] Migration failed — refusing to start against a schema this build does not match."
    exit 1
  fi
else
  echo "[entrypoint] PERSISTENCE_PROVIDER=$PERSISTENCE_PROVIDER — skipping migrations."
  # 2026-09-27: the demo site runs on the built-in sample company. The app's
  # own folder is not writable, so the data lives in LEADGEN_DATA_DIR (default
  # /tmp/leadcockpit-demo). It starts from the template when there is no data
  # yet, so a restart gives the demo a fresh sample company.
  export LEADGEN_DATA_DIR="${LEADGEN_DATA_DIR:-/tmp/leadcockpit-demo}"
  if [ ! -f "$LEADGEN_DATA_DIR/app-data.json" ] && [ -f ./demo-seed/app-data.json ]; then
    mkdir -p "$LEADGEN_DATA_DIR"
    cp ./demo-seed/app-data.json "$LEADGEN_DATA_DIR/app-data.json"
    echo "[entrypoint] Demo data: started from the built-in sample company."
  fi
fi

exec node server.js
