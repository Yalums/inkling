import { PluginFileAPI, PluginCommAPI, PluginNoteAPI, PluginManager } from 'sn-plugin-lib';
import { FileLogger } from './FileLogger';
import NativePageCheckerBridge from './NativePageCheckerBridge';

// ── 模式类型 ─────────────────────────────────────────────────────────────────
export type InsertMode = 'nospacing' | 'paragraph';

/** 文本来源：LocalSend 实时跟随气泡 Y，Broadcast (中转站) 仅翻页时更新 */
export type TextSource = 'localsend' | 'broadcast' | 'unknown';

/** 队列项：文本 + 来源 */
interface QueueItem {
  text: string;
  source: TextSource;
}

// ── 通用常量 ─────────────────────────────────────────────────────────────────
const PAGE_MARGIN_RIGHT = 0.04;
const PAGE_MARGIN_LEFT  = 0.07;

/**
 * 基准 TOP_MARGIN：150px 对应 A5/A6/A6X/A5X/Nomad 的 1872px 页面高度。
 * Manta (2560px) 会按比例自动缩放到 ~205px。
 * 运行时通过 _topMargin() 方法获取实际值。
 */
const TOP_MARGIN_BASE     = 150;
/** A5/A6/A6X/A5X/Nomad 的基准页面高度 */
const BASE_PAGE_HEIGHT    = 1872;

/** CJK 字符宽度因子（全宽，约等于 fontSize） */
const CHAR_WIDTH_FACTOR_CJK = 1.0;
/** ASCII/拉丁字符宽度因子（半宽，略保守避免截字） */
const CHAR_WIDTH_FACTOR_LATIN = 0.62;
const FONT_SIZE         = 36;
const INTERVAL_MS       = 200;
const PAGE_CHECK_MS     = 500;

/** 抬笔后等多久才允许插入（ms）—— 核心防崩参数 */
const PEN_SAFE_GAP_MS   = 2000;

/** SDK 调用超时（ms）—— 防止 Promise 永久挂起导致链路卡死 */
const SDK_TIMEOUT_MS    = 8000;

// ── 模式专属配置 ─────────────────────────────────────────────────────────────
interface ModeConfig {
  /** 文本框之间的像素间距（0=紧贴，正值=拉开） */
  boxGap: number;
  /** 页面填充阈值（占页面高度的比例，到达后翻页） */
  threshold: number;
  /** 行高倍率（用于估算 boxH） */
  lineHeightRatio: number;
  /** 段间额外行高倍数（仅段落模式有） */
  newlineGapLines: number;
}

const MODE_CONFIG: Record<InsertMode, ModeConfig> = {
  nospacing: {
    boxGap: 0,
    threshold: 0.87,
    lineHeightRatio: 1.4,
    newlineGapLines: 0,
  },
  paragraph: {
    boxGap: 40,
    threshold: 0.80,
    lineHeightRatio: 1.6,
    newlineGapLines: 0.3,
  },
};

// ── 已占用区域（用于碰撞检测）────────────────────────────────────────────────
interface OccupiedRange {
  top: number;
  bottom: number;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 给任意 Promise 加超时保护。
 * 超时不会 cancel 原 promise，但调用方会拿到 reject，链路不会卡死。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── TextInserter 类 ──────────────────────────────────────────────────────────
export class TextInserter {
  private textQueue: QueueItem[] = [];
  private pageSize: { width: number; height: number } | null = null;
  private notePath = '';
  private currentPage = 0;
  private targetPage  = 0;
  private pageNextTop = new Map<number, number>();

  private timerRef: ReturnType<typeof setTimeout> | null = null;
  /** Native Handler tick 订阅句柄（替代原 JS setInterval pageCheckRef） */
  private pageTickSub: { remove(): void } | null = null;
  private activeMode: InsertMode | null = null;

  /** 防重入锁：flush / scheduleNext 同一时刻只能有一个在跑 */
  private inserting = false;

  /** _scheduleNext 最后一次实际执行的时间戳，用于检测定时器冻结 */
  private lastScheduleAt = 0;

  /** 上一次 pen-up 的时间戳（0 = 未知/无笔活动） */
  private lastPenUpAt = 0;

  /** pen-up 事件订阅 */
  private penUpSub: { remove(): void } | null = null;

  /**
   * 暂停标志：paused 时队列仍然接收文本，但 _scheduleNext 跳过消费。
   * 用于用户从文本状态气泡切回工具栏时暂停写入，恢复后继续。
   */
  private _paused = false;
  private _resumeWaitStart = 0;
  /**
   * 记录进入 page-wait 状态（timerRef=null, activeMode!=null）的时间戳。
   * 用于 8 秒兜底：如果 _checkPageAndResume 一直无法检测到翻页
   * （SDK 不可用或 targetPage 号码有偏差），超时后强制尝试恢复插入。
   */
  private _pausedSince = 0;
  private _scheduleNextDeferred: InsertMode | null = null;
  private _deferredTimerRef: any = null;

  /**
   * 已占用区域缓存（当前目标页的已有文本框坐标）。
   * 仅在首次插入和换页时刷新，避免每次 insertText 前都全量扫描。
   */
  private _occupiedRanges: OccupiedRange[] = [];
  private _occupiedPage = -1;

  /**
   * 预期总页数：start() 时记录，insertNotePage 后 +1。
   * 用于在 _checkPageAndResume 中检测用户手动加页或删页导致的页码偏移。
   */
  private _expectedTotalPages = -1;

  /**
   * page-wait 标志：insertNotePage 后等待用户翻页时为 true。
   * 与 timerRef===null 配合，区分"正常空闲"和"等待翻页"两种状态，
   * 防止 enqueue() 在等待翻页时直接唤醒 _scheduleNext 导致内容插入到错误页面。
   */
  private _isPageWait = false;

