# RSI worker/evaluator runtime derived from the standard OpenShell image.
# The RSI coordinator, evaluator, and test files must stay in the supervisor
# process or candidate workspace; they are not part of this guest image.
ARG HEADLESSCODE_BASE_IMAGE=headlesscode-openshell:local
FROM ${HEADLESSCODE_BASE_IMAGE}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /opt/headlesscode/src/rsi \
    && find /opt/headlesscode/src -type d -name __tests__ -prune -exec rm -rf {} + \
    && find /opt/headlesscode/src -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) -delete \
    && rm -rf /opt/headlesscode/scripts/eval-suite \
    && test ! -e /opt/headlesscode/src/rsi

USER sandbox
