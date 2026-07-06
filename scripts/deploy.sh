#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# ─── Config ──────────────────────────────────────────────────────────────────

# Require ENVIRONMENT to select which config file to source
: "${ENVIRONMENT:?Set ENVIRONMENT (dev|prod). Usage: ENVIRONMENT=prod $0 [command]}"

DEPLOY_CONFIG=".env.deploy.${ENVIRONMENT}"
if [ ! -f "$DEPLOY_CONFIG" ]; then
    # Migration hint for old .env.deploy users
    if [ -f .env.deploy ]; then
        echo -e "${RED}Found .env.deploy but ENVIRONMENT=${ENVIRONMENT} requires ${DEPLOY_CONFIG}${NC}"
        echo "Rename .env.deploy to .env.deploy.dev (or .env.deploy.prod) to migrate."
    else
        echo -e "${RED}Config file not found: ${DEPLOY_CONFIG}${NC}"
        echo "Copy .env.deploy.example to ${DEPLOY_CONFIG} and set PROJECT_NAME."
    fi
    exit 1
fi

set -a; source "$DEPLOY_CONFIG"; set +a

: "${PROJECT_NAME:?Set PROJECT_NAME in ${DEPLOY_CONFIG} (e.g. valet-prod)}"

# Derived names (all overridable via config file)
CF_WORKER_NAME="${CF_WORKER_NAME:-$PROJECT_NAME}"
PAGES_PROJECT_NAME="${PAGES_PROJECT_NAME:-${PROJECT_NAME}-client}"
PAGES_DEPLOY_BRANCH="${PAGES_DEPLOY_BRANCH:-main}"
FRONTEND_PREVIEW_ORIGIN_SUFFIX="${FRONTEND_PREVIEW_ORIGIN_SUFFIX:-${PAGES_PROJECT_NAME}.pages.dev}"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-${PROJECT_NAME}-db}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-${PROJECT_NAME}-storage}"
MODAL_APP_NAME="${MODAL_APP_NAME:-${PROJECT_NAME}-backend}"
MODAL_LABEL_PREFIX="${MODAL_LABEL_PREFIX:-${ENVIRONMENT}-}"
ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
MODAL_DEPLOY_CMD="${MODAL_DEPLOY_CMD:-uv run --project backend modal deploy}"
API_PUBLIC_URL="${API_PUBLIC_URL:-}"
# Cloudflare Workflows names are account-scoped. The default preserves the
# historical hard-coded name for dev/prod; per-PR envs get ${PROJECT_NAME}-wfi.
WORKFLOW_NAME="${WORKFLOW_NAME:-valet-workflow-interpreter}"

# ─── Shared Helpers ──────────────────────────────────────────────────────────

# Discover D1 database ID. Fails if DB doesn't exist.
discover_d1_id() {
    _resolve_d1_id
    if [ -z "${D1_DATABASE_ID:-}" ] || [ "$D1_DATABASE_ID" = "null" ]; then
        echo -e "${RED}Could not discover D1 database ID for '${D1_DATABASE_NAME}'.${NC}"
        echo "Run: wrangler d1 create ${D1_DATABASE_NAME}"
        exit 1
    fi
    echo -e "${GREEN}✓ D1: ${D1_DATABASE_NAME} (${D1_DATABASE_ID})${NC}"
}

# Discover or create D1 database. Used by cmd_all for first-time setup.
ensure_d1() {
    _resolve_d1_id
    if [ -z "${D1_DATABASE_ID:-}" ] || [ "$D1_DATABASE_ID" = "null" ]; then
        echo "  Creating ${D1_DATABASE_NAME}..."
        wrangler d1 create "$D1_DATABASE_NAME" >/dev/null
        D1_DATABASE_ID=$(wrangler d1 list --json \
            | jq -r --arg name "$D1_DATABASE_NAME" '.[] | select(.name==$name) | .uuid')
    fi
    echo -e "${GREEN}✓ D1: ${D1_DATABASE_NAME} (${D1_DATABASE_ID})${NC}"
}

# Internal: resolve D1_DATABASE_ID from wrangler if not already set.
_resolve_d1_id() {
    if [ -z "${D1_DATABASE_ID:-}" ] || [ "${D1_DATABASE_ID}" = "your-d1-database-id" ]; then
        D1_DATABASE_ID=$(wrangler d1 list --json 2>/dev/null \
            | jq -r --arg name "$D1_DATABASE_NAME" '.[] | select(.name==$name) | .uuid' 2>/dev/null) || true
    fi
}

