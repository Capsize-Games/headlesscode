# Runtime image for OpenShell-hosted HeadlessCode workers.
# The HeadlessCode checkout is baked into the image so a sandbox never needs
# a bind mount of the host harness tree. Only the assigned target worktree
# and explicitly selected data paths are mounted at runtime.
FROM node:22-bookworm-slim

ARG HEADLESSCODE_HARNESS_COMMIT=unrecorded

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates coreutils git \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod --new-name sandbox node \
    && usermod --login sandbox --home /home/sandbox --move-home node

WORKDIR /opt/headlesscode
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY shared ./shared
COPY scripts/spawn-parallel-worktrees.sh scripts/run-worker.sh scripts/headlesscode-answer.sh ./scripts/
RUN chmod -R a+rX /opt/headlesscode/src /opt/headlesscode/shared /opt/headlesscode/scripts
RUN test ! -e /opt/headlesscode/scripts/rsi-benchmark/task-spec.mjs \
    && test ! -e /opt/headlesscode/scripts/rsi-benchmark/manual-tests \
    && test ! -e /opt/headlesscode/fixtures/rsi-benchmark \
    && test ! -e /opt/headlesscode/.git
RUN printf '%s\n' "$HEADLESSCODE_HARNESS_COMMIT" > /opt/headlesscode/.headlesscode-harness-commit
LABEL org.capsize.headlesscode.harness-commit="$HEADLESSCODE_HARNESS_COMMIT"
RUN chmod +x scripts/spawn-parallel-worktrees.sh scripts/run-worker.sh scripts/headlesscode-answer.sh
RUN mkdir -p /opt/headlesscode-session /opt/headlesscode-data/projects /opt/headlesscode-data/shared /opt/headlesscode-data/checkpoints /sandbox \
    && chmod 0755 /opt/headlesscode-session \
    && chown -R sandbox:sandbox /opt/headlesscode-data /sandbox
ENV HEADLESSCODE_ROOT=/opt/headlesscode
WORKDIR /sandbox
USER sandbox
RUN test -r /opt/headlesscode/src/cli.ts \
    && test -r /opt/headlesscode/src/memory/local.ts \
    && test -x /opt/headlesscode/src/memory \
    && test ! -w /opt/headlesscode/src/memory
CMD ["sleep", "infinity"]
