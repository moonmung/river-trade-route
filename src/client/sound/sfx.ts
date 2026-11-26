// 효과음: 소리 파일 없이 Web Audio 로 그때그때 만든다 (발진기 + 걸러 낸 잡음 + 소리 크기 곡선).
// 브라우저는 사용자가 화면을 한 번 누르기 전에는 소리를 막으므로, 첫 누름·키 입력 때 소리 장치를 깨운다.
// 깨기 전에 난 소리는 쌓아 두지 않고 버린다 (나중에 한꺼번에 터지지 않게).
// 켜기/끄기와 음량은 이 기기에 저장한다 (메뉴 → 설정).
import { useSyncExternalStore } from 'react';
import type { DevKind, PieceKind } from '../../shared/types';
import { PARADE_LOWER_MS, type ParadeTiming } from '../board/parade';

export interface SoundSettings {
  on: boolean;
  /** 0~1 */
  volume: number;
}

const STORE_KEY = 'rr.sound';
const DEFAULT_SETTINGS: SoundSettings = { on: true, volume: 0.6 };

function loadSettings(): SoundSettings {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    const volume = typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_SETTINGS.volume;
    return { on: v.on !== false, volume };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let settings: SoundSettings = typeof window === 'undefined' ? DEFAULT_SETTINGS : loadSettings();
const listeners = new Set<() => void>();

export function soundSettings(): SoundSettings {
  return settings;
}

export function setSoundSettings(next: SoundSettings): void {
  settings = { on: next.on, volume: Math.min(1, Math.max(0, next.volume)) };
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* 저장소를 쓸 수 없으면 이번 화면에서만 유지 */
  }
  if (out && ctx) out.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.02);
  for (const l of listeners) l();
}

/** 메뉴의 소리 설정 칸에서 쓴다 */
export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
    () => DEFAULT_SETTINGS,
  );
}

// ───────────────────────── 소리 장치 ─────────────────────────

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** 귀에 들리는 크기가 고르게 늘도록 음량 막대를 조금 휘게 쓴다 */
function masterLevel(): number {
  return settings.on ? Math.pow(settings.volume, 1.6) : 0;
}

function createContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const c = new Ctor();
    // 여러 소리가 겹쳐도 찢어지지 않게 마지막에 살짝 누른다.
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    out = c.createGain();
    out.gain.value = masterLevel();
    out.connect(limiter).connect(c.destination);
    // 1초짜리 흰 잡음: 주사위 부딪힘, 카드, 바람 소리를 여기서 걸러 만든다.
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    ctx = c;
  } catch {
    ctx = null;
  }
  return ctx;
}

function unlock(): void {
  const c = createContext();
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
}

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true, passive: true });
}

/** 지금 소리를 낼 수 있으면 소리 장치 시각, 아니면 null (꺼 둠·음량 0·아직 깨지 않음) */
function clock(): number | null {
  if (!settings.on || settings.volume <= 0 || !ctx || !out || ctx.state !== 'running') return null;
  return ctx.currentTime;
}

// ───────────────────────── 기본 소리 ─────────────────────────

interface Tone {
  freq: number;
  /** 길이 (초) */
  dur: number;
  gain: number;
  /** 시작까지 (초) */
  at?: number;
  type?: OscillatorType;
  /** 끝날 때 이 높이로 미끄러진다 */
  to?: number;
  attack?: number;
  /** 낮은 소리만 통과 (Hz) */
  lowpass?: number;
  /** 떨림 (Hz, 깊이는 반음의 몇 분의 일) */
  vibrato?: number;
}

function tone(o: Tone): void {
  const t0 = clock();
  if (t0 === null) return;
  const c = ctx!;
  const t = t0 + (o.at ?? 0);
  const osc = c.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
  if (o.vibrato) {
    const lfo = c.createOscillator();
    const depth = c.createGain();
    lfo.frequency.value = o.vibrato;
    depth.gain.value = o.freq * 0.012;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + o.dur + 0.05);
  }
  const g = c.createGain();
  const attack = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, o.dur));
  let src: AudioNode = osc;
  if (o.lowpass) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lowpass;
    osc.connect(f);
    src = f;
  }
  src.connect(g).connect(out!);
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