# Discover Modal backend URL. Required=true (default) exits on failure;
# required=false warns and leaves MODAL_BACKEND_URL empty.
discover_modal_url() {
    local required="${1:-true}"
    if [ -z "${MODAL_BACKEND_URL:-}" ]; then
        if ! command -v modal >/dev/null 2>&1; then
            if [ "$required" = "true" ]; then
                echo -e "${RED}modal CLI not found. Install: uv tool install modal${NC}"; exit 1
            else
                echo -e "${YELLOW}modal CLI not found — MODAL_BACKEND_URL will be empty${NC}"
                MODAL_BACKEND_URL=""
                return
            fi
        fi
        MODAL_WS=$(modal profile current 2>/dev/null | head -1 | awk '{print $1}') || true
        if [ -z "${MODAL_WS:-}" ]; then
            if [ "$required" = "true" ]; then
                echo -e "${RED}Cannot detect Modal workspace. Run: modal token set${NC}"; exit 1
            else
                echo -e "${YELLOW}Cannot detect Modal workspace — MODAL_BACKEND_URL will be empty${NC}"
                MODAL_BACKEND_URL=""
                return
            fi
        fi
        MODAL_BACKEND_URL="https://${MODAL_WS}--${MODAL_LABEL_PREFIX}{label}.modal.run"
        echo -e "${GREEN}✓ Modal (workspace: ${MODAL_WS})${NC}"
    else
        echo -e "${GREEN}✓ Modal URL: ${MODAL_BACKEND_URL}${NC}"
    fi
}

resolve_worker_url() {
    if [ -n "${API_PUBLIC_URL:-}" ]; then
        WORKER_URL="${API_PUBLIC_URL}"
    else
        echo -e "${RED}API_PUBLIC_URL is required in ${DEPLOY_CONFIG}.${NC}"
        echo "Set it to the public Worker origin, e.g. https://${CF_WORKER_NAME}.<account>.workers.dev"
        exit 1
    fi
}

generate_wrangler_config() {
    sed -e "s|\${CF_WORKER_NAME}|${CF_WORKER_NAME}|g" \
        -e "s|\${D1_DATABASE_NAME}|${D1_DATABASE_NAME}|g" \
        -e "s|\${D1_DATABASE_ID}|${D1_DATABASE_ID}|g" \
        -e "s|\${R2_BUCKET_NAME}|${R2_BUCKET_NAME}|g" \
        -e "s|\${ALLOWED_EMAILS}|${ALLOWED_EMAILS}|g" \
        -e "s|\${API_PUBLIC_URL}|${API_PUBLIC_URL}|g" \
        -e "s|\${FRONTEND_PREVIEW_ORIGIN_SUFFIX}|${FRONTEND_PREVIEW_ORIGIN_SUFFIX}|g" \
        -e "s|\${MODAL_BACKEND_URL}|${MODAL_BACKEND_URL}|g" \
        -e "s|\${WORKFLOW_NAME}|${WORKFLOW_NAME}|g" \
        packages/worker/wrangler.toml > packages/worker/wrangler.deploy.toml
}

cleanup_wrangler_config() {
    rm -f packages/worker/wrangler.deploy.toml
}
trap cleanup_wrangler_config EXIT

preflight() {
    echo "Preflight..."
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null || { echo -e "${RED}${cmd} not found${NC}"; exit 1; }
    done
    wrangler whoami >/dev/null 2>&1 || { echo -e "${RED}Not logged into Cloudflare. Run: wrangler login${NC}"; exit 1; }
    echo -e "${GREEN}✓ Cloudflare${NC}"
}

