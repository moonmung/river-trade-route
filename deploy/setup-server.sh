#!/bin/bash
# 데블스랜드 클라우드 서버 첫 설정 (Ubuntu 24.04, x86_64·arm64).
# deploy.ps1 -Setup 이 서버에 올려 sudo bash 로 한 번 실행한다. Lightsail 시작 스크립트에 넣으면 /bin/sh 로 합쳐져 돌아서
# bash 전용 문법(set -o pipefail 등)에서 멈추므로 시작 스크립트로는 쓰지 않는다.
# 하는 일: Node.js 22(nodejs.org 공식 파일을 SHASUMS256 으로 확인) 설치, 실행 계정과 폴더, 스왑 1GB, systemd 서비스 등록.
# 앱 파일은 deploy.ps1 이 /opt/devilsland/releases/ 아래에 올리고 current 링크를 바꾼 뒤 서비스를 다시 시작한다.
set -euo pipefail

NODE_MAJOR=22
APP_USER=devilsland
APP_DIR=/opt/devilsland
DATA_DIR=/var/lib/devilsland

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl xz-utils ca-certificates
# 서버 로그(journalctl)와 게임 기록 시각을 한국 시간으로 맞춘다.
timedatectl set-timezone Asia/Seoul || true

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "지원하지 않는 CPU: $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE=$(grep -oE "node-v[0-9.]+-linux-${ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep "  $FILE\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$TMP/$FILE" -C /usr/local/lib/nodejs
  ln -sfn "/usr/local/lib/nodejs/${FILE%.tar.xz}" /usr/local/lib/nodejs/current
  for b in node npm npx; do ln -sf "/usr/local/lib/nodejs/current/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$TMP"
fi
node --version

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/releases" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

# 메모리가 작은 서버에서 npm ci 가 메모리 부족으로 죽지 않게 스왑 1GB 를 둔다.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 80번 포트로 바로 받는다. 같은 서버 안에 nginx 같은 프록시를 두면 모든 접속이 127.0.0.1 에서 온 것으로 보여
# "서버를 켠 PC에서만" 되는 방 목록·지우기가 누구에게나 열리므로 프록시를 두지 않는다.
cat > /etc/systemd/system/devilsland.service <<'UNIT'
[Unit]
Description=Devilsland game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=devilsland
Group=devilsland
WorkingDirectory=/opt/devilsland/current
Environment=NODE_ENV=production
Environment=PORT=80
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/var/lib/devilsland
ExecStart=/usr/local/bin/node dist/server/index.js
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/devilsland

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable devilsland.service
touch /var/lib/devilsland/.setup-done
echo "데블스랜드 서버 준비 끝"
