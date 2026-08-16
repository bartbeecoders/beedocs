# beedocshome

Marketing site for BeeDocs, hosted at **https://beedocshome.hideterms.com**.

Plain static HTML/CSS/JS — no framework, no build step. The hero diagram is an
isometric SVG of the BeeDocs stack, generated at load time by
`assets/main.js` using the same 2:1 dimetric projection the product's
isometric editor uses.

```
index.html          the page
assets/             styles.css · main.js · favicon.svg
assets/tour/        screenshots + demo video (webm/mp4) captured from a seeded local instance
nginx.conf          server config (nginx-unprivileged, :8080, /healthz)
Dockerfile          nginx + the files
k8s/                namespace · service (NodePort 32097) · deployment
scripts/start.sh    serve locally (:5300), or `start.sh container` for the real image
scripts/deploy.sh   build → push → deploy to K3S on the VPS
```

## Run locally

```bash
./scripts/start.sh              # http://localhost:5300
./scripts/start.sh container    # the actual nginx image
```

## Deploy

```bash
./scripts/deploy.sh             # build → push → deploy → status
```

Same VPS, registry and conventions as the root `scripts/deploy-k3s.sh`, in its
own `beedocshome` namespace on NodePort **32097**. The Cloudflare Tunnel needs
a one-time ingress rule: `beedocshome.hideterms.com -> http://<k3s-node>:32097`
(tunnel config lives outside this repo).
