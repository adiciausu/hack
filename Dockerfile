FROM node:latest
COPY app/ /var/hack
RUN npm install timeseries-analysis
RUN npm install node-fetch
RUN node /var/hack/index.js