interface Hiss {
  dur: number;
  gain: number;
  at?: number;
  /** 거르는 방식과 가운데 높이 (끝날 때 to 로 옮겨 간다) */
  filter: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
  attack?: number;
}

function hiss(o: Hiss): void {
  const t0 = clock();
  if (t0 === null || !noiseBuffer) return;
  const c = ctx!;
  const t = t0 + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  const f = c.createBiquadFilter();
  f.type = o.filter;
  f.frequency.setValueAtTime(o.freq, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
  f.Q.value = o.q ?? 1;
  const g = c.createGain();
  const attack = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, o.dur));
  src.connect(f).connect(g).connect(out!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + o.dur + 0.05);
}

const jitter = (x: number, k = 0.08) => x * (1 + (Math.random() * 2 - 1) * k);

/** 나무 두드림 (길 판자, 문 두드리기) */
function knock(at: number, freq: number, gain: number): void {
  tone({ at, freq: jitter(freq, 0.05), to: freq * 0.7, dur: 0.09, gain, type: 'triangle' });
  hiss({ at, dur: 0.035, gain: gain * 0.45, filter: 'lowpass', freq: 1400 });
}

/** 큰북 */
function drum(at: number, gain = 0.5): void {
  tone({ at, freq: 110, to: 48, dur: 0.32, gain });
  hiss({ at, dur: 0.08, gain: gain * 0.25, filter: 'lowpass', freq: 700 });
}

/** 작은북 */
function snare(at: number, gain = 0.18): void {
  hiss({ at, dur: 0.13, gain, filter: 'bandpass', freq: 2200, q: 0.7 });
  tone({ at, freq: 230, to: 160, dur: 0.07, gain: gain * 0.8, type: 'triangle' });
}

/** 종: 맑은 기음에 어긋난 배음을 조금 섞는다 */
function bell(at: number, freq: number, gain: number, dur = 1.1): void {
  tone({ at, freq, dur, gain });
  tone({ at, freq: freq * 2.76, dur: dur * 0.45, gain: gain * 0.25 });
  tone({ at, freq: freq * 5.4, dur: dur * 0.2, gain: gain * 0.1 });
}

/** 나팔: 톱니파를 거르고 살짝 떨게 한다 */
function brass(at: number, freq: number, dur: number, gain: number): void {
  tone({ at, freq, dur, gain, type: 'sawtooth', lowpass: 1900, attack: 0.025, vibrato: dur > 0.4 ? 5.5 : 0 });
  tone({ at, freq: freq * 2, dur, gain: gain * 0.25, type: 'sawtooth', lowpass: 2600, attack: 0.03 });
}

/** 동전 한 닢 */
function clink(at: number, gain = 0.1): void {
  const f = jitter(2200, 0.1);
  tone({ at, freq: f, dur: 0.22, gain });
  tone({ at, freq: f * 1.5, dur: 0.12, gain: gain * 0.6 });
  hiss({ at, dur: 0.02, gain: gain * 0.6, filter: 'highpass', freq: 5000 });
}

/** 사슬 철렁 */
function chain(at: number, gain = 0.06): void {
  for (let i = 0; i < 6; i++) {
    tone({ at: at + i * 0.045 + Math.random() * 0.02, freq: 2400 + Math.random() * 1800, dur: 0.06, gain, type: 'triangle' });
  }
}

const NOTE = { C4: 261.63, E4: 329.63, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568 };

// ───────────────────────── 게임 효과음 ─────────────────────────

