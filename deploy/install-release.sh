#!/bin/bash
# deploy.ps1 이 올린 묶음(/tmp/devilsland.tgz)을 새 release 폴더에 풀고, 실행에 필요한 패키지만 설치한 뒤
# current 링크를 바꾸고 서비스를 다시 시작한다. 서버에서 sudo bash 로 실행된다.
set -euo pipefail

APP_DIR=/opt/devilsland
PKG=/tmp/devilsland.tgz

if [ ! -f /var/lib/devilsland/.setup-done ]; then
  echo "서버 첫 설정(setup-server.sh)이 아직 끝나지 않았습니다." >&2
  exit 1
fi

REL="$APP_DIR/releases/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REL"
tar -xzf "$PKG" -C "$REL"
cd "$REL"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R devilsland:devilsland "$REL"
ln -sfn "$REL" "$APP_DIR/current"
systemctl restart devilsland

for i in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1/; then break; fi
  sleep 1
done
systemctl is-active devilsland
curl -fsS -o /dev/null -w "http %{http_code}\n" http://127.0.0.1/

# 지난 release 는 최근 3개만 남긴다 (되돌릴 때 current 링크만 바꾸면 된다).
ls -1dt "$APP_DIR"/releases/* | tail -n +4 | xargs -r rm -rf
rm -f "$PKG"
echo "올리기 끝: $REL"
