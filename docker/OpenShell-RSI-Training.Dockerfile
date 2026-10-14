# Training-only extension. It is selected only by OpenShell training/model-evaluation jobs.
# It provides the pinned torch stack only; the trainer scripts ship inside each
# job's snapshot bundle from the frozen base commit (guest /opt is unreachable).
FROM headlesscode-openshell-rsi:local

USER root
# gcc + libc/Python headers: torch's triton JIT compiles a CUDA driver shim
# at forward time inside the guest.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-dev gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/rsi-training/requirements.lock /opt/headlesscode-rsi-training/requirements.lock
RUN python3 -m pip install --break-system-packages --no-cache-dir --require-hashes -r /opt/headlesscode-rsi-training/requirements.lock
RUN python3 -c "import torch; assert torch.version.cuda is not None, 'RSI training image requires a CUDA-enabled torch wheel'"
RUN chmod -R a-w /opt/headlesscode-rsi-training

USER sandbox
