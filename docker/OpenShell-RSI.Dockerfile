# RSI worker/evaluator runtime derived from the standard OpenShell image.
# The RSI coordinator, evaluator, and test files must stay in the supervisor
# process or candidate workspace; they are not part of this guest image.
ARG HEADLESSCODE_BASE_IMAGE=headlesscode-openshell:local
FROM ${HEADLESSCODE_BASE_IMAGE} AS gnu-make-build

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# GNU make 4.4.1 is pinned as the upstream release. Its configure option
# disables posix_spawn so recipe processes use the fork/exec path supported by
# the OpenShell guest seccomp policy. The SHA-256 pin was computed from the
# official GNU archive; it matches the MD5 published in the GNU release notice:
# https://lists.gnu.org/archive/html/info-gnu/2023-02/msg00011.html
RUN set -eux; \
    curl --fail --location --silent --show-error \
        https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz \
        --output /tmp/make-4.4.1.tar.gz; \
    printf '%s  %s\n' \
        dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3 \
        /tmp/make-4.4.1.tar.gz | sha256sum --check --status; \
    tar -xzf /tmp/make-4.4.1.tar.gz -C /tmp; \
    cd /tmp/make-4.4.1; \
    ./configure --prefix=/usr/local --disable-nls --disable-posix-spawn; \
    ! grep -q '^#define USE_POSIX_SPAWN 1' src/config.h; \
    make -j"$(nproc)"; \
    make install

FROM ${HEADLESSCODE_BASE_IMAGE}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /opt/headlesscode/src/rsi \
    && find /opt/headlesscode/src -type d -name __tests__ -prune -exec rm -rf {} + \
    && find /opt/headlesscode/src -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) -delete \
    && rm -rf /opt/headlesscode/scripts/eval-suite \
    && rm -rf /opt/headlesscode/scripts/rsi-benchmark \
    && rm -rf /opt/headlesscode/fixtures/rsi-benchmark \
    && test ! -e /opt/headlesscode/src/rsi

COPY --from=gnu-make-build /usr/local/bin/make /usr/local/bin/make
COPY --from=gnu-make-build /tmp/make-4.4.1.tar.gz /usr/share/doc/headlesscode/gnu-make-4.4.1.tar.gz

RUN set -eu; \
    test "$(command -v make)" = /usr/local/bin/make; \
    make --version | head -n 1 | grep -F 'GNU Make 4.4.1'; \
    fixture="$(mktemp -d)"; \
    printf 'check:\n\t@printf "RSI_MAKE_RECIPE_OK\\n"\n' > "$fixture/Makefile"; \
    test "$(make --no-print-directory --silent --directory "$fixture" check)" = RSI_MAKE_RECIPE_OK; \
    rm -rf "$fixture"; \
    test ! -e /opt/headlesscode/scripts/rsi-benchmark/task-spec.mjs \
    && test ! -e /opt/headlesscode/fixtures/rsi-benchmark \
    && test ! -e /opt/headlesscode/.git

RUN mkdir -p /usr/share/doc/headlesscode \
    && printf '%s\n' \
        'GNU Make 4.4.1 source: https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz' \
        'Source SHA-256: dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3' \
        'GNU release notice publishes MD5 c8469a3713cbbe04d955d4ae4be23eeb: https://lists.gnu.org/archive/html/info-gnu/2023-02/msg00011.html' \
        'Configured with --disable-posix-spawn; corresponding source archive and COPYING are in gnu-make-4.4.1.tar.gz.' \
        > /usr/share/doc/headlesscode/gnu-make-build.txt

USER sandbox