build_client() {
    local worker_url="$1"
    local build_commit_hash
    local build_version_tag=""
    local build_args=()

    build_commit_hash=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "unknown")

    if [ "${ENVIRONMENT}" = "prod" ]; then
        build_version_tag=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
        if [ -z "${build_version_tag}" ] && [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
            build_version_tag="${GITHUB_REF_NAME:-}"
        fi
    else
        build_args=(-- --mode development)
        echo -e "${YELLOW}Building client in development mode (ENVIRONMENT=${ENVIRONMENT})${NC}"
    fi

    echo -e "${GREEN}✓ Build metadata: env=${ENVIRONMENT}, commit=${build_commit_hash}${NC}"
    if [ -n "${build_version_tag}" ]; then
        echo -e "${GREEN}✓ Build version: ${build_version_tag}${NC}"
    fi

    (
        cd packages/client
        VITE_API_URL="${worker_url}/api" \
        VITE_DEPLOY_ENVIRONMENT="${ENVIRONMENT}" \
        VITE_BUILD_COMMIT_HASH="${build_commit_hash}" \
        VITE_BUILD_VERSION_TAG="${build_version_tag}" \
        pnpm run build "${build_args[@]}"
    )
}

pages_branch_alias() {
    echo "$1" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

pages_deployment_url() {
    if [ "$PAGES_DEPLOY_BRANCH" = "main" ]; then
        echo "https://${PAGES_PROJECT_NAME}.pages.dev"
        return
    fi

    echo "https://$(pages_branch_alias "$PAGES_DEPLOY_BRANCH").${PAGES_PROJECT_NAME}.pages.dev"
}

deploy_client_pages() {
    echo -e "${GREEN}✓ Deploying Pages branch: ${PAGES_DEPLOY_BRANCH}${NC}"
    (
        cd packages/client
        wrangler pages deploy dist \
            --project-name="$PAGES_PROJECT_NAME" \
            --branch="$PAGES_DEPLOY_BRANCH"
    )
}

# ─── Subcommands ─────────────────────────────────────────────────────────────

cmd_worker() {
    echo -e "${GREEN}Deploying Worker...${NC}"
    preflight wrangler jq bun
    discover_d1_id
    discover_modal_url
    resolve_worker_url
    echo ""

    # Generate registries
    (cd packages/worker && bun scripts/generate-plugin-registry.ts)

    # Generate config and deploy
    generate_wrangler_config
    DEPLOY_OUT=$(cd packages/worker && wrangler deploy -c wrangler.deploy.toml 2>&1) || {
        echo -e "${RED}Worker deploy failed:${NC}"
        echo "$DEPLOY_OUT"
        exit 1
    }
    echo "$DEPLOY_OUT"
    echo -e "${GREEN}✓ Worker: ${WORKER_URL}${NC}"
}

cmd_migrate() {
    echo -e "${GREEN}Applying D1 migrations...${NC}"
    preflight wrangler jq
    discover_d1_id
    discover_modal_url false
    echo ""

    generate_wrangler_config
    (cd packages/worker && wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote -c wrangler.deploy.toml)
    echo -e "${GREEN}✓ Migrations applied${NC}"
}

cmd_modal() {
    echo -e "${GREEN}Deploying Modal backend (${MODAL_APP_NAME}, labels: ${MODAL_LABEL_PREFIX}*)...${NC}"
    MODAL_APP_NAME="$MODAL_APP_NAME" MODAL_LABEL_PREFIX="$MODAL_LABEL_PREFIX" $MODAL_DEPLOY_CMD backend/app.py
    echo -e "${GREEN}✓ Modal backend deployed (${MODAL_APP_NAME})${NC}"
}

cmd_client() {
    echo -e "${GREEN}Building and deploying client...${NC}"
    preflight wrangler pnpm

    resolve_worker_url
    echo -e "${GREEN}✓ Using API URL: ${WORKER_URL}/api${NC}"
    echo ""

    build_client "${WORKER_URL}"
    deploy_client_pages
    echo -e "${GREEN}✓ Client deployed: $(pages_deployment_url)${NC}"
}

cmd_all() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploying ${PROJECT_NAME} (${ENVIRONMENT})${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    preflight wrangler jq pnpm bun
    discover_modal_url
    resolve_worker_url

    # --- Step 1: Ensure D1 database ---
    echo "Step 1/7: D1 database..."
    ensure_d1

    # --- Step 2: Ensure R2 bucket ---
    echo ""
    echo "Step 2/7: R2 bucket..."
    if ! wrangler r2 bucket list 2>/dev/null | grep -q "$R2_BUCKET_NAME"; then
        echo "  Creating ${R2_BUCKET_NAME}..."
        wrangler r2 bucket create "$R2_BUCKET_NAME" >/dev/null
    fi
    echo -e "${GREEN}✓ R2: ${R2_BUCKET_NAME}${NC}"

    # --- Step 3: Build packages ---
    echo ""
    echo "Step 3/7: Building packages..."
    pnpm --filter '@valet/*' --filter '!@valet/worker' --filter '!@valet/client' run build
    echo -e "${GREEN}✓ Packages built${NC}"

    # --- Step 4: Deploy Worker ---
    echo ""
    echo "Step 4/7: Deploying Worker..."
    (cd packages/worker && bun scripts/generate-plugin-registry.ts)
    generate_wrangler_config

    DEPLOY_OUT=$(cd packages/worker && wrangler deploy -c wrangler.deploy.toml 2>&1) || {
        echo -e "${RED}Worker deploy failed:${NC}"
        echo "$DEPLOY_OUT"
        exit 1
    }
    echo "$DEPLOY_OUT"
    echo -e "${GREEN}✓ Worker: ${WORKER_URL}${NC}"

    # --- Step 5: Run D1 migrations ---
    echo ""
    echo "Step 5/7: Running migrations..."
    (cd packages/worker && wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote -c wrangler.deploy.toml)
    echo -e "${GREEN}✓ Migrations applied${NC}"

    # --- Step 6: Deploy Modal backend ---
    echo ""
    echo "Step 6/7: Deploying Modal backend (${MODAL_APP_NAME}, labels: ${MODAL_LABEL_PREFIX}*)..."
    MODAL_APP_NAME="$MODAL_APP_NAME" MODAL_LABEL_PREFIX="$MODAL_LABEL_PREFIX" $MODAL_DEPLOY_CMD backend/app.py
    echo -e "${GREEN}✓ Modal backend deployed (${MODAL_APP_NAME})${NC}"

    # --- Step 7: Build and deploy client ---
    echo ""
    echo "Step 7/7: Building and deploying client..."
    build_client "${WORKER_URL}"
    deploy_client_pages
    echo -e "${GREEN}✓ Client deployed${NC}"

    # --- Summary ---
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploy complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "  Worker:  ${WORKER_URL}"
    echo "  Client:  $(pages_deployment_url)"
    echo ""
    echo -e "${YELLOW}If this is your first deploy, set worker secrets:${NC}"
    echo "  wrangler secret put ENCRYPTION_KEY --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GITHUB_CLIENT_ID --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GITHUB_CLIENT_SECRET --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GOOGLE_CLIENT_ID --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GOOGLE_CLIENT_SECRET --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put FRONTEND_URL --name ${CF_WORKER_NAME}"
    echo ""
    echo -e "${YELLOW}Or run: ENVIRONMENT=${ENVIRONMENT} make bootstrap-secrets${NC}"
}

# ─── Per-PR ephemeral environments ───────────────────────────────────────────
# Full-stack throwaway env for one PR: Worker + D1 + R2 + Workflows + Pages,
# all named from PROJECT_NAME (e.g. valet-pr-123). Shares the dev Modal
# backend and OAuth apps via passthrough env vars (MODAL_BACKEND_URL,
# GOOGLE_CLIENT_ID/SECRET). Every env runs the minutely cron from
# wrangler.toml, so pr-destroy is mandatory when the PR closes.

# Guard: pr-deploy/pr-destroy create and DELETE resources without prompting.
# Require a per-PR naming pattern so they can never touch dev/prod.
require_pr_project_name() {
    case "$PROJECT_NAME" in
        *-pr-*) ;;
        *)
            echo -e "${RED}PROJECT_NAME='${PROJECT_NAME}' does not look like a per-PR env (expected e.g. valet-pr-123).${NC}"
            echo "Refusing to run ${COMMAND} against non-PR resources."
            exit 1
            ;;
    esac
}

