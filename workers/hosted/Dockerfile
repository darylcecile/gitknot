# Build locally with an explicitly digest-pinned Sandbox 0.12.1 base, then measure
# and pin the resulting image in HOSTED_PROFILES_JSON. Preserve the SDK entrypoint.
ARG SANDBOX_BASE_IMAGE
FROM ${SANDBOX_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iptables && \
    rm -rf /var/lib/apt/lists/* && \
    test -x /usr/bin/setpriv && test -x /usr/bin/setsid && \
    test -x /usr/bin/pkill && test -x /usr/bin/mksquashfs && \
    test -x /usr/bin/unsquashfs && test -x /usr/local/bin/node && \
    groupadd --gid 10000 gitknot && \
    useradd --uid 10000 --gid 10000 --create-home --shell /bin/bash gitknot && \
    chmod 700 /home/gitknot && mkdir -p /opt/gitknot
COPY packages/execution/hosted/record-toolchain.cjs /opt/gitknot/record-toolchain.cjs
RUN node /opt/gitknot/record-toolchain.cjs && \
    chmod 444 /opt/gitknot/toolchain.json && chmod 555 /opt/gitknot
