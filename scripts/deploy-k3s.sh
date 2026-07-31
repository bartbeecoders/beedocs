#!/bin/bash
set -euo pipefail

#===============================================================================
# BeeDocs - K3S Deployment Script (Podman)
#===============================================================================
# Builds and pushes the BeeDocs image, then deploys it to K3S on the VPS.
#
# Architecture:
#   • beedocs      One ASP.NET Core 10 process serving everything:
#                    /            beedocs-web SPA (React/Vite, baked into
#                                 wwwroot at image build time)
#                    /api         REST API (books, chapters, pages, diagrams)
#                    /uploads     user-uploaded images, served off the PVC
#                  NodePort 32095 — Cloudflare Tunnel forwards the public
#                  hostname here (tunnel config managed outside this repo).
#
#   • beedocs-mcp  .NET sidecar in the same pod, MCP over Streamable HTTP:
#                    /mcp         agent endpoint
#                    /healthz     probe endpoint
#                  NodePort 32096 — its own tunnel hostname, because agents
#                  authenticate with a Cloudflare Access *service token* while
#                  the web UI uses interactive SSO. Reaches the API over the
#                  pod loopback, so BeeDocs itself stays off the cluster net.
#
#   SQLite runs as a file store inside the pod — there is no separate
#   database container. That is why the deployment is pinned to one replica
#   with a Recreate strategy: a single writer owns the database file.
#
# Namespace: beedocs
# Registry:  beecodersregistry.azurecr.io  (reuses the existing acr-secret
#            ImagePullSecret — copied into this namespace on first deploy.)
# Storage:   one PVC mounted at /data, holding both the SQLite store
#            (/data/sqlite/beedocs.db) and uploaded images (/data/uploads).
#
# Usage:
#   ./scripts/deploy-k3s.sh [all|build|push|deploy|status|logs|shell]
#
#   all        build → push → deploy → status (default)
#   build      build both images locally with podman
#   push       podman login + push both images
#   deploy     scp manifests + apply on the VPS, restart deployment
#   status     kubectl get on the namespace
#   logs       tail the API and MCP logs
#   shell      open a shell in the running pod
#   mcp-token  print the MCP bearer token from the cluster secret
#
# Required tools locally:
#   podman, ssh, scp
#===============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMMAND="${1:-all}"

REGISTRY="${REGISTRY:-beecodersregistry.azurecr.io}"
NAMESPACE="beedocs"
IMAGE="$REGISTRY/beedocs"
MCP_IMAGE="$REGISTRY/beedocs-mcp"
NODE_PORT=32095
MCP_NODE_PORT=32096

# VPS target (override via environment variables).
VPS_IP="${VPS_IP:-212.47.77.32}"
VPS_USER="${VPS_USER:-bart}"

VPS_BASE_DIR="${VPS_BASE_DIR:-~/beedocs}"
VPS_K8S_DIR="$VPS_BASE_DIR/k8s"

# Single source of truth for the image tag AND the version shown in the web UI:
# <Version> in the API csproj. The script also always pushes :latest so the
# rollout picks it up.
CSPROJ="$ROOT_DIR/src/BeeDocs.Api/BeeDocs.Api.csproj"

read_version() {
  grep -m1 '<Version>' "$CSPROJ" | sed -E 's/.*<Version>([^<]+)<\/Version>.*/\1/'
}

APP_VERSION="$(read_version)"
if [[ -z "$APP_VERSION" ]]; then
  echo "could not parse <Version> from src/BeeDocs.Api/BeeDocs.Api.csproj"
  exit 1
fi

