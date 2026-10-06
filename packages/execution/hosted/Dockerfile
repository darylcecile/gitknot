# Resolve and pin the tested 0.12.1 base image digest before building. There is
# deliberately no mutable-tag default or embedded credential. Measure and pin the
# resulting image after installing the kernel firewall tooling.
ARG SANDBOX_BASE_IMAGE
FROM ${SANDBOX_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iptables && \
    rm -rf /var/lib/apt/lists/* && \
    test -x /usr/sbin/iptables && test -x /usr/sbin/ip6tables && \
    test -x /usr/local/bin/node && test -x /usr/bin/setpriv && test -x /usr/bin/setsid && \
    test -x /usr/bin/timeout && test -x /usr/bin/pkill && \
    test -x /usr/bin/mksquashfs && test -x /usr/bin/unsquashfs && \
    groupadd --gid 10000 gitknot && \
    useradd --uid 10000 --gid 10000 --create-home --shell /bin/bash gitknot && \
    chmod 700 /home/gitknot && mkdir -p /opt/gitknot
COPY packages/execution/hosted/record-toolchain.cjs /opt/gitknot/record-toolchain.cjs
RUN node /opt/gitknot/record-toolchain.cjs && \
    chmod 444 /opt/gitknot/toolchain.json && chmod 555 /opt/gitknot
# Preserve the pinned SDK image's /container-server/sandbox entrypoint.
