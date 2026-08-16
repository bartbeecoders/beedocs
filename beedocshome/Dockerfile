# beedocshome — static marketing site for BeeDocs.
# Plain HTML/CSS/JS, no build step: the image is nginx plus the files.
FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 8080
