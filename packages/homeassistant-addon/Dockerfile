ARG BUILD_FROM
FROM $BUILD_FROM

# Set environment
ENV LANG C.UTF-8
ENV NODE_ENV production

# Install Node.js, npm, curl, and bash
RUN apk add --no-cache \
    nodejs \
    npm \
    bash \
    curl \
    jq

# Create working directory
WORKDIR /app

# Copy rootfs files (s6-overlay service definitions)
COPY rootfs /

# Copy application files
COPY . /app

# Install production dependencies
RUN chmod a+x /etc/s6-overlay/s6-rc.d/blockingmachine/run

# Expose ports
EXPOSE 9191 5353/udp

LABEL \
  io.hass.version="1.0.0" \
  io.hass.type="addon" \
  io.hass.arch="aarch64|amd64|armv7"
