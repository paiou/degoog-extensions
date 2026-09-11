#!/bin/sh
set -e

# Clean up any stale X11 lock files from previous container restarts
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Start Xvfb virtual framebuffer on display :99 in background
echo "[Entrypoint] Starting Xvfb on display :99..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX -noreset &
XVFB_PID=$!

export DISPLAY=:99

# Wait for Xvfb server to be ready using xdpyinfo
echo "[Entrypoint] Waiting for Xvfb display :99 to be ready..."
READY=0
for i in $(seq 1 30); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done

if [ "$READY" -eq 1 ]; then
  echo "[Entrypoint] Xvfb display :99 is ready (PID: $XVFB_PID)."
else
  echo "[Entrypoint] Warning: xdpyinfo check timed out, proceeding anyway..."
fi

# Hand over to CMD as PID 1
exec "$@"
