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
#   SurrealDB runs *embedded* on RocksDB inside the pod — there is no separate
#   database container. That is why the deployment is pinned to one replica
#   with a Recreate strategy: RocksDB takes an exclusive lock on its directory.
#
# Namespace: beedocs
# Registry:  beecodersregistry.azurecr.io  (reuses the existing acr-secret
#            ImagePullSecret — copied into this namespace on first deploy.)
# Storage:   one PVC mounted at /data, holding both the RocksDB store
#            (/data/surreal) and uploaded images (/data/uploads).
#
# Usage:
#   ./scripts/deploy-k3s.sh [all|build|push|deploy|status|logs|shell]
#
#   all     build → push → deploy → status (default)
#   build   build the image locally with podman
#   push    podman login + push the image
#   deploy  scp manifests + apply on the VPS, restart deployment
#   status  kubectl get on the namespace
#   logs    tail the BeeDocs logs
#   shell   open a shell in the running pod
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
NODE_PORT=32095

# VPS target (override via environment variables).
VPS_IP="${VPS_IP:-212.47.77.32}"
VPS_USER="${VPS_USER:-bart}"

VPS_BASE_DIR="${VPS_BASE_DIR:-~/beedocs}"
VPS_K8S_DIR="$VPS_BASE_DIR/k8s"

# Single source of truth for the image tag: <Version> in the API csproj.
# The script also always pushes :latest so the rollout picks it up.
APP_VERSION=$(grep -m1 '<Version>' "$ROOT_DIR/src/BeeDocs.Api/BeeDocs.Api.csproj" \
  | sed -E 's/.*<Version>([^<]+)<\/Version>.*/\1/')
if [[ -z "$APP_VERSION" ]]; then
  echo "could not parse <Version> from src/BeeDocs.Api/BeeDocs.Api.csproj"
  exit 1
fi

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
  echo "Deployed BeeDocs v$APP_VERSION"
  echo "  • NodePort:  http://$VPS_IP:$NODE_PORT   (cloudflare tunnel target)"
  echo "  • Web UI:    http://$VPS_IP:$NODE_PORT/"
  echo "  • Health:    curl -s http://$VPS_IP:$NODE_PORT/api/health"
  echo ""
  echo "  Cloudflare Tunnel: point the BeeDocs hostname at"
  echo "    http://<k3s-node>:$NODE_PORT"
  echo "  Agents reach the MCP server by setting BEEDOCS_API_URL to the"
  echo "  tunnel hostname (see Docs/MCP-SERVER.md)."
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
  echo "==> beedocs (last 80 lines)"
  kubectl_vps "-n $NAMESPACE logs deployment/beedocs --tail=80" || true
}

shell() {
  echo "==> Opening a shell in the beedocs pod"
  ssh -t -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" \
    "kubectl -n $NAMESPACE exec -it deployment/beedocs -- bash || sudo k3s kubectl -n $NAMESPACE exec -it deployment/beedocs -- bash"
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
main() {
  case "$COMMAND" in
    all)
      check_build_deps
      check_remote_deps
      echo "Deploying BeeDocs v$APP_VERSION to $VPS_USER@$VPS_IP"
      build_image
      push_image
      deploy_manifests
      status
      ;;
    build)  check_build_deps; build_image ;;
    push)   check_build_deps; push_image ;;
    deploy) check_remote_deps; deploy_manifests ;;
    status) check_remote_deps; status ;;
    logs)   check_remote_deps; logs ;;
    shell)  check_remote_deps; shell ;;
    *)
      echo "Unknown command: $COMMAND"
      echo "Usage: $0 [all|build|push|deploy|status|logs|shell]"
      exit 1
      ;;
  esac
}

main
