FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/senya-landing.conf
COPY index.html services.js /usr/share/nginx/html/
COPY components /usr/share/nginx/html/components/
COPY data /usr/share/nginx/html/data/
COPY styles /usr/share/nginx/html/styles/
COPY js /usr/share/nginx/html/js/
COPY icons /usr/share/nginx/html/icons/

EXPOSE 80
