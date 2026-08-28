FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js config.js ./
COPY lib/ ./lib/

ENV NODE_ENV=production \
    ECOFLOW2MQTT_MQTT_URL=mqtt://localhost \
    ECOFLOW2MQTT_NAME=ecoflow \
    ECOFLOW2MQTT_VERBOSITY=info \
    ECOFLOW2MQTT_STATE_DIR=/data

# credentials belong in the environment, not in the image:
#   docker run -e ECOFLOW2MQTT_EMAIL=... -e ECOFLOW2MQTT_PASSWORD=... -e ECOFLOW2MQTT_SN=... \
#              -e ECOFLOW2MQTT_MQTT_URL=mqtt://broker -v ecoflow:/data ...
# /data keeps the mqtt client id stable across restarts (mount a volume)
VOLUME /data
USER node

ENTRYPOINT ["node", "index.js"]
