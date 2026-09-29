# Training-only extension. It is selected only by OpenShell training/model-evaluation jobs.
FROM headlesscode-openshell-rsi:local

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/rsi-training/requirements.lock /opt/headlesscode-rsi-training/requirements.lock
RUN python3 -m pip install --break-system-packages --no-cache-dir --require-hashes -r /opt/headlesscode-rsi-training/requirements.lock
RUN python3 -c "import torch; assert torch.version.cuda is not None, 'RSI training image requires a CUDA-enabled torch wheel'"
COPY scripts/rsi-training/train_qlora.py /opt/headlesscode-rsi-training/train_qlora.py
COPY scripts/rsi-training/evaluate_adapter.py /opt/headlesscode-rsi-training/evaluate_adapter.py
RUN chmod 0555 /opt/headlesscode-rsi-training/train_qlora.py /opt/headlesscode-rsi-training/evaluate_adapter.py \
    && chmod -R a-w /opt/headlesscode-rsi-training

USER sandbox
