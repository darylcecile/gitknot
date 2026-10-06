FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS git-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl ca-certificates libssl-dev libcurl4-openssl-dev libexpat1-dev zlib1g-dev gettext xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Pinned source and official kernel.org SHA-256; no repository-controlled build inputs.
RUN curl --fail --silent --show-error --proto '=https' --tlsv1.2 -o git.tar.xz https://www.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz \
    && echo 'f689162364c10de79ef89aa8dbf48731eb057e34edbbd20aca510ce0154681a3  git.tar.xz' | sha256sum --check \
    && tar -xf git.tar.xz \
    && make -C git-2.54.0 -j2 prefix=/usr NO_TCLTK=YesPlease NO_GETTEXT=YesPlease NO_PERL=YesPlease install DESTDIR=/git-install

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libcurl4 libexpat1 openssh-client gnupg util-linux tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 gitknot \
    && useradd --uid 10001 --gid gitknot --create-home gitknot \
    && mkdir -p /var/lib/gitknot/cache \
    && chown -R gitknot:gitknot /var/lib/gitknot
COPY --from=git-build /git-install/usr /usr
WORKDIR /opt/gitknot
COPY services/git/runtime.package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-package-lock --workspaces=false
COPY packages/core/src ./packages/core/src
COPY packages/git/src ./packages/git/src
COPY services/git/src ./services/git/src
USER 10001:10001
ENV NODE_ENV=production PORT=8080 GIT_MAX_SESSIONS=4
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "services/git/src/main.ts"]
