# Runtime image for OpenShell-hosted HeadlessCode workers.
# The HeadlessCode checkout is baked into the image so a sandbox never needs
# a bind mount of the host harness tree. Only the assigned target worktree
# and explicitly selected data paths are mounted at runtime.
FROM node:22-bookworm-slim

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
RUN chmod +x scripts/spawn-parallel-worktrees.sh scripts/run-worker.sh scripts/headlesscode-answer.sh
RUN mkdir -p /opt/headlesscode-session /opt/headlesscode-data/projects /opt/headlesscode-data/shared /opt/headlesscode-data/checkpoints /sandbox \
    && chmod 0755 /opt/headlesscode-session \
    && chown -R sandbox:sandbox /opt/headlesscode-data /sandbox
ENV HEADLESSCODE_ROOT=/opt/headlesscode
WORKDIR /sandbox
USER sandbox
CMD ["sleep", "infinity"]
