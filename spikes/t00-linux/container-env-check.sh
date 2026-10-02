#!/bin/bash
set -e

echo "=== USER & IDENTITY ==="
whoami
id

echo "=== KERNEL & OS ==="
uname -a
if [ -f /etc/os-release ]; then
  cat /etc/os-release | grep -E '^(NAME|VERSION|ID)='
fi

echo "=== SECCOMP STATUS (/proc/self/status) ==="
grep -E '^(Seccomp|Seccomp_filters):' /proc/self/status || grep Seccomp /proc/self/status

echo "=== /dev/shm CONFIGURATION ==="
df -h /dev/shm
mount | grep shm || true

echo "=== TIMEZONE & DATE ==="
date
date +%Z
if [ -f /etc/timezone ]; then
  cat /etc/timezone
elif [ -L /etc/localtime ]; then
  readlink -f /etc/localtime
fi

echo "=== CJK / CHINESE FONTS CHECK ==="
echo "fc-list zh count: $(fc-list :lang=zh | wc -l)"
fc-list :lang=zh || true
echo "fc-list ja count: $(fc-list :lang=ja | wc -l)"
fc-list :lang=ja | head -n 5 || true

echo "=== CGROUP LIMITS VISIBILITY ==="
if [ -d /sys/fs/cgroup ]; then
  echo "cgroup v2 detected at /sys/fs/cgroup"
  if [ -f /sys/fs/cgroup/cpu.max ]; then
    echo "cpu.max: $(cat /sys/fs/cgroup/cpu.max)"
  fi
  if [ -f /sys/fs/cgroup/memory.max ]; then
    echo "memory.max: $(cat /sys/fs/cgroup/memory.max)"
  fi
  if [ -f /sys/fs/cgroup/memory.current ]; then
    echo "memory.current: $(cat /sys/fs/cgroup/memory.current)"
  fi
else
  echo "/sys/fs/cgroup not found"
fi

echo "=== NODE & PLAYWRIGHT ENV IN CONTAINER ==="
node --version
which npx
echo "Container environment check completed successfully."
