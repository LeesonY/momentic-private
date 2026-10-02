#!/bin/bash
set -e

REPO_ROOT="/Users/dcp/Documents/公司/momentic"
SPIKE_DIR="${REPO_ROOT}/spikes/t00-linux"
EVIDENCE_DIR="${SPIKE_DIR}/evidence"
FIXTURE_DIR="${REPO_ROOT}/packages/test-fixture"
IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"

mkdir -p "${EVIDENCE_DIR}"
chmod 777 "${EVIDENCE_DIR}"

echo "========================================================"
echo "  LocalQA T00 Linux Container Compatibility Suite"
echo "========================================================"

# Step 1: Record Image Details
echo "[STEP 1] Inspecting Image: ${IMAGE}"
docker image inspect "${IMAGE}" > "${EVIDENCE_DIR}/docker-image-inspect.json"

IMAGE_ID=$(docker image inspect "${IMAGE}" --format '{{.Id}}')
IMAGE_ARCH=$(docker image inspect "${IMAGE}" --format '{{.Architecture}}')
IMAGE_OS=$(docker image inspect "${IMAGE}" --format '{{.Os}}')
IMAGE_SIZE=$(docker image inspect "${IMAGE}" --format '{{.Size}}')
REPO_DIGESTS=$(docker image inspect "${IMAGE}" --format '{{range .RepoDigests}}{{.}} {{end}}')

echo "Image ID: ${IMAGE_ID}"
echo "Architecture: ${IMAGE_ARCH} (${IMAGE_OS})"
echo "Virtual Size: ${IMAGE_SIZE} bytes"
echo "Repo Digests: ${REPO_DIGESTS}"

# Step 2: System & Security Checks (non-root, seccomp, shm, fonts, timezone)
echo ""
echo "[STEP 2] Running Container Environment Check (--user pwuser)"
docker run --rm \
  --name t00-env-check \
  --user pwuser \
  -v "${REPO_ROOT}:/work:ro" \
  -v "${EVIDENCE_DIR}:/evidence" \
  "${IMAGE}" \
  bash /work/spikes/t00-linux/container-env-check.sh | tee "${EVIDENCE_DIR}/container-env-check.log"

# Step 3: cgroup v2 Resource Limit Visibility
echo ""
echo "[STEP 3] Running cgroup Limit Visibility Check (--cpus=1.5 --memory=1g)"
docker run --rm \
  --name t00-cgroup-check \
  --cpus=1.5 \
  --memory=1g \
  "${IMAGE}" \
  bash -c '
    echo "=== CGROUP LIMITS ==="
    echo "cpu.max: $(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "NOT_FOUND")"
    echo "memory.max: $(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "NOT_FOUND")"
    echo "memory.current: $(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo "NOT_FOUND")"
  ' | tee "${EVIDENCE_DIR}/cgroup-check.log"

# Step 4: Real Browser Action with Sandbox Enabled (NO --no-sandbox) & Fixture
echo ""
echo "[STEP 4] Running Real Browser Action with Sandbox Enabled (NO --no-sandbox)"
docker run --rm \
  --name t00-browser-verify \
  --user pwuser \
  --cap-add=SYS_ADMIN \
  -v "${REPO_ROOT}:/work:ro" \
  -v "${EVIDENCE_DIR}:/evidence" \
  -e EVIDENCE_DIR=/evidence \
  -e FIXTURE_DIR=/work/packages/test-fixture \
  -e FIXTURE_PORT=8080 \
  -w /work/packages/test-fixture \
  "${IMAGE}" \
  node /work/spikes/t00-linux/browser-verify.mjs | tee "${EVIDENCE_DIR}/browser-verify.log"

# Step 5: /dev/shm Restricted Behavior Test
echo ""
echo "[STEP 5] Running Restricted /dev/shm Behavior Test (--shm-size=16m)"
docker run --rm \
  --name t00-shm-check \
  --user pwuser \
  --cap-add=SYS_ADMIN \
  --shm-size=16m \
  -v "${REPO_ROOT}:/work:ro" \
  -v "${EVIDENCE_DIR}:/evidence" \
  -e EVIDENCE_DIR=/evidence \
  -w /work/packages/test-fixture \
  "${IMAGE}" \
  node /work/spikes/t00-linux/shm-check.mjs | tee "${EVIDENCE_DIR}/shm-check.log"

# Step 6: Cleanup Verification & Docker System DF
echo ""
echo "[STEP 6] Cleanup Verification & Disk Usage"
echo "Checking running/stopped containers..."
docker ps -a --filter "name=t00-" | tee "${EVIDENCE_DIR}/cleanup-containers.log"

echo "Docker system disk usage:"
docker system df | tee "${EVIDENCE_DIR}/docker-system-df.log"

echo ""
echo "========================================================"
echo "  All Linux container checks executed successfully!"
echo "========================================================"
