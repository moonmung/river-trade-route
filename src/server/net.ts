import os from 'node:os';
import type { LanAddress } from '../shared/protocol';

const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|Loopback|Bluetooth|TAP-|Tailscale|ZeroTier|Hamachi|VPN|utun|vboxnet|docker|br-/i;
const LIKELY_LAN = /Wi-?Fi|WLAN|Wireless|무선|Ethernet|이더넷|en\d|eth\d|wlan\d/i;

function isPrivate(ip: string): boolean {
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** 이 PC 자신에서 온 연결인지 (서버를 켠 PC 에서만 쓰는 기능용). IPv4·IPv6·IPv4 매핑 IPv6 루프백을 모두 본다. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * 휴대폰이 접속할 수 있는 이 PC의 IPv4 주소 목록.
 * 가상 어댑터(WSL, Hyper-V, VirtualBox 등)는 뒤로 미루고, 와이파이·이더넷의 사설 IP를 앞에 둔다.
 */
export function getLanAddresses(): LanAddress[] {
  const found: { address: string; name: string; score: number }[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      const family = info.family as string | number;
      if ((family !== 'IPv4' && family !== 4) || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      let score = 0;
      if (isPrivate(info.address)) score += 10;
      if (info.address.startsWith('192.168.')) score += 2;
      if (LIKELY_LAN.test(name)) score += 3;
      if (VIRTUAL_ADAPTER.test(name)) score -= 20;
      found.push({ address: info.address, name, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.map((f, i) => ({ address: f.address, name: f.name, preferred: i === 0 }));
}