  private onAck?: (text: string, success: boolean, error: string | null) => void;
  private onPositionChanged?: (page: number, nextTop: number, source: TextSource, isPageChange: boolean) => void;
  /**
   * 笔记上下文变更回调：
   *   - reason='note_switched': 用户切换到了另一个笔记文件
   *   - reason='pages_changed': 总页数被外部改变（手动加/删页）
   * 触发后插入器自动 stop，调用方应更新 UI 状态。
   */
  private onNoteChanged?: (reason: 'note_switched' | 'pages_changed', detail: string) => void;
  /** page-wait 状态变更回调（进入/离开等待翻页状态） */
  private onPageWaitChanged?: (waiting: boolean, targetPage: number) => void;

  constructor(
    onAck?: (text: string, success: boolean, error: string | null) => void,
    onPositionChanged?: (page: number, nextTop: number, source: TextSource, isPageChange: boolean) => void,
    onNoteChanged?: (reason: 'note_switched' | 'pages_changed', detail: string) => void,
    onPageWaitChanged?: (waiting: boolean, targetPage: number) => void,
  ) {
    this.onAck = onAck;
    this.onPositionChanged = onPositionChanged;
    this.onNoteChanged = onNoteChanged;
    this.onPageWaitChanged = onPageWaitChanged;
  }

  // ── 动态 TOP_MARGIN ───────────────────────────────────────────────────────

  /**
   * 根据当前 pageSize.height 计算实际 TOP_MARGIN。
   * A5/A6/A6X/A5X/Nomad (1872px) → 150px（不变）
   * Manta (2560px) → ~205px
   * 其他尺寸按比例线性缩放。
   */
  private _topMargin(): number {
    if (!this.pageSize) return TOP_MARGIN_BASE;
    return Math.round(TOP_MARGIN_BASE * (this.pageSize.height / BASE_PAGE_HEIGHT));
  }

  // ── 公开 API ──────────────────────────────────────────────────────────────

  enqueue(text: string, source: TextSource = 'unknown') {
    this.textQueue.push({ text, source });
    // 注意：_paused 状态下不 kick-start，文本只入队等恢复后处理
    // 注意：_isPageWait 状态下不 kick-start，必须等用户翻到 targetPage 后由 _checkPageAndResume 唤醒
    if (this.activeMode && !this.inserting && !this._paused && !this._isPageWait) {
      if (this.timerRef === null) {
        // 调度器空闲（例如之前队列空了），收到新文本后直接唤醒
        console.log('[TextInserter]: waking up from enqueue');
        this.timerRef = 1 as any;
        this._scheduleNext(this.activeMode);
      } else {
        // 调度器在运行，但可能是 setTimeout 在后台被系统冻结了
        const stale = Date.now() - this.lastScheduleAt > INTERVAL_MS * 3;
        if (stale) {
          console.log('[TextInserter]: timer stale, kick-starting from enqueue');
          this._scheduleNext(this.activeMode);
        }
      }
    }
  }

  clearQueue() {
    this.textQueue = [];
  }

  /** 队列中待消费的文本数量 */
  getQueueLength(): number {
    return this.textQueue.length;
  }

  isRunning(): boolean {
    return this.activeMode !== null;
  }

  /** 定时器是否存活（closePluginView 后 JS timer 可能冻死，但 native poller 仍存活） */
  hasLiveTimers(): boolean {
    return this.timerRef !== null || this.pageTickSub !== null;
  }

  getMode(): InsertMode | null {
    return this.activeMode;
  }

  // ── 暂停 / 恢复 ────────────────────────────────────────────────────────────

  /**
   * 暂停消费：定时器继续跑，但 _insertParagraph 不从队列取文本。
   * enqueue() 仍可入队（中转站/Broadcast 来的文本不丢失）。
   * 用于：用户点击文本状态气泡 → 切换回工具栏悬浮窗时。
   */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    console.log('[TextInserter]: ⏸ paused (queue len=', this.textQueue.length, ')');
    FileLogger.logEvent('InsertPaused', `queueLen=${this.textQueue.length}`);
  }

