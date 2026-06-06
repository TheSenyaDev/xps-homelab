FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/senya-landing.conf
COPY index.html style.css app.js services.js /usr/share/nginx/html/
COPY icons /usr/share/nginx/html/icons/

EXPOSE 80
