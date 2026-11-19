// 프레임 시간 기록. 보드는 필요할 때만 다시 그리므로, 카메라를 움직이거나 연출이 재생되는
// "연속으로 그리는 구간"의 프레임 간격만 모은다 (멈춘 화면의 대기 시간은 제외).

export interface PerfStats {
  /** 연속 구간 평균 FPS */
  fps: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
  samples: number;
  /** 마지막 프레임의 render() 호출 시간 */
  renderMs: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  canvas: string;
}

export interface PerfRecording {
  startedAt: number;
  durationMs: number;
  stats: PerfStats;
}

const MAX_GAP_MS = 250; // 이보다 긴 간격은 "멈춰 있다가 다시 그린" 것으로 보고 버린다

export class PerfMeter {
  private intervals: number[] = [];
  private lastFrame = 0;
  private recording: number[] | null = null;
  private recordStart = 0;
  renderMs = 0;

  /** 연속 렌더링 중인 프레임에서만 호출한다. */
  frame(now: number, continuous: boolean): void {
    if (this.lastFrame && continuous) {
      const dt = now - this.lastFrame;
      if (dt > 0 && dt < MAX_GAP_MS) {
        this.intervals.push(dt);
        if (this.intervals.length > 240) this.intervals.shift();
        this.recording?.push(dt);
      }
    }
    this.lastFrame = continuous ? now : 0;
  }

  /** 최근 연속 구간의 평균 프레임 시간 (자동 해상도 조정용) */
  recentAvg(n = 45): number | null {
    if (this.intervals.length < n) return null;
    const slice = this.intervals.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  resetRecent(): void {
    this.intervals = [];
  }

  startRecording(): void {
    this.recording = [];
    this.recordStart = performance.now();
  }

  stopRecording(extra: Omit<PerfStats, 'fps' | 'avgMs' | 'p95Ms' | 'worstMs' | 'samples'>): PerfRecording | null {
    const data = this.recording;
    this.recording = null;
    if (!data) return null;
    return { startedAt: this.recordStart, durationMs: performance.now() - this.recordStart, stats: { ...summarize(data), ...extra } };
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  stats(extra: Omit<PerfStats, 'fps' | 'avgMs' | 'p95Ms' | 'worstMs' | 'samples'>): PerfStats {
    return { ...summarize(this.intervals), ...extra };
  }
}

function summarize(data: number[]): Pick<PerfStats, 'fps' | 'avgMs' | 'p95Ms' | 'worstMs' | 'samples'> {
  if (data.length === 0) return { fps: 0, avgMs: 0, p95Ms: 0, worstMs: 0, samples: 0 };
  const sorted = [...data].sort((a, b) => a - b);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  return {
    fps: 1000 / avg,
    avgMs: avg,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    worstMs: sorted[sorted.length - 1],
    samples: data.length,
  };
}