# MAJOR.MINOR.BUILD — the last digit is the build number, incremented on every
# deploy so the version pill in the header identifies exactly which build is
# live. Bump major/minor by hand in the csproj; this only ever touches the last.
# Set NO_BUMP=1 to rebuild or redeploy the current version unchanged.
bump_build_number() {
  if [[ "${NO_BUMP:-0}" == "1" ]]; then
    echo "==> NO_BUMP=1, keeping version $APP_VERSION"
    return 0
  fi

  if [[ ! "$APP_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "ERROR: <Version> is '$APP_VERSION'; expected MAJOR.MINOR.BUILD (all numeric)."
    echo "       Fix it in $CSPROJ, or set NO_BUMP=1 to deploy it as-is."
    exit 1
  fi

  local next="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$(( BASH_REMATCH[3] + 1 ))"
  # Anchored on the exact current value so nothing else in the csproj can match.
  sed -i -E "s|<Version>${APP_VERSION}</Version>|<Version>${next}</Version>|" "$CSPROJ"

  local written
  written="$(read_version)"
  if [[ "$written" != "$next" ]]; then
    echo "ERROR: version bump failed (expected $next, file now says '$written')"
    exit 1
  fi

  echo "==> Build number bumped: $APP_VERSION -> $next"
  APP_VERSION="$next"
}

ssh_vps() {
  local cmd="$1"
  ssh -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" "bash -lc $(printf %q "$cmd")"
}

kubectl_vps() {
  local args="$1"
  ssh_vps "if command -v kubectl >/dev/null 2>&1; then kubectl $args; else sudo k3s kubectl $args; fi"
}

check_build_deps() {
  command -v podman >/dev/null 2>&1 || { echo "podman not found"; exit 1; }
}

check_remote_deps() {
  command -v ssh >/dev/null 2>&1 || { echo "ssh not found"; exit 1; }
  command -v scp >/dev/null 2>&1 || { echo "scp not found"; exit 1; }
}

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
build_image() {
  echo "==> Building $IMAGE:$APP_VERSION"
  echo "    (multi-stage: dotnet publish + pnpm build -> wwwroot in one image)"
  podman build \
    --pull=newer \
    -t "$IMAGE:latest" \
    -t "$IMAGE:$APP_VERSION" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"

  echo "==> Building $MCP_IMAGE:$APP_VERSION"
  podman build \
    --pull=newer \
    -t "$MCP_IMAGE:latest" \
    -t "$MCP_IMAGE:$APP_VERSION" \
    -f "$ROOT_DIR/src/BeeDocs.Mcp/Dockerfile" \
    "$ROOT_DIR"
}

# -----------------------------------------------------------------------------
# Push
# -----------------------------------------------------------------------------
push_image() {
  echo "==> Logging into $REGISTRY"
  if [[ -n "${REGISTRY_USER:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
    podman login -u "$REGISTRY_USER" -p "$REGISTRY_PASSWORD" "$REGISTRY"
  else
    podman login "$REGISTRY"
  fi

  echo "==> Pushing $IMAGE"
  podman push "$IMAGE:latest"
  podman push "$IMAGE:$APP_VERSION"

  echo "==> Pushing $MCP_IMAGE"
  podman push "$MCP_IMAGE:latest"
  podman push "$MCP_IMAGE:$APP_VERSION"
}

# -----------------------------------------------------------------------------
# Deploy
# -----------------------------------------------------------------------------
ensure_remote_dirs() {
  ssh_vps "mkdir -p $VPS_K8S_DIR || (command -v sudo >/dev/null 2>&1 && sudo mkdir -p $VPS_K8S_DIR && sudo chown -R $VPS_USER:$VPS_USER $VPS_BASE_DIR)"
}

copy_manifests() {
  ensure_remote_dirs
  scp -o StrictHostKeyChecking=accept-new -r \
    "$ROOT_DIR/k8s/beedocs" \
    "$VPS_USER@$VPS_IP:$VPS_K8S_DIR/"
}

deploy_manifests() {
  echo "==> Deploying to $VPS_USER@$VPS_IP (namespace: $NAMESPACE)"
  copy_manifests

  # 1. Namespace must exist before anything else lands in it.
  kubectl_vps "apply -f $VPS_K8S_DIR/beedocs/namespace.yaml"

  # 2. ImagePullSecret — copy from a namespace that already has it.
  ensure_acr_secret

  # 2b. MCP bearer token. Generated on the VPS and never stored in this repo.
  ensure_mcp_auth_secret

  # 3. Config, storage, service, workload.
  kubectl_vps "apply -f $VPS_K8S_DIR/beedocs/configmap.yaml"
  kubectl_vps "apply -f $VPS_K8S_DIR/beedocs/pvc.yaml"
  kubectl_vps "apply -f $VPS_K8S_DIR/beedocs/service.yaml"
  kubectl_vps "apply -f $VPS_K8S_DIR/beedocs/deployment.yaml"

  # 4. Force a rollout so an unchanged tag still picks up the new image
  #    digest (we always push :latest with imagePullPolicy: Always).
  kubectl_vps "-n $NAMESPACE rollout restart deployment beedocs"
  kubectl_vps "-n $NAMESPACE rollout status deployment beedocs --timeout=300s"

  echo ""
  echo "Deployed BeeDocs v$APP_VERSION (mcp v$APP_VERSION)"
  echo "  • Web UI:    http://$VPS_IP:$NODE_PORT/"
  echo "  • Health:    curl -s http://$VPS_IP:$NODE_PORT/api/health"
  echo "  • MCP:       http://$VPS_IP:$MCP_NODE_PORT/mcp"
  echo "  • MCP health: curl -s http://$VPS_IP:$MCP_NODE_PORT/healthz"
  echo ""
  echo "  Cloudflare Tunnel — two ingress rules:"
  echo "    docs.<domain>  ->  http://<k3s-node>:$NODE_PORT"
  echo "    mcp.<domain>   ->  http://<k3s-node>:$MCP_NODE_PORT"
  echo ""
  echo "  MCP bearer token:  ./scripts/deploy-k3s.sh mcp-token"
  echo "  Cloudflare Access setup:  Docs/MCP-HOSTING.md"
  echo ""
  echo "  The build number was bumped in BeeDocs.Api.csproj — commit it so the"
  echo "  version pill in the UI matches a known commit:"
  echo "    git commit -am \"Release v$APP_VERSION\""
}

# Bearer token guarding the MCP endpoint. Generated on the VPS on first deploy
# and left alone afterwards — rotating it is a deliberate act:
#   kubectl -n beedocs delete secret beedocs-mcp-auth && ./scripts/deploy-k3s.sh deploy
# Never written to this repo. Read it back with `deploy-k3s.sh mcp-token`.
ensure_mcp_auth_secret() {
  if kubectl_vps "-n $NAMESPACE get secret beedocs-mcp-auth >/dev/null 2>&1"; then
    echo "==> beedocs-mcp-auth already exists; leaving it alone"
    return 0
  fi

  echo "==> Creating beedocs-mcp-auth (random 32-byte token, generated on the VPS)"
  kubectl_vps "-n $NAMESPACE create secret generic beedocs-mcp-auth \
    --from-literal=token=\$(openssl rand -hex 32)"
}

mcp_token() {
  echo "==> MCP bearer token ($NAMESPACE/beedocs-mcp-auth):"
  kubectl_vps "-n $NAMESPACE get secret beedocs-mcp-auth -o jsonpath='{.data.token}'" \
    | base64 -d
  echo ""
}

# Copy the existing acr-secret from a namespace that has one into beedocs.
# Idempotent — does nothing if it's already there.
ensure_acr_secret() {
  if kubectl_vps "-n $NAMESPACE get secret acr-secret >/dev/null 2>&1"; then
    return 0
  fi

  local src
  for src in beehosting aidbooks sqail fietsloire; do
    if kubectl_vps "-n $src get secret acr-secret >/dev/null 2>&1"; then
      echo "==> $NAMESPACE/acr-secret missing; copying from $src/acr-secret"
      kubectl_vps "-n $src get secret acr-secret -o yaml \
        | sed -e '/namespace:/d' -e '/resourceVersion:/d' -e '/uid:/d' -e '/creationTimestamp:/d' \
        | kubectl -n $NAMESPACE apply -f -"
      return 0
    fi
  done

  echo ""
  echo "ERROR: no source acr-secret found (looked in 'beehosting', 'aidbooks', 'sqail', 'fietsloire')."
  echo "       Create it manually:"
  echo "         kubectl -n $NAMESPACE create secret docker-registry acr-secret \\"
  echo "           --docker-server=$REGISTRY \\"
  echo "           --docker-username=<acr-user> \\"
  echo "           --docker-password=<acr-token>"
  exit 1
}

# -----------------------------------------------------------------------------
# Status / logs
# -----------------------------------------------------------------------------
status() {
  kubectl_vps "-n $NAMESPACE get pods,svc,deploy,pvc"
}

logs() {
  echo "==> beedocs / api (last 80 lines)"
  kubectl_vps "-n $NAMESPACE logs deployment/beedocs -c beedocs --tail=80" || true
  echo ""
  echo "==> beedocs / mcp (last 40 lines)"
  kubectl_vps "-n $NAMESPACE logs deployment/beedocs -c mcp --tail=40" || true
}

shell() {
  echo "==> Opening a shell in the beedocs pod (api container)"
  ssh -t -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" \
    "kubectl -n $NAMESPACE exec -it deployment/beedocs -c beedocs -- bash || sudo k3s kubectl -n $NAMESPACE exec -it deployment/beedocs -c beedocs -- bash"
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
main() {
  case "$COMMAND" in
    all)
      check_build_deps
      check_remote_deps
      bump_build_number
      echo "Deploying BeeDocs v$APP_VERSION to $VPS_USER@$VPS_IP"
      build_image
      push_image
      deploy_manifests
      status
      ;;
    build)     check_build_deps; bump_build_number; build_image ;;
    push)      check_build_deps; push_image ;;
    deploy)    check_remote_deps; deploy_manifests ;;
    status)    check_remote_deps; status ;;
    logs)      check_remote_deps; logs ;;
    shell)     check_remote_deps; shell ;;
    mcp-token) check_remote_deps; mcp_token ;;
    *)
      echo "Unknown command: $COMMAND"
      echo "Usage: $0 [all|build|push|deploy|status|logs|shell|mcp-token]"
      exit 1
      ;;
  esac
}

main
