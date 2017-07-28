FROM node:latest
COPY app/ /var/hack
RUN npm install timeseries-analysis
RUN npm install node-fetch
RUN npm install metal-cloud-sdk
RUN npm install mathjs
RUN npm install sleep
RUN node /var/hack/autoscaler.js
