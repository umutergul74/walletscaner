FROM walletscaner-worker:queue-recovery-r53-20260901

LABEL org.opencontainers.image.revision="cd0eeeeace26cfbb75219d65f263007aaee411c5"
LABEL org.opencontainers.image.version="queue-recovery-r53-1-20260901"
LABEL walletscaner.base-image-id="sha256:5845c8871753022f0374d9973cbdf9e47ab7488e8df84c92ded11ddd38ed9578"

COPY packages/providers/src/solana-event-source.ts /app/packages/providers/src/solana-event-source.ts
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
