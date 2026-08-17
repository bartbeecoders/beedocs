# beedocshome — static marketing site for BeeDocs.
# Plain HTML/CSS/JS, no build step: the image is nginx plus the files.
FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Every page, not a hand-kept list — a new .html file ships without a
# Dockerfile edit (releases.html once 404'd for exactly that reason).
COPY *.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 8080
