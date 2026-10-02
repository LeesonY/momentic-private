#!/bin/bash
IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"

echo "Attempting to pull ${IMAGE} with retries..."
MAX_ATTEMPTS=20
for i in $(seq 1 $MAX_ATTEMPTS); do
  echo "=== Pull Attempt $i / $MAX_ATTEMPTS ==="
  if docker pull "$IMAGE"; then
    echo "Successfully pulled $IMAGE on attempt $i"
    exit 0
  fi
  echo "Attempt $i failed. Retrying in 2 seconds..."
  sleep 2
done

echo "Failed to pull $IMAGE after $MAX_ATTEMPTS attempts"
exit 1