  /**
   * 恢复消费：清除暂停标志并 kick-start 调度器。
   * 用于：用户从工具栏点击 T= / T¶ 恢复文本接收时。
   */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    console.log('[TextInserter]: ▶ resumed (queue len=', this.textQueue.length, ')');
    FileLogger.logEvent('InsertResumed', `queueLen=${this.textQueue.length}`);
    // 如果存在 activeMode 且不在 page-wait，即使 timerRef 被置空，也要重新激活调度
    // page-wait 状态下不唤醒调度器，由 _checkPageAndResume 在翻页后负责唤醒
    if (this.activeMode && !this.inserting && !this._isPageWait) {
      if (this.timerRef !== null) clearTimeout(this.timerRef as any);
      this.timerRef = 1 as any;
      this._scheduleNext(this.activeMode);
    }
  }

  isPaused(): boolean {
    return this._paused;
  }

  /** 是否正在等待用户翻页（page-wait 状态） */
  isPageWaiting(): boolean {
    return this._isPageWait;
  }

  /** 当前笔记路径 */
  getNotePath(): string {
    return this.notePath;
  }

  // ── 位置控制 ────────────────────────────────────────────────────────────────

  /**
   * 设置当前目标页的插入起始 top，只往前推进不后退（防止文字覆盖）。
   * 主要用于 AI 回复定位：在套索最后一个文本框下方开始插入。
   * 若提供的 top 已超过页面阈值，_insertParagraph 会自动触发加页机制。
   */
  setStartTopIfAdvance(top: number) {
    const tm = this._topMargin();
    const current = this.pageNextTop.get(this.targetPage) ?? tm;
    if (top > current) {
      this.pageNextTop.set(this.targetPage, top);
      FileLogger.logEvent('SetStartTop',
        `page=${this.targetPage} advanced from ${current} to ${top}`);
      console.log('[TextInserter]: setStartTopIfAdvance page=', this.targetPage,
        'advanced', current, '→', top);
    }
  }

  /**
   * 强制设置当前目标页的插入位置（可前可后）。
   * 用于可拖拽气泡：用户拖到哪里就从哪里开始插入。
   */
  forceSetNextTop(top: number) {
    const tm = this._topMargin();
    const clamped = Math.max(tm, top);
    this.pageNextTop.set(this.targetPage, clamped);
    console.log('[TextInserter]: forceSetNextTop page=', this.targetPage, 'top=', clamped);
    this.onPositionChanged?.(this.targetPage, clamped, 'unknown', false);
  }

  /** 当前目标页码 */
  getTargetPage(): number { return this.targetPage; }

  /** 当前插入 Y 坐标 */
  getNextTop(): number {
    return this.pageNextTop.get(this.targetPage) ?? this._topMargin();
  }

  /** 页面尺寸（start 后才有值） */
  getPageSize(): { width: number; height: number } | null {
    return this.pageSize;
  }

  /**
   * 切换插入模式但保留当前位置。
   * 从 nospacing → paragraph 时，追加 gap差值 + 一个文本行高，确保与之前的无间距文本不重叠。
   * 从 paragraph → nospacing 时，不减间距（已插入位置不可后退）。
   * @returns true 切换成功，false 条件不满足（未运行或无页面信息）
   */
  switchMode(newMode: InsertMode): boolean {
    if (!this.activeMode || !this.pageSize) return false;

    const oldMode = this.activeMode;
    if (oldMode === newMode) return true;

    this._applyModeSwitchGapInternal(oldMode, newMode);

    this.activeMode = newMode;

    // 切换模式时自动恢复（如果之前暂停了）
    if (this._paused) {
      this._paused = false;
      console.log('[TextInserter]: auto-resume on switchMode');
    }

    // 重启调度器使用新模式（如果正在运行）
    if (this.timerRef !== null) {
      clearTimeout(this.timerRef as any);
      this.timerRef = 1 as any;
      this._scheduleNext(newMode);
    }

    console.log('[TextInserter]: switchMode', oldMode, '→', newMode);
    FileLogger.logEvent('SwitchMode',
      `${oldMode} → ${newMode} nextTop=${this.pageNextTop.get(this.targetPage)}`);
    return true;
  }

  /**
   * 从 BackgroundService cold path 调用：start(mode, true) 之后追加模式切换间距。
   * 与 switchMode 内部共享同一段间距计算逻辑。
   */
  applyModeSwitchGap(fromMode: InsertMode, toMode: InsertMode): void {
    if (!this.pageSize) return;
    if (fromMode === toMode) return;
    this._applyModeSwitchGapInternal(fromMode, toMode);
  }

  /** 内部：计算并追加模式切换间距 */
  private _applyModeSwitchGapInternal(fromMode: InsertMode, toMode: InsertMode): void {
    const oldCfg = MODE_CONFIG[fromMode];
    const newCfg = MODE_CONFIG[toMode];
    const tm = this._topMargin();

    // 切到间距更大的模式 → gap差值 + 一个完整文本行高（防止与上方文字重叠）
    if (newCfg.boxGap > oldCfg.boxGap) {
      const currentTop = this.pageNextTop.get(this.targetPage) ?? tm;
      const gapDiff = newCfg.boxGap - oldCfg.boxGap;
      const oneLineHeight = Math.ceil(FONT_SIZE * newCfg.lineHeightRatio);
      const extraGap = gapDiff + oneLineHeight;
      this.pageNextTop.set(this.targetPage, currentTop + extraGap);
      console.log('[TextInserter]: modeSwitchGap +', extraGap,
        '(gapDiff=', gapDiff, 'lineH=', oneLineHeight, ') → nextTop=', currentTop + extraGap);
    }
  }

  /**
   * 启动插入模式。返回 true 表示成功，false 表示初始化失败。
   * @param preservePosition 若为 true 则不清除已记录的插入位置（用于从 bubble 恢复）
   */
  async start(mode: InsertMode, preservePosition = false): Promise<boolean> {
    this.stop(true);
    if (!preservePosition) {
      this.pageNextTop.clear();
    }
    this.activeMode = mode;
    this.lastPenUpAt = 0;
    this.inserting = false;
    this._paused = false;
    this._isPageWait = false;

    // ── 注册 pen-up 监听 ──
    this._registerPenUp();

    try {
      const fpRes = await withTimeout(
        PluginCommAPI.getCurrentFilePath() as Promise<any>,
        SDK_TIMEOUT_MS, 'getCurrentFilePath',
      );
      if (fpRes?.success && fpRes.result) this.notePath = fpRes.result;

      const pgRes = await withTimeout(
        PluginCommAPI.getCurrentPageNum() as Promise<any>,
        SDK_TIMEOUT_MS, 'getCurrentPageNum',
      );
      if (pgRes?.success && typeof pgRes.result === 'number') {
        this.currentPage = pgRes.result;
        this.targetPage  = pgRes.result;
      }

      // getPageSize は notePath が空だと失敗する。notePath 未取得の場合は先に再取得を試みる
      if (!this.notePath) {
        console.warn('[TextInserter]: notePath empty, retrying getCurrentFilePath...');
        await new Promise<void>(r => setTimeout(r, 600));
        const fp2 = await withTimeout(
          PluginCommAPI.getCurrentFilePath() as Promise<any>,
          SDK_TIMEOUT_MS, 'getCurrentFilePath(retry)',
        );
        if (fp2?.success && fp2.result) this.notePath = fp2.result;
      }

      let psRes = await withTimeout(
        PluginFileAPI.getPageSize(this.notePath, this.currentPage) as Promise<any>,
        SDK_TIMEOUT_MS, 'getPageSize',
      );
      // getPageSize が失敗した場合、一度だけ内部リトライ（plugin view の初期化待ち）
      if (!psRes?.success || !psRes.result?.width) {
        console.warn('[TextInserter]: getPageSize failed, retrying in 800ms...');
        await new Promise<void>(r => setTimeout(r, 800));
        psRes = await withTimeout(
          PluginFileAPI.getPageSize(this.notePath, this.currentPage) as Promise<any>,
          SDK_TIMEOUT_MS, 'getPageSize(retry)',
        );
      }
      if (psRes?.success && psRes.result?.width) {
        this.pageSize = { width: psRes.result.width, height: psRes.result.height };
        console.log('[TextInserter]: pageSize=', this.pageSize,
          'topMargin=', this._topMargin());
      } else {
        console.error('[TextInserter]: failed to get pageSize after retry');
        this.activeMode = null;
        return false;
      }
    } catch (e) {
      console.error('[TextInserter]: failed to get page info', e);
      this.activeMode = null;
      return false;
    }

    // ── 扫描当前页已有文本框（碰撞检测初始化）──
    await this._refreshOccupiedRanges();

    // ── 记录初始总页数，用于后续检测外部加页/删页 ──
    try {
      const tpRes = await withTimeout(
        PluginFileAPI.getNoteTotalPageNum(this.notePath) as Promise<any>,
        SDK_TIMEOUT_MS, 'getNoteTotalPageNum',
      );
      if (tpRes?.success && typeof tpRes.result === 'number') {
        this._expectedTotalPages = tpRes.result;
        console.log('[TextInserter]: initial totalPages=', this._expectedTotalPages);
      }
    } catch (e) {
      console.warn('[TextInserter]: getNoteTotalPageNum failed (non-fatal):', e);
    }

    this.timerRef = 1 as any;
    console.log('[TextInserter]: started, mode=', mode, 'page=', this.currentPage, 'notePath=', this.notePath);
    this._scheduleNext(mode);

    // ── 启动 Native Handler 页面检测（替代 JS setInterval）──
    // Android Handler.postDelayed 不受 closePluginView() 冻结影响，
    // 跨页等待期间仍能触发 _checkPageAndResume。
    this.pageTickSub = NativePageCheckerBridge.onTick(() => this._checkPageAndResume());
    NativePageCheckerBridge.startPolling(PAGE_CHECK_MS);
    console.log('[TextInserter]: native page checker started (interval=', PAGE_CHECK_MS, 'ms)');
    return true;
  }

  stop(clearActive = false) {
    if (this.timerRef) {
      clearTimeout(this.timerRef as any);
      this.timerRef = null;
    }
    // 停止 Native Handler 轮询并取消订阅
    if (this.pageTickSub) {
      this.pageTickSub.remove();
      this.pageTickSub = null;
      NativePageCheckerBridge.stopPolling();
    }
    this._isPageWait = false;
    if (clearActive) {
      this.activeMode = null;
      this._paused = false;
      this._unregisterPenUp();
    }
  }

  destroy() {
    this.stop(true);
  }

  // ── pen-up 感知 ───────────────────────────────────────────────────────────

  private _registerPenUp() {
    this._unregisterPenUp();
    try {
      this.penUpSub = PluginManager.registerEventListener('event_pen_up', 1, {
        onMsg: (_elements: any) => {
          this.lastPenUpAt = Date.now();
          if (Array.isArray(_elements)) {
            for (const el of _elements) {
              try { el.recycle?.(); } catch (_) {}
            }
          }
        },
      });
      console.log('[TextInserter]: pen-up listener registered');
    } catch (e) {
      console.warn('[TextInserter]: pen-up listener registration failed:', e);
    }
  }

  private _unregisterPenUp() {
    if (this.penUpSub) {
      try { this.penUpSub.remove(); } catch (_) {}
      this.penUpSub = null;
    }
  }

  private _isPenIdle(): boolean {
    if (this.lastPenUpAt === 0) return true;
    return (Date.now() - this.lastPenUpAt) >= PEN_SAFE_GAP_MS;
  }

  // ── 已有文本框碰撞检测 ─────────────────────────────────────────────────────

  /**
   * 扫描目标页的所有元素，提取文本框 (type 500/501/502) 的 textRect 坐标。
   * 结果缓存在 _occupiedRanges 中，换页或首次调用时刷新。
   */
  private async _refreshOccupiedRanges(): Promise<void> {
    // 如果 targetPage 没变且已经扫描过，跳过
    if (this._occupiedPage === this.targetPage) return;

    this._occupiedRanges = [];
    this._occupiedPage = this.targetPage;

    try {
      const res = await withTimeout(
        PluginFileAPI.getElements(this.targetPage, this.notePath) as Promise<any>,
        SDK_TIMEOUT_MS, 'getElements(scan)',
      );
      if (res?.success && Array.isArray(res.result)) {
        for (const el of res.result) {
          try {
            const elType = el.type;
            // 只关注文本框类型 500/501/502
            if (typeof elType === 'number' && elType >= 500 && elType <= 502) {
              const rect = el.textBox?.textRect;
              if (rect && typeof rect.top === 'number' && typeof rect.bottom === 'number') {
                this._occupiedRanges.push({ top: rect.top, bottom: rect.bottom });
              }
            }
          } finally {
            // finally 保证无论属性读取是否抛出，native 元素都被回收，防止 OOM
            try { el.recycle?.(); } catch (_) {}
          }
        }
        // 按 top 排序，方便后续顺序扫描
        this._occupiedRanges.sort((a, b) => a.top - b.top);
        console.log('[TextInserter]: scanned page', this.targetPage,
          'found', this._occupiedRanges.length, 'existing textboxes');
        FileLogger.logEvent('ScanTextBoxes',
          `page=${this.targetPage} count=${this._occupiedRanges.length}`);
      }
    } catch (e) {
      console.warn('[TextInserter]: _refreshOccupiedRanges failed:', e);
    }
  }

  /**
   * 检查 [candidateTop, candidateTop+boxH] 是否与已有文本框重叠。
   * 如果重叠，返回应跳到的新 top（重叠文本框的 bottom + gap）。
   * 如果不重叠，返回 candidateTop 不变。
   */
  private _skipOccupiedArea(candidateTop: number, boxH: number, gap: number): number {
    let top = candidateTop;
    // 可能连续跳过多个文本框，用 while 循环
    let iterations = 0;
    while (iterations < 50) { // 安全上限防止无限循环
      iterations++;
      let collision = false;
      for (const range of this._occupiedRanges) {
        // 两个区间 [top, top+boxH] 与 [range.top, range.bottom] 是否重叠
        if (top < range.bottom && (top + boxH) > range.top) {
          // 重叠：跳到这个文本框下方
          const newTop = range.bottom + gap;
          console.log('[TextInserter]: collision at top=', top,
            'with existing [', range.top, ',', range.bottom, '] → skip to', newTop);
          FileLogger.logEvent('CollisionSkip',
            `top=${top} boxH=${boxH} existing=[${range.top},${range.bottom}] newTop=${newTop}`);
          top = newTop;
          collision = true;
          break; // 重新检查所有 ranges，因为新位置可能与下一个 box 重叠
        }
      }
      if (!collision) break;
    }
    return top;
  }

  /**
   * 插入成功后，把新文本框的坐标也加入 _occupiedRanges 缓存，
   * 这样后续插入不需要重新全量扫描就能感知到刚插入的文本框。
   */
  private _addToOccupied(top: number, bottom: number): void {
    if (this._occupiedPage === this.targetPage) {
      this._occupiedRanges.push({ top, bottom });
      this._occupiedRanges.sort((a, b) => a.top - b.top);
    }
  }

  // ── 插入后读回实际坐标 ─────────────────────────────────────────────────────

  /**
   * 插入文本框后，尝试读取页面最后一个元素的 textRect.bottom，
   * 用实际渲染高度替代估算值，消除间距误差。
   */
  private async _readBackActualBottom(): Promise<number | null> {
    try {
      const res = await withTimeout(
        (PluginFileAPI.getLastElement as any)(this.targetPage, this.notePath) as Promise<any>,
        SDK_TIMEOUT_MS, 'getLastElement',
      );
      if (res?.success && res.result) {
        const el = res.result;
        // 只信任明确的文本框类型 (type 500/501/502)，避免笔迹元素或过渡态元素干扰坐标
        // 注意：不再信任 type===undefined 的元素——reloadFile 后 getLastElement 可能返回旧页过渡态元素
        const elType = el.type;
        const isTextBox = typeof elType === 'number' && elType >= 500 && elType <= 502;
        const actualBottom = el.textBox?.textRect?.bottom;
        try { el.recycle?.(); } catch (_) {}
        if (isTextBox && typeof actualBottom === 'number' && actualBottom > 0) {
          return actualBottom;
        }
      }
    } catch (e) {
      console.warn('[TextInserter]: readback failed:', e);
    }
    return null;
  }

  // ── 内部逻辑 ──────────────────────────────────────────────────────────────

  private async _insertParagraph(mode: InsertMode): Promise<'continue' | 'pause' | 'done'> {
    const cfg = MODE_CONFIG[mode];
    if (!cfg || !this.pageSize) return 'done';

    // ── 暂停守卫：队列保留，不消费 ──
    if (this._paused) {
      return 'continue';
    }

    // ── 笔活动守卫 ──
    if (!this._isPenIdle()) {
      return 'continue';
    }

    // ── 笔记上下文校验（在消费文本前，零轮询开销）──
    // 每次插入前检测：笔记是否切换、总页数是否外部变更
    const contextOk = await this._checkNoteContext();
    if (!contextOk) return 'done'; // _checkNoteContext 内部已调用 stop + onNoteChanged

    let newText = this.textQueue.shift();
    const isFromQueue = !!newText;

    if (!newText) {
      return 'continue';
    }

    const itemSource = newText.source;
    let text = newText.text;
    console.log('[TextInserter]: dequeued text len=', text.length, 'source=', itemSource, 'preview=', text.slice(0, 30));

    // 文本预处理
    const rawLines = text.split('\n');
    const rawLineCount = rawLines.length;
    const emptyLineCount = rawLines.filter(l => l.trim().length === 0).length;
    text = text.replace(/^(\d+)\./gm, '$1\u200B.');
    text = text.replace(/\*/g, '');
    text = text.split('\n').filter(line => line.trim().length > 0).join('\n');
    const cleanedLineCount = text.split('\n').length;
    FileLogger.logEvent('TextPreprocess',
      `rawLines=${rawLineCount} emptyLines=${emptyLineCount} cleanedLines=${cleanedLineCount} textLen=${text.length}`);

    // 预处理后文本为空（全部是空行）：直接跳过，避免 boxH=0 → bottom=top 导致 native 崩溃
    if (text.trim().length === 0) {
      console.log('[TextInserter]: text empty after preprocessing, skipping');
      FileLogger.logEvent('TextSkipEmpty', `source=${itemSource}`);
      this.onAck?.('', false, 'empty after preprocessing');
      return 'continue';
    }

    // activeMode 活跃检查：stop() 可能在上方 async 操作期间被调用
    if (!this.activeMode || !this.pageSize) {
      if (isFromQueue) this.textQueue.unshift({ text, source: itemSource });
      return 'done';
    }

    const ps = this.pageSize;
    const tm = this._topMargin();
    const left     = Math.floor(ps.width * PAGE_MARGIN_LEFT);
    const right    = ps.width - Math.floor(ps.width * PAGE_MARGIN_RIGHT);
    const maxH     = Math.floor(ps.height * cfg.threshold);
    const boxWidth = right - left;
    // 按 CJK 字符比例加权计算字符宽度因子，混合文本时更准确
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const cjkRatio = text.length > 0 ? cjkCount / text.length : 0;
    const charWidthFactor = CHAR_WIDTH_FACTOR_CJK * cjkRatio + CHAR_WIDTH_FACTOR_LATIN * (1 - cjkRatio);
    const charsPerLine = Math.max(1, Math.floor(boxWidth / (FONT_SIZE * charWidthFactor)));

    const segments = text.split('\n');
    const lines = segments.reduce((acc, seg, idx) => {
      if (seg.trim().length === 0) return acc;
      const segLines = Math.max(1, Math.ceil(seg.length / charsPerLine));
      const newlineGap = cfg.newlineGapLines > 0 &&
        (idx < segments.length - 1 && segments[idx + 1].trim().length > 0)
        ? cfg.newlineGapLines : 0;
      return acc + segLines + newlineGap;
    }, 0);
    const boxH = Math.ceil(lines * FONT_SIZE * cfg.lineHeightRatio);

    // ── 碰撞检测：如果目标页变了，刷新占用缓存 ──
    if (this._occupiedPage !== this.targetPage) {
      await this._refreshOccupiedRanges();
    }

    let top = this.pageNextTop.get(this.targetPage) ?? tm;

    // ── 跳过已有文本框占用的区域 ──
    top = this._skipOccupiedArea(top, boxH, Math.max(cfg.boxGap, 10));

    const bottom = Math.min(top + boxH, ps.height - tm);
    const remainH = maxH - top;
    FileLogger.logEvent('BoxCalc',
      `mode=${mode} segments=${segments.length} lines=${lines} boxH=${boxH} top=${top} maxH=${maxH} remainH=${remainH} gap=${cfg.boxGap} fits=${boxH <= remainH} topMargin=${tm}`);

    // 当前页已满：游标超过设定阈值 maxH，或者连当前文本框都会冲出物理可视下边界（且当前不处于页面顶端）
    if (top >= maxH || (top > tm + 80 && top + boxH > ps.height - tm)) {
      if (isFromQueue) {
        this.textQueue.unshift({ text, source: itemSource });
      }

      // 收集候选模板名：优先从 API 获取，然后用 style_white fallback
      const candidateTemplates: string[] = [];
      try {
        const templates = await withTimeout(
          PluginCommAPI.getNoteSystemTemplates() as Promise<any>,
          SDK_TIMEOUT_MS, 'getNoteSystemTemplates',
        );
        // getNoteSystemTemplates() 直接返回数组 [{name, vUri, hUri}, ...]
        if (Array.isArray(templates) && templates.length > 0) {
          for (const t of templates) {
            if (t?.name) candidateTemplates.push(t.name);
          }
        }
        console.log('[TextInserter]: parsed templates count=', candidateTemplates.length);
      } catch (_) {}
      // style_white 是空白模板的正确名称（不是 style_blank）
      if (!candidateTemplates.includes('style_white')) {
        candidateTemplates.push('style_white');
      }

      const newPageIndex = this.targetPage + 1;
      console.log('[TextInserter]: page full, creating page', newPageIndex, 'candidates=', candidateTemplates);

      let pageCreated = false;
      for (const templateName of candidateTemplates) {
        try {
          const npRes = await withTimeout(
            PluginFileAPI.insertNotePage({
              notePath: this.notePath,
              page: newPageIndex,
              template: templateName,
            } as any) as Promise<any>,
            SDK_TIMEOUT_MS, 'insertNotePage',
          );

          if (npRes?.success) {
            console.log('[TextInserter]: page created with template=', templateName);
            this.targetPage = newPageIndex;
            this.pageNextTop.set(newPageIndex, tm);
            // 新页面：重置占用缓存
            this._occupiedRanges = [];
            this._occupiedPage = newPageIndex;
            // 更新预期总页数（我们自己加的页，不应被误判为外部变更）
            if (this._expectedTotalPages > 0) this._expectedTotalPages++;
            pageCreated = true;

            // 刷新笔记 UI，让新页面出现，用户才能翻过去
            try {
              await withTimeout(
                PluginCommAPI.reloadFile() as Promise<any>,
                SDK_TIMEOUT_MS, 'reloadFile',
              );
              console.log('[TextInserter]: reloadFile after insertNotePage OK');
            } catch (e) {
              console.warn('[TextInserter]: reloadFile failed (non-fatal):', e);
            }

            // ── 翻页后通知位置变化（isPageChange=true）──
            // 中转站来源的气泡在此时更新 Y 坐标
            this.onPositionChanged?.(newPageIndex, tm, itemSource, true);

            break;
          } else {
            console.warn('[TextInserter]: insertNotePage failed with template=', templateName, ':', npRes?.error?.message);
          }
        } catch (e) {
          console.warn('[TextInserter]: insertNotePage exception with template=', templateName, ':', e);
        }
      }

      if (!pageCreated) {
        console.error('[TextInserter]: all template candidates failed, pausing (not stopping)');
        FileLogger.logEvent('InsertPageAllFailed', `page=${newPageIndex} candidates=${candidateTemplates.join(',')}`);
        // 即使创建失败，也把 targetPage 指向新页，防止 pause 后立刻 flush 导致死循环
        this.targetPage = newPageIndex;
      }
      return 'pause';
    }

    // ── 再次确认插入器仍处于活跃状态（stop() 可能在翻页相关 async 操作期间被调用）──
    if (!this.activeMode || !this.pageSize) {
      if (isFromQueue) this.textQueue.unshift({ text, source: itemSource });
      return 'done';
    }

    // ── 页面锚定校验：insertText 只能插入到用户当前正在查看的页面 ──
    // 如果用户的可见页码 !== targetPage，说明用户不在目标页上，
    // 此时 insertText 会把内容写到错误的页面。必须暂停等待。
    try {
      const pgCheck = await withTimeout(
        PluginCommAPI.getCurrentPageNum() as Promise<any>,
        SDK_TIMEOUT_MS, 'getCurrentPageNum(preInsert)',
      );
      if (pgCheck?.success && typeof pgCheck.result === 'number') {
        this.currentPage = pgCheck.result;
        if (this.currentPage !== this.targetPage) {
          console.warn('[TextInserter]: page mismatch! current=', this.currentPage,
            'target=', this.targetPage, ', pausing to prevent wrong-page insertion');
          FileLogger.logEvent('PageMismatchPause',
            `current=${this.currentPage} target=${this.targetPage} textLen=${text.length}`);
          // 把文本塞回队列头部
          if (isFromQueue) this.textQueue.unshift({ text, source: itemSource });
          return 'pause';
        }
      }
    } catch (e) {
      console.warn('[TextInserter]: pre-insert page check failed (proceeding cautiously):', e);
    }

    // ── 插入文本框（带超时保护）──
    // 如果行数较多（>=6 行），为底部追加 7px 冗余，防止 g, y 等带尾巴的字母被原生文本框截断
    const renderBottom = Math.min(ps.height, bottom + (lines >= 6 ? 7 : 0));
    try {
      const res = await withTimeout(
        PluginNoteAPI.insertText({
          textContentFull: text,
          textRect: { left, top, right, bottom: renderBottom },
          fontSize: FONT_SIZE,
          textAlign: 0,
          textBold: 0,
          textItalics: 0,
          textFrameWidthType: 0,
          textFrameStyle: 0,
          textEditable: 1,
        }) as Promise<any>,
        SDK_TIMEOUT_MS, 'insertText',
      );

      if (res?.success) {
        FileLogger.logTextInserted(this.targetPage, { left, top, right, bottom }, text.length);

        // ── 页面标注日志：明确记录本条文本插入到了哪个页面 ──
        FileLogger.logEvent('PageAnnotation',
          `text inserted to page=${this.targetPage} currentPage=${this.currentPage} textLen=${text.length} preview=${text.slice(0, 30).replace(/\n/g, '↵')}`);

        // ── 读回实际渲染坐标，消除估算误差 ──
        const actualBottom = await this._readBackActualBottom();
        // 只在 actualBottom 合理时采用：必须 > top 且不超过 estimatedBottom 的 1.5 倍
        // 防止 getLastElement 跨页返回上一页元素（bottom 会接近页面高度 ~2480）
        const maxReasonableBottom = bottom * 1.5;
        const effectiveBottom = (actualBottom !== null
          && actualBottom > top
          && actualBottom <= maxReasonableBottom)
          ? actualBottom
          : bottom;
        this.pageNextTop.set(this.targetPage, effectiveBottom + cfg.boxGap);

        // 把刚插入的文本框加入占用缓存
        this._addToOccupied(top, effectiveBottom);

        FileLogger.logEvent('InsertPos',
          `top=${top} estimatedBottom=${bottom} actualBottom=${actualBottom} effectiveBottom=${effectiveBottom} nextTop=${effectiveBottom + cfg.boxGap} source=${itemSource} preview=${text.slice(0, 40).replace(/\n/g, '↵')}`);

        this.onAck?.(text, true, null);
        this.onPositionChanged?.(this.targetPage, effectiveBottom + cfg.boxGap, itemSource, false);
        return 'continue';
      } else {
        const errMsg = res?.error?.message || 'insertText failed';
        console.error('[TextInserter]: insertText failed (skipping):', errMsg);
        FileLogger.logEvent('TextInsertFail', `page=${this.targetPage} err=${errMsg} textLen=${text.length}`);
        this.onAck?.(text, false, errMsg);
        return 'continue';
      }
    } catch (e) {
      const errMsg = String(e);
      console.error('[TextInserter]: insertText exception:', errMsg);
      FileLogger.logEvent('TextInsertException', `page=${this.targetPage} err=${errMsg}`);
      this.onAck?.(text, false, errMsg);
      return 'continue';
    }
  }

  private _deferNextTick(mode: InsertMode, delay: number) {
    this._scheduleNextDeferred = mode;
    clearTimeout(this._deferredTimerRef);
    // 优先使用 JS 定时器。若 JS 被后台冻结，这将被 NativePageCheckerBridge 兜底执行保证不卡死。
    this._deferredTimerRef = setTimeout(() => {
      if (this._scheduleNextDeferred === mode && !this.inserting) {
        this._scheduleNextDeferred = null;
        this._scheduleNext(mode);
      }
    }, delay);
  }

  private _scheduleNext(mode: InsertMode) {
    if (this._paused || this.timerRef === null || this.textQueue.length === 0) {
      this.timerRef = null;
      // Do NOT clear activeMode here. Let it wait idly for new enqueue() calls or explicit stop().
      console.log(`[TextInserter]: idle (paused=${this._paused}, queue=${this.textQueue.length})`);
      return;
    }

    if (this.inserting) return;

    if (!this._isPenIdle()) {
      // 笔未空闲：延迟后再试，防死循环
      this._deferNextTick(mode, PEN_SAFE_GAP_MS);
      return;
    }

    this.inserting = true;
    this.lastScheduleAt = Date.now();

    this._insertParagraph(mode).then(result => {
      this.inserting = false;

      if (result === 'continue' && this.timerRef !== null) {
        if (this.textQueue.length > 0) {
          // 队列还有内容，短延迟继续，利用双保险避免后台 timer 冻结
          this.timerRef = 1 as any;
          this._deferNextTick(mode, 50);
        } else {
          this._deferNextTick(mode, INTERVAL_MS);
        }
      } else if (result === 'pause') {
        this.timerRef = null;
        this._isPageWait = true;
        this._pausedSince = Date.now();
        console.log('[TextInserter]: page-wait, waiting for user to navigate to page', this.targetPage);
        this.onPageWaitChanged?.(true, this.targetPage);
      } else {
        this.timerRef = null;
        this.activeMode = null;
        console.log('[TextInserter]: stopped');
      }
    }).catch(e => {
      this.inserting = false;
      console.error('[TextInserter]: _scheduleNext unexpected error:', e);
      FileLogger.logEvent('ScheduleError', String(e));
      if (this.timerRef !== null) {
        this.timerRef = 1 as any;
        this._deferNextTick(mode, INTERVAL_MS * 5);
      }
    });
  }

  private async _checkPageAndResume() {
    // 处理挂起的 scheduleNext，充当后台 timer 冻结时的兜底驱动
    if (this._scheduleNextDeferred && !this.inserting) {
      const mode = this._scheduleNextDeferred;
      this._scheduleNextDeferred = null;
      this._scheduleNext(mode);
      return;
    }

    if (this.inserting) return;

    try {
      const pgRes = await withTimeout(
        PluginCommAPI.getCurrentPageNum() as Promise<any>,
        SDK_TIMEOUT_MS, 'getCurrentPageNum(check)',
      );
      if (!pgRes?.success || typeof pgRes.result !== 'number') return;
      const newPage = pgRes.result;

      // ── page-wait 状态：等待用户翻到 targetPage ──
      if (this._isPageWait && this.activeMode !== null && !this._paused && newPage === this.targetPage) {
        if (this._resumeWaitStart === 0) {
          this._resumeWaitStart = Date.now();
          console.log('[TextInserter]: user navigated to page', newPage, ', waiting 1.5s delay...');
          this.currentPage = newPage;
          return;
        } else if (Date.now() - this._resumeWaitStart < 1500) {
          return; // 等待UI稳定
        }

        console.log('[TextInserter]: user navigated to page', newPage, ', delay over, flushing queue');
        this._resumeWaitStart = 0;
        this._isPageWait = false;
        this.onPageWaitChanged?.(false, this.targetPage);
        
        this.currentPage = newPage;
        this.timerRef = 1 as any;
        const mode = this.activeMode;

        // 翻页恢复时强制重新扫描：reloadFile 后 SDK 内部页面状态可能已变化，
        // 不能依赖创建时留下的空缓存（_occupiedPage === targetPage 不足以保证数据仍准确）
        this._occupiedPage = -1;
        await this._refreshOccupiedRanges();

        // 调用 _scheduleNext 即可，它现在受到 _deferNextTick 双保险保护
        this._scheduleNext(mode);
        return;
      }

      // ── 非 page-wait 的正常空闲状态：用户已翻到目标页 → 唤醒 ──
      if (!this._isPageWait && this.timerRef === null && this.activeMode !== null && !this._paused
          && this.textQueue.length > 0 && newPage === this.targetPage) {
        console.log('[TextInserter]: idle wake-up on page', newPage);
        this.currentPage = newPage;
        this.timerRef = 1 as any;
        this._scheduleNext(this.activeMode);
        return;
      }

      if (newPage !== this.currentPage) {
        this.currentPage = newPage;
      }

      // ── page-wait 兜底 ──
      // 仅在 page-wait 状态下生效，且必须满足 currentPage === targetPage 才恢复。
      // 如果 8 秒后 currentPage 仍 !== targetPage：
      //   - 记录日志继续等待（不强制恢复，防止插到错误页面）
      //   - 但延长到 30 秒后视为用户不会翻页，自动将 targetPage 调整为 currentPage
      //     并把 nextTop 设为新页面的顶部（通过 refreshOccupied 获取已有内容位置）
      if (this._isPageWait
          && this.activeMode !== null
          && !this._paused
          && this.textQueue.length > 0
          && this._pausedSince > 0) {
        const elapsed = Date.now() - this._pausedSince;

        if (newPage === this.targetPage && elapsed > 2000) {
          // 用户在 _resumeWaitStart 逻辑之外到达了目标页（可能是快速翻页）
          console.log('[TextInserter]: page-wait fallback: user on target page', newPage);
          this._pausedSince = 0;
          this._resumeWaitStart = 0;
          this._isPageWait = false;
          this.onPageWaitChanged?.(false, this.targetPage);
          this.currentPage = newPage;
          this.timerRef = 1 as any;
          const mode = this.activeMode;
          this._occupiedPage = -1;
          await this._refreshOccupiedRanges();
          this._scheduleNext(mode);
        } else if (elapsed > 30000 && newPage !== this.targetPage) {
          // 30 秒超时：用户不打算翻页，将 targetPage 调整为当前页继续插入
          console.warn('[TextInserter]: page-wait timeout 30s, relocating target from',
            this.targetPage, 'to current page', newPage);
          FileLogger.logEvent('PageWaitTimeout',
            `oldTarget=${this.targetPage} newTarget=${newPage} queueLen=${this.textQueue.length}`);
          this._pausedSince = 0;
          this._resumeWaitStart = 0;
          this._isPageWait = false;
          this.onPageWaitChanged?.(false, newPage);
          this.targetPage = newPage;
          this.currentPage = newPage;
          this.timerRef = 1 as any;
          const mode = this.activeMode;
          this._occupiedPage = -1;
          await this._refreshOccupiedRanges();
          this._scheduleNext(mode);
        } else if (elapsed > 8000 && elapsed % 8000 < PAGE_CHECK_MS * 2) {
          // 每 8 秒提醒一次用户还在等待
          console.log('[TextInserter]: still waiting for page flip, current=', newPage,
            'target=', this.targetPage, 'elapsed=', elapsed, 'ms');
        }
      }
    } catch (e) {
      console.warn('[TextInserter]: _checkPageAndResume error:', e);
    }
  }

  /**
   * 笔记上下文校验：检测笔记路径变更和总页数外部变更。
   * 在每次 _insertParagraph 消费文本前调用（零轮询开销，仅在实际写入前检查）。
   * @returns true = 上下文正常，可继续插入；false = 上下文已变，已自动 stop
   */
  private async _checkNoteContext(): Promise<boolean> {
    try {
      // ── 检测笔记路径变更（用户切换到了另一个笔记） ──
      const fpRes = await withTimeout(
        PluginCommAPI.getCurrentFilePath() as Promise<any>,
        SDK_TIMEOUT_MS, 'getCurrentFilePath(check)',
      );
      if (fpRes?.success && fpRes.result && this.notePath && fpRes.result !== this.notePath) {
        const oldPath = this.notePath;
        const newPath = fpRes.result;
        console.error('[TextInserter]: NOTE SWITCHED! old=', oldPath, 'new=', newPath);
        FileLogger.logEvent('NoteSwitched', `old=${oldPath} new=${newPath}`);
        this.stop(true);
        this.onNoteChanged?.('note_switched', `${oldPath} → ${newPath}`);
        return false;
      }

      // ── 检测总页数外部变更（用户手动加页或删页） ──
      if (this._expectedTotalPages > 0 && this.notePath) {
        const tpRes = await withTimeout(
          PluginFileAPI.getNoteTotalPageNum(this.notePath) as Promise<any>,
          SDK_TIMEOUT_MS, 'getNoteTotalPageNum(check)',
        );
        if (tpRes?.success && typeof tpRes.result === 'number') {
          const actual = tpRes.result;
          if (actual !== this._expectedTotalPages) {
            const diff = actual - this._expectedTotalPages;
            console.warn('[TextInserter]: totalPages changed externally: expected=',
              this._expectedTotalPages, 'actual=', actual, 'diff=', diff);
            FileLogger.logEvent('PagesChanged',
              `expected=${this._expectedTotalPages} actual=${actual} diff=${diff} targetPage=${this.targetPage}`);
            this._expectedTotalPages = actual;
            this.stop(true);
            this.onNoteChanged?.('pages_changed',
              `totalPages ${actual - diff} → ${actual}, targetPage was ${this.targetPage}`);
            return false;
          }
        }
      }
    } catch (e) {
      console.warn('[TextInserter]: _checkNoteContext error:', e);
    }
    return true;
  }
}
