FROM node:latest
COPY app/ /var/hack
RUN node /var/hack/index.js