export const sfx = {
  /** 주사위가 바닥·벽·서로에 부딪힘 (speed: 부딪힌 빠르기, 3~15쯤) */
  diceHit(speed: number): void {
    const k = Math.min(1, Math.max(0, (speed - 2) / 11));
    const gain = 0.05 + 0.3 * k;
    tone({ freq: jitter(1250, 0.2), to: 900, dur: 0.045, gain: gain * 0.5, type: 'triangle' });
    tone({ freq: jitter(340, 0.12), to: 240, dur: 0.07, gain: gain * 0.7 });
    hiss({ dur: 0.03, gain, filter: 'bandpass', freq: jitter(3000, 0.2), q: 1.4 });
  },
  /** 손안에서 흔드는 주사위 달그락 */
  diceShake(): void {
    tone({ freq: jitter(1500, 0.2), dur: 0.035, gain: 0.07, type: 'triangle' });
    hiss({ dur: 0.025, gain: 0.08, filter: 'bandpass', freq: jitter(3600, 0.2), q: 1.6 });
  },
  /** 주사위를 던짐: 바람 가르는 소리 */
  diceThrow(): void {
    hiss({ dur: 0.3, gain: 0.1, filter: 'bandpass', freq: 500, to: 1700, q: 0.9, attack: 0.06 });
  },
  /** 자리 순서를 정하는 2D 주사위: 몇 번 달그락거리다 멈춘다 */
  diceTumble(): void {
    for (let i = 0; i < 6; i++) {
      const at = i * 0.085 + Math.random() * 0.02;
      tone({ at, freq: jitter(1300, 0.2), dur: 0.04, gain: 0.06 + 0.02 * (6 - i), type: 'triangle' });
      hiss({ at, dur: 0.025, gain: 0.06, filter: 'bandpass', freq: jitter(3200, 0.2), q: 1.4 });
    }
  },
  /** 7: 낮은 나팔 두 음 */
  seven(): void {
    brass(0, 146.83, 0.28, 0.16);
    brass(0.3, 138.59, 0.6, 0.16);
    drum(0, 0.4);
    drum(0.3, 0.35);
  },
  /** 생산한 카드가 내 손에 닿음 (n 번째) */
  cardIn(n = 0): void {
    const f = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.E6][n % 5];
    tone({ freq: f, dur: 0.16, gain: 0.08, type: 'triangle' });
    hiss({ dur: 0.04, gain: 0.05, filter: 'highpass', freq: 3500 });
  },
  /** 다른 사람이 생산함: 짧고 작게 */
  production(): void {
    tone({ freq: NOTE.G5, dur: 0.14, gain: 0.04, type: 'triangle' });
    tone({ at: 0.07, freq: NOTE.C6, dur: 0.18, gain: 0.035, type: 'triangle' });
  },
  build(piece: PieceKind): void {
    if (piece === 'road') {
      knock(0, 200, 0.22);
      knock(0.12, 235, 0.2);
      return;
    }
    if (piece === 'ship') {
      sfx.sail();
      return;
    }
    if (piece === 'village') {
      for (const at of [0, 0.13, 0.26]) {
        tone({ at, freq: jitter(1600, 0.05), dur: 0.03, gain: 0.05, type: 'square', lowpass: 3500 });
        tone({ at, freq: jitter(420, 0.05), to: 300, dur: 0.08, gain: 0.18 });
      }
      bell(0.42, NOTE.C6, 0.05, 0.6);
      return;
    }
    // 도시: 돌을 쿵 내려놓고 종이 울린다.
    tone({ freq: 120, to: 55, dur: 0.38, gain: 0.42 });
    hiss({ dur: 0.22, gain: 0.14, filter: 'lowpass', freq: 500 });
    bell(0.28, NOTE.G4, 0.11, 1.4);
    bell(0.28, NOTE.C5 * 1.0, 0.05, 1.2);
  },
  /** 배 띄우기·옮기기: 물에 미끄러져 들어가는 쏴 소리와 나무 배가 삐걱 */
  sail(): void {
    hiss({ dur: 0.45, gain: 0.1, filter: 'bandpass', freq: 700, to: 1400, q: 0.7 });
    hiss({ at: 0.12, dur: 0.35, gain: 0.06, filter: 'lowpass', freq: 900 });
    knock(0.08, 170, 0.16);
    tone({ at: 0.22, freq: 330, to: 260, dur: 0.12, gain: 0.05, type: 'triangle' });
  },
  /** 발전 카드 사기: 카드 섞는 소리 */
  buyDev(): void {
    for (const at of [0, 0.06, 0.12, 0.18]) hiss({ at, dur: 0.05, gain: 0.07, filter: 'highpass', freq: 2200 });
    hiss({ at: 0.3, dur: 0.07, gain: 0.12, filter: 'bandpass', freq: 1500, q: 0.8 });
  },
  /** 발전 카드 쓰기: 카드를 탁 내려놓고 카드마다 다른 소리 */
  playDev(card: Exclude<DevKind, 'victory'>): void {
    hiss({ dur: 0.07, gain: 0.16, filter: 'bandpass', freq: 1500, q: 0.8 });
    tone({ freq: 190, to: 120, dur: 0.08, gain: 0.15 });
    if (card === 'knight') {
      // 칼 뽑는 소리
      hiss({ at: 0.1, dur: 0.35, gain: 0.08, filter: 'highpass', freq: 3500, to: 7500 });
      tone({ at: 0.12, freq: 2350, dur: 0.9, gain: 0.04 });
      tone({ at: 0.12, freq: 3530, dur: 0.6, gain: 0.025 });
    } else if (card === 'monopoly') {
      for (let i = 0; i < 5; i++) clink(0.12 + i * 0.07, 0.07);
    } else if (card === 'year_of_plenty') {
      [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((f, i) => tone({ at: 0.1 + i * 0.07, freq: f, dur: 0.3, gain: 0.07, type: 'triangle' }));
    } else {
      knock(0.12, 200, 0.18);
      knock(0.24, 235, 0.16);
    }
  },
  /** 기사단 동상이 들려 날아가고(바람), landAt 초 뒤에 쿵 내려앉으며 사슬이 철렁인다 */
  robber(landAt: number): void {
    hiss({ dur: Math.max(0.3, landAt), gain: 0.07, filter: 'bandpass', freq: 300, to: 900, q: 0.8, attack: 0.15 });
    tone({ at: landAt, freq: 90, to: 42, dur: 0.45, gain: 0.45 });
    hiss({ at: landAt, dur: 0.18, gain: 0.12, filter: 'lowpass', freq: 600 });
    chain(landAt + 0.08);
  },
  /** 자원 빼앗기: 휙 낚아챔 */
  steal(): void {
    hiss({ dur: 0.22, gain: 0.13, filter: 'bandpass', freq: 2600, to: 700, q: 1.1 });
    tone({ at: 0.05, freq: 900, to: 450, dur: 0.12, gain: 0.05, type: 'triangle' });
  },
  /** 내가 해야 할 일이 생김 (버리기 등) */
  alert(): void {
    tone({ freq: NOTE.A5, dur: 0.1, gain: 0.07, type: 'square', lowpass: 2600 });
    tone({ at: 0.13, freq: NOTE.A5, dur: 0.14, gain: 0.07, type: 'square', lowpass: 2600 });
  },
  /** 내 차례: 맑은 종 두 번 */
  myTurn(): void {
    bell(0, NOTE.A5, 0.11, 1);
    bell(0.14, NOTE.E6 * 0.75, 0.08, 1.1);
  },
  /** 내 차례 남은 시간 (마지막 10초, urgent 는 마지막 3초) */
  tick(urgent: boolean): void {
    tone({ freq: urgent ? 1400 : 1000, dur: 0.05, gain: urgent ? 0.09 : 0.05 });
    hiss({ dur: 0.012, gain: 0.04, filter: 'highpass', freq: 5000 });
  },
  /** 나에게 교환 제안이 옴: 똑똑 */
  tradeOffer(): void {
    knock(0, 330, 0.16);
    knock(0.16, 330, 0.14);
  },
  /** 교환 성사: 동전 */
  tradeDone(): void {
    clink(0, 0.1);
    clink(0.08, 0.08);
    clink(0.17, 0.07);
  },
  /** 은행 교환 */
  bankTrade(): void {
    clink(0, 0.08);
    clink(0.09, 0.06);
  },
  /** 해상 교역 배가 들어옴: 뱃고동, 짐을 내릴 즈음 동전 */
  ship(): void {
    tone({ freq: 146.83, dur: 1.0, gain: 0.1, type: 'sawtooth', lowpass: 650, attack: 0.12, vibrato: 4 });
    tone({ freq: 220, dur: 0.9, gain: 0.05, type: 'sawtooth', lowpass: 800, attack: 0.15 });
    clink(1.3, 0.07);
    clink(1.4, 0.06);
  },
  /** 최장 교역로: 오르는 화음 */
  longestRoad(): void {
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((f, i) => tone({ at: i * 0.1, freq: f, dur: 0.4, gain: 0.1, type: 'triangle' }));
    for (let i = 0; i < 6; i++) tone({ at: 0.45 + i * 0.06, freq: NOTE.C6 * (1 + i * 0.25), dur: 0.2, gain: 0.025 });
  },
  /**
   * 최강 기사단 사열 (board/parade.ts 의 박자): 광장에 병사가 한 줄씩 들어설 때마다 북이 울리고, 다 함께 칼을 들 때 나팔이 분다.
   * 칼을 내린 뒤에는 제자리걸음에 맞춰 발소리가 난다. golden 이면 나팔이 제 높이로 밝게 더 길게 울리고 반짝이는 소리가 덧붙는다.
   */
  army(t: ParadeTiming, golden = false): void {
    const sec = (ms: number) => ms / 1000;
    for (let i = 0; i < t.ranks; i++) {
      drum(sec(t.start + i * t.gap), 0.42);
      snare(sec(t.start + i * t.gap + t.gap / 2), 0.12);
    }
    for (let ms = t.lower + PARADE_LOWER_MS; ms < t.fade; ms += t.step) {
      tone({ at: sec(ms), freq: 95, to: 55, dur: 0.12, gain: 0.16 });
      hiss({ at: sec(ms), dur: 0.05, gain: 0.05, filter: 'lowpass', freq: 900 });
    }
    const salute = sec(t.salute);
    // 보통은 한 옥타브 낮게 묵직하게, 황금 기사단은 제 높이로 밝게. 위에 장3도를 겹쳐 분다.
    const octave = golden ? 1 : 0.5;
    const notes: [number, number, number][] = [
      [0, NOTE.G4, 0.16],
      [0.18, NOTE.C5, 0.16],
      [0.36, NOTE.E5, 0.16],
      [0.54, NOTE.G5, golden ? 1.2 : 0.8],
    ];
    for (const [at, f, dur] of notes) {
      brass(salute + at, f * octave, dur, 0.09);
      brass(salute + at, f * octave * 1.26, dur, 0.04);
    }
    drum(salute + 0.54, 0.5);
    snare(salute + 0.54, 0.16);
    if (golden) for (let i = 0; i < 8; i++) tone({ at: salute + 0.6 + i * 0.07, freq: NOTE.C6 * (1 + i * 0.2), dur: 0.25, gain: 0.03 });
  },
  /** 게임 끝: 이기면 팡파르, 아니면 짧은 마침 */
  /** 승리 자랑: 짧은 나팔 세 마디 */
  fanfare(): void {
    brass(0, NOTE.G4, 0.12, 0.06);
    brass(0.12, NOTE.C5, 0.12, 0.06);
    brass(0.24, NOTE.E5, 0.5, 0.07);
    brass(0.24, NOTE.C5, 0.5, 0.04);
  },
  /** 승리 연출에서 점수가 오를 때: 단계마다 종소리가 한 음씩 오르고, 달성·승점 카드(big)는 화음으로 울린다 */
  victoryCount(n: number, big = false): void {
    const scale = [NOTE.C5, NOTE.D5, NOTE.E5, NOTE.G5, NOTE.A5, NOTE.C6, NOTE.E6, NOTE.G6];
    const f = scale[Math.min(n, scale.length - 1)];
    knock(0, 480 + Math.min(n, 12) * 25, 0.1);
    bell(0, f, big ? 0.08 : 0.065, big ? 0.9 : 0.55);
    if (big) bell(0.05, f * 1.26, 0.05, 0.85);
  },
  gameEnd(won: boolean): void {
    if (won) {
      [NOTE.C5, NOTE.E5, NOTE.G5].forEach((f, i) => brass(i * 0.15, f, 0.14, 0.08));
      brass(0.45, NOTE.C6, 1.1, 0.09);
      brass(0.45, NOTE.E5, 1.1, 0.05);
      drum(0.45, 0.5);
      return;
    }
    tone({ freq: NOTE.G4, dur: 0.35, gain: 0.08, type: 'triangle' });
    tone({ at: 0.3, freq: NOTE.C4, dur: 0.8, gain: 0.08, type: 'triangle' });
  },
  /** 소리 설정에서 들어 보기 */
  sample(): void {
    sfx.diceHit(9);
    sfx.diceHit(5);
    bell(0.25, NOTE.A5, 0.1, 0.9);
  },
};
