#!/bin/bash
set -euo pipefail

#===============================================================================
# beedocshome — K3S deployment script (Podman)
#===============================================================================
# Builds and pushes the marketing-site image, then deploys it to K3S on the
# same VPS that hosts BeeDocs. Modeled on scripts/deploy-k3s.sh in the repo
# root — same registry, same VPS, its own namespace and NodePort.
#
#   Public hostname:  beedocshome.hideterms.com
#   Cloudflare Tunnel ingress rule (managed outside this repo):
#       beedocshome.hideterms.com -> http://<k3s-node>:32097
#
# Usage:
#   ./scripts/deploy.sh [all|build|push|deploy|status|logs]
#
#   all      build -> push -> deploy -> status (default)
#   build    build the image locally with podman
#   push     podman login + push
#   deploy   scp manifests + apply on the VPS, restart deployment
#   status   kubectl get on the namespace
#   logs     tail the nginx container log
#
# Required tools locally: podman, ssh, scp
#===============================================================================

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SITE_DIR"

COMMAND="${1:-all}"

REGISTRY="${REGISTRY:-beecodersregistry.azurecr.io}"
NAMESPACE="beedocshome"
IMAGE="$REGISTRY/beedocshome"
NODE_PORT=32097

# VPS target (override via environment variables) — same box as BeeDocs.
VPS_IP="${VPS_IP:-212.47.77.32}"
VPS_USER="${VPS_USER:-bart}"

VPS_BASE_DIR="${VPS_BASE_DIR:-~/beedocshome}"
VPS_K8S_DIR="$VPS_BASE_DIR/k8s"

# No app version to track for a static page — tag with the git commit so a
# running image can always be traced back to a commit. :latest is what the
# deployment pulls; the sha tag is the audit trail.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"

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
# Build / push
# -----------------------------------------------------------------------------
build_image() {
  echo "==> Building $IMAGE ($GIT_SHA)"
  podman build \
    --pull=newer \
    -t "$IMAGE:latest" \
    -t "$IMAGE:$GIT_SHA" \
    -f "$SITE_DIR/Dockerfile" \
    "$SITE_DIR"
}

push_image() {
  echo "==> Logging into $REGISTRY"
  if [[ -n "${REGISTRY_USER:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
    podman login -u "$REGISTRY_USER" -p "$REGISTRY_PASSWORD" "$REGISTRY"
  else
    podman login "$REGISTRY"
  fi

  echo "==> Pushing $IMAGE"
  podman push "$IMAGE:latest"
  podman push "$IMAGE:$GIT_SHA"
}

# -----------------------------------------------------------------------------
# Deploy
# -----------------------------------------------------------------------------

# Copy the existing acr-secret from a namespace that has one. Idempotent.
ensure_acr_secret() {
  if kubectl_vps "-n $NAMESPACE get secret acr-secret >/dev/null 2>&1"; then
    return 0
  fi

  local src
  for src in beedocs beehosting aidbooks sqail fietsloire; do
    if kubectl_vps "-n $src get secret acr-secret >/dev/null 2>&1"; then
      echo "==> $NAMESPACE/acr-secret missing; copying from $src/acr-secret"
      kubectl_vps "-n $src get secret acr-secret -o yaml \
        | sed -e '/namespace:/d' -e '/resourceVersion:/d' -e '/uid:/d' -e '/creationTimestamp:/d' \
        | kubectl -n $NAMESPACE apply -f -"
      return 0
    fi
  done

  echo ""
  echo "ERROR: no source acr-secret found. Create it manually:"
  echo "  kubectl -n $NAMESPACE create secret docker-registry acr-secret \\"
  echo "    --docker-server=$REGISTRY \\"
  echo "    --docker-username=<acr-user> \\"
  echo "    --docker-password=<acr-token>"
  exit 1
}

deploy_manifests() {
  echo "==> Deploying to $VPS_USER@$VPS_IP (namespace: $NAMESPACE)"

  ssh_vps "mkdir -p $VPS_K8S_DIR"
  scp -o StrictHostKeyChecking=accept-new \
    "$SITE_DIR/k8s/"*.yaml \
    "$VPS_USER@$VPS_IP:$VPS_K8S_DIR/"

  kubectl_vps "apply -f $VPS_K8S_DIR/namespace.yaml"
  ensure_acr_secret
  kubectl_vps "apply -f $VPS_K8S_DIR/service.yaml"
  kubectl_vps "apply -f $VPS_K8S_DIR/deployment.yaml"

  # Force a rollout so an unchanged :latest tag still picks up the new digest.
  kubectl_vps "-n $NAMESPACE rollout restart deployment beedocshome"
  kubectl_vps "-n $NAMESPACE rollout status deployment beedocshome --timeout=180s"

  echo ""
  echo "Deployed beedocshome ($GIT_SHA)"
  echo "  • Direct:  http://$VPS_IP:$NODE_PORT/"
  echo "  • Health:  curl -s http://$VPS_IP:$NODE_PORT/healthz"
  echo ""
  echo "  Cloudflare Tunnel — ingress rule to add once:"
  echo "    beedocshome.hideterms.com  ->  http://<k3s-node>:$NODE_PORT"
}

status() {
  kubectl_vps "-n $NAMESPACE get pods,svc,deploy"
}

logs() {
  kubectl_vps "-n $NAMESPACE logs deployment/beedocshome --tail=80" || true
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
case "$COMMAND" in
  all)
    check_build_deps
    check_remote_deps
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
  *)
    echo "Unknown command: $COMMAND"
    echo "Usage: $0 [all|build|push|deploy|status|logs]"
    exit 1
    ;;
esac