# Non-interactive secret upload (reads value from stdin, never argv/logs).
put_worker_secret() {
    local name="$1" value="$2"
    printf '%s' "$value" | wrangler secret put "$name" --name "$CF_WORKER_NAME" >/dev/null
    echo -e "${GREEN}✓ Secret: ${name}${NC}"
}

cmd_pr_deploy() {
    require_pr_project_name
    # Cloudflare Workflows names are account-scoped — a per-PR worker reusing
    # the dev/prod default would collide, so force a PROJECT_NAME-scoped name.
    if [ "$WORKFLOW_NAME" = "valet-workflow-interpreter" ]; then
        WORKFLOW_NAME="${PROJECT_NAME}-wfi"
    fi

    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploying PR env ${PROJECT_NAME}${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    preflight wrangler jq pnpm bun openssl
    discover_modal_url false
    resolve_worker_url

    echo "Step 1/8: D1 database..."
    ensure_d1

    echo ""
    echo "Step 2/8: R2 bucket..."
    if ! wrangler r2 bucket list 2>/dev/null | grep -q "$R2_BUCKET_NAME"; then
        echo "  Creating ${R2_BUCKET_NAME}..."
        wrangler r2 bucket create "$R2_BUCKET_NAME" >/dev/null
    fi
    echo -e "${GREEN}✓ R2: ${R2_BUCKET_NAME}${NC}"

    echo ""
    echo "Step 3/8: Building packages..."
    pnpm --filter '@valet/*' --filter '!@valet/worker' --filter '!@valet/client' run build
    echo -e "${GREEN}✓ Packages built${NC}"

    # Migrations run BEFORE the first worker deploy: the worker serves traffic
    # (and fires its minutely cron) as soon as it exists, so the schema must
    # already be in place.
    echo ""
    echo "Step 4/8: Applying D1 migrations..."
    (cd packages/worker && bun scripts/generate-plugin-registry.ts)
    generate_wrangler_config
    (cd packages/worker && wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote -c wrangler.deploy.toml)
    echo -e "${GREEN}✓ Migrations applied${NC}"

    echo ""
    echo "Step 5/8: Deploying Worker..."
    DEPLOY_OUT=$(cd packages/worker && wrangler deploy -c wrangler.deploy.toml 2>&1) || {
        echo -e "${RED}Worker deploy failed:${NC}"
        echo "$DEPLOY_OUT"
        exit 1
    }
    echo "$DEPLOY_OUT"
    echo -e "${GREEN}✓ Worker: ${WORKER_URL}${NC}"

    echo ""
    echo "Step 6/8: Setting secrets..."
    # Fresh key per env — PR envs never share encrypted data with dev/prod.
    # Kept across redeploys (`synchronize`): the D1 data survives a redeploy,
    # so rotating the key would invalidate JWT sessions and orphan credentials
    # encrypted under the old key (it backs both jwt.ts and lib/crypto.ts).
    if wrangler secret list --name "$CF_WORKER_NAME" 2>/dev/null | grep -q '"ENCRYPTION_KEY"'; then
        echo -e "${GREEN}✓ Secret: ENCRYPTION_KEY (already set — kept)${NC}"
    else
        put_worker_secret ENCRYPTION_KEY "$(openssl rand -base64 32)"
    fi
    put_worker_secret FRONTEND_URL "$(pages_deployment_url)"
    # Passthrough from the caller's env: PR envs share the dev OAuth apps.
    for secret_name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET; do
        if [ -n "${!secret_name:-}" ]; then
            put_worker_secret "$secret_name" "${!secret_name}"
        fi
    done

    echo ""
    echo "Step 7/8: Seeding test data (API token for smoke tests)..."
    (cd packages/worker && wrangler d1 execute "$D1_DATABASE_NAME" --remote --file scripts/seed-test-data.sql -c wrangler.deploy.toml -y)
    echo -e "${GREEN}✓ Test data seeded${NC}"

    echo ""
    echo "Step 8/8: Client (Pages)..."
    if [ "${PR_ENV_SKIP_CLIENT:-}" = "1" ]; then
        echo -e "${YELLOW}Skipping client deploy (PR_ENV_SKIP_CLIENT=1)${NC}"
    else
        if ! wrangler pages project list 2>/dev/null | grep -q "$PAGES_PROJECT_NAME"; then
            echo "  Creating Pages project ${PAGES_PROJECT_NAME}..."
            wrangler pages project create "$PAGES_PROJECT_NAME" --production-branch "$PAGES_DEPLOY_BRANCH" >/dev/null
        fi
        build_client "${WORKER_URL}"
        deploy_client_pages
        echo -e "${GREEN}✓ Client deployed: $(pages_deployment_url)${NC}"
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}PR env ${PROJECT_NAME} is live${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "  Worker:  ${WORKER_URL}"
    echo "  Client:  $(pages_deployment_url)"
    echo "  Smoke:   WORKER_URL=${WORKER_URL} make smoke-test-api"
    echo ""
    echo -e "${YELLOW}This env runs the minutely cron — destroy it when done:${NC}"
    echo "  ENVIRONMENT=${ENVIRONMENT} make destroy-pr-env"
}

cmd_pr_destroy() {
    require_pr_project_name
    echo -e "${RED}Destroying PR env ${PROJECT_NAME}...${NC}"
    preflight wrangler jq
    echo ""

    echo "Deleting Worker ${CF_WORKER_NAME}..."
    wrangler delete --name "$CF_WORKER_NAME" --force || echo -e "${YELLOW}Worker not found or already deleted${NC}"

    # Deleting the worker orphans its account-scoped Workflow (verified live:
    # `wrangler workflows list` still shows it). The pinned wrangler has no
    # `workflows delete`, so use the REST API when a token is available (CI
    # always has one). Orphans are inert and redeploys overwrite them — this
    # is clutter removal, not correctness.
    if [ "$WORKFLOW_NAME" = "valet-workflow-interpreter" ]; then
        WORKFLOW_NAME="${PROJECT_NAME}-wfi"
    fi
    echo "Deleting Workflow ${WORKFLOW_NAME}..."
    if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
        if curl -sf -X DELETE \
            -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
            "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workflows/${WORKFLOW_NAME}" >/dev/null; then
            echo -e "${GREEN}✓ Workflow deleted${NC}"
        else
            echo -e "${YELLOW}Workflow not found or already deleted${NC}"
        fi
    else
        echo -e "${YELLOW}No CLOUDFLARE_API_TOKEN — orphaned workflow '${WORKFLOW_NAME}' left behind (inert; remove via dash → Workflows)${NC}"
    fi

    echo "Deleting Pages project ${PAGES_PROJECT_NAME}..."
    wrangler pages project delete "$PAGES_PROJECT_NAME" -y || echo -e "${YELLOW}Pages project not found or already deleted${NC}"

    echo "Deleting D1 database ${D1_DATABASE_NAME}..."
    wrangler d1 delete "$D1_DATABASE_NAME" -y || echo -e "${YELLOW}D1 database not found or already deleted${NC}"

    echo "Deleting R2 bucket ${R2_BUCKET_NAME}..."
    wrangler r2 bucket delete "$R2_BUCKET_NAME" || echo -e "${YELLOW}R2 bucket not found, not empty, or already deleted${NC}"

    # Every delete above tolerates "already gone", which also swallows real
    # API failures. The worker is the one resource that bills while it exists
    # (minutely cron), so verify it is actually gone instead of trusting the
    # delete: `deployments list` exits non-zero (code 10007) for a
    # nonexistent worker.
    if wrangler deployments list --name "$CF_WORKER_NAME" >/dev/null 2>&1; then
        echo -e "${RED}Worker ${CF_WORKER_NAME} still exists after teardown — it keeps running the minutely cron.${NC}"
        echo "Re-run: ENVIRONMENT=${ENVIRONMENT} make destroy-pr-env (or delete it in the Cloudflare dash)."
        exit 1
    fi

    echo ""
    echo -e "${GREEN}✓ PR env ${PROJECT_NAME} destroyed${NC}"
}

# ─── Dispatch ────────────────────────────────────────────────────────────────

COMMAND="${1:-all}"
shift || true

case "$COMMAND" in
    worker)   cmd_worker "$@" ;;
    migrate)  cmd_migrate "$@" ;;
    modal)    cmd_modal "$@" ;;
    client)   cmd_client "$@" ;;
    all)      cmd_all "$@" ;;
    pr-deploy)  cmd_pr_deploy "$@" ;;
    pr-destroy) cmd_pr_destroy "$@" ;;
    *)
        echo "Usage: $0 {worker|migrate|modal|client|all|pr-deploy|pr-destroy}"
        echo ""
        echo "  worker   - Deploy Cloudflare Worker (generates registries, discovers config)"
        echo "  migrate  - Apply D1 migrations to production"
        echo "  modal    - Deploy Modal backend"
        echo "  client   - Build and deploy client to Cloudflare Pages"
        echo "  all      - Full deploy (default): all of the above"
        echo "  pr-deploy  - Stamp an ephemeral per-PR env (PROJECT_NAME must contain '-pr-')"
        echo "  pr-destroy - Tear down a per-PR env (worker, Pages, D1, R2)"
        exit 1
        ;;
esac
